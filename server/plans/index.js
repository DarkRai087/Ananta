// Trade plans: for every strategy on one symbol, what it is doing right now and the exact
// prices that would make it BUY or SELL next.
//
//  • During the session ("live"): today's COMPLETED bars are replayed through the same engine
//    as the backtest (live mode), so an open position or a fresh signal is reported exactly as
//    the backtest would have taken it. Strategies with no position describe their next entry
//    via their plan(ctx) hook (strategies/planKit.js).
//  • Outside the session ("next"): plans for the next session, from the last session's levels.
//
// Stops and targets go through backtest/engine.js bracket(), so stopType / targetR / strategy
// targets work the same as in the backtest. Quantity uses the backtest's sizing: the most
// shares whose loss at the stop, charges and stop slippage included, is within your risk.
import { LAB } from "../config/lab.js";
import { inr } from "../decision/util.js";
import { STRATEGIES, resolveParams } from "../strategies/index.js";
import { loadSessions, settingsWithDefaults } from "../backtest/run.js";
import { markDuplicateSignals } from "./dedupe.js";
import { markRegimeConflicts, cprRegime, gapLabel, markGapRouting, markTrendFamily } from "./arbiter.js";
import { dailyAtr } from "../lab/indicators.js";
import { runSession, bracket, targetForProfit } from "../backtest/engine.js";
import { tradeCosts, sizeForRisk } from "../backtest/costs.js";
import { accountSettings } from "../backtest/account.js";
import { referenceIndex, indicesOf, indexName } from "../data/indexMembers.js";
import { attachIndex, indexState, blockReason } from "../market/indexLink.js";
import { attachMarketFor } from "../market/marketData.js";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { dailyBar } from "../lab/sessions.js";
import { istNow, istDate, istHHMM, hhmmToMin, minToHHMM, OPEN_MIN, CLOSE_MIN } from "../lab/time.js";
import { sessionsBack } from "../data/intraday.js";
import { isTradingDay } from "../data/holidays.js";

// Order of importance in the list.
const STATUS_ORDER = ["exit", "signal", "in_trade", "armed", "watching", "waiting", "off", "done"];

const isLong = (side) => side === "long";

function nextTradingDate(fromDate, includeSelf) {
  let t = Date.parse(`${fromDate}T00:00:00Z`);
  if (!includeSelf) t += 86400_000;
  for (let k = 0; k < 15; k++, t += 86400_000) {
    const d = new Date(t).toISOString().slice(0, 10);
    if (isTradingDay(d)) return d;
  }
  return null;
}

function tradeView(t) {
  return {
    side: t.side,
    entryTime: t.entryTime,
    exitTime: t.exitTime,
    entry: t.entry,
    exit: t.exit,
    stop: t.initialStop,
    target: t.target,
    qty: t.qty,
    net: t.net,
    rNet: t.rNet,
    outcome: t.outcome,
    reason: t.reason,
    signal: t.signal,
  };
}

// Size for one entry/stop, using the backtest's money rules (backtest/costs.js sizeForRisk).
function sizing(side, entry, stop, st) {
  if (stop == null) return { qty: null, value: null, plannedLoss: null };
  const s = sizeForRisk(side, entry, stop, { riskRs: st.riskPerTrade, maxValue: st.maxPositionValue, slippagePct: st.slippagePct });
  return { qty: s.qty, value: s.qty * entry, plannedLoss: s.lossRs };
}

// Net ₹ result of exiting `qty` at `exit`, after all charges ({ net, charges }). slipPct
// worsens the fill (stops are market orders; targets are limit orders and fill at the price).
function exitAt(side, entry, exit, qty, slipPct = 0) {
  if (!(qty > 0) || exit == null) return { net: null, charges: null };
  const long = side === "long";
  const fill = long ? exit * (1 - slipPct / 100) : exit * (1 + slipPct / 100);
  const gross = (long ? fill - entry : entry - fill) * qty;
  const charges = (long ? tradeCosts(entry * qty, fill * qty) : tradeCosts(fill * qty, entry * qty)).total;
  return { net: gross - charges, charges };
}

function setupView(x, { params, st, atr, atrApprox, lastPrice, lastClose }) {
  const long = isLong(x.side);
  const entry = x.atMarket ? lastPrice : x.trigger;
  const b = entry != null && Number.isFinite(entry) ? bracket(x.side, entry, { stop: x.stop, target: x.target }, params, atr) : null;
  const risk = b?.riskPerShare ?? null;
  const size = sizing(x.side, entry, b?.stop ?? null, st);
  // Your profit target replaces the strategy's target once the size is known.
  const target = b && st.profitTarget > 0 && size.qty > 0 ? targetForProfit(x.side, entry, size.qty, st.profitTarget) : (b?.target ?? null);
  const reward = target != null ? Math.abs(target - entry) : null;
  const beyond = lastClose != null && x.trigger != null && (long ? lastClose > x.trigger : lastClose < x.trigger);
  return {
    side: x.side,
    action: long ? "BUY" : "SELL",
    trigger: x.trigger,
    when: x.when,
    entry,
    stop: b?.stop ?? null,
    target,
    risk,
    reward,
    rr: risk && reward ? reward / risk : null,
    qty: size.qty,
    value: size.value,
    lossRs: size.plannedLoss != null ? -size.plannedLoss : null, // net ₹ if the stop is hit: charges + stop slippage included
    lossCharges: size.qty > 0 ? exitAt(x.side, entry, b.stop, size.qty, st.slippagePct).charges : null,
    profitRs: exitAt(x.side, entry, target, size.qty).net, // net ₹ if the target is hit, after charges
    profitCharges: exitAt(x.side, entry, target, size.qty).charges,
    distance: entry != null && lastPrice != null ? entry - lastPrice : null,
    distancePct: entry != null && lastPrice ? ((entry - lastPrice) / lastPrice) * 100 : null,
    approx: Boolean(x.approx || (params.stopType === "atr" && atrApprox)),
    cross: Boolean(x.cross),
    // A breakout level that price is already past: it needs to come back and cross again.
    extended: Boolean(x.cross && beyond),
    atMarket: Boolean(x.atMarket),
    invalid: !b ? "Stop would be on the wrong side of the entry — the backtest skips this." : size.qty === 0 ? "Position too small: one share loses more than your risk per trade (charges included), or costs more than your max position." : null,
    targetNote: b && target == null ? (params.exitOnCross || params.exitOnFlip ? "No fixed target: exit on the opposite signal or 15:15" : "No fixed target: exit at 15:15") : null,
  };
}

function biasOf(status, setups, position) {
  if (position) return isLong(position.side) ? "bullish" : "bearish";
  const sides = new Set(setups.filter((s) => !s.invalid).map((s) => s.side));
  if (sides.size === 2) return "two-way";
  if (sides.has("long")) return "bullish";
  if (sides.has("short")) return "bearish";
  return "neutral";
}

function planStrategy(def, env) {
  const { session, sd, live, lastPrice, st, intervalMin, symbol, lastSessionTrades, indexNow } = env;
  const params = resolveParams(def);
  const n = sd.candles.length;
  const lastClose = n ? sd.candles[n - 1].close : (session.prev?.close ?? null);
  const out = {
    id: def.id,
    name: def.name,
    description: def.description,
    entryWindow: `${params.entryStart}–${minToHHMM(Math.min(hhmmToMin(params.entryEnd), hhmmToMin(st.entryCutoff)))}`,
    stopRule: params.stopType === "atr" ? `${params.atrMult}× ATR` : params.stopType === "percent" ? `${params.stopPct}%` : "structure",
    targetRule: st.profitTarget > 0 ? `your profit target (₹${inr(Math.round(st.profitTarget))} after costs)` : params.targetR > 0 ? `${params.targetR}R` : "strategy target / exit signal / 15:15",
    status: "off",
    note: "",
    setups: [],
    position: null,
    trades: live ? [] : lastSessionTrades[def.id] || [],
    bias: "neutral",
  };
  const atrLive = n ? sd.get("atr", params.atrPeriod)[n - 1] : null;
  const atrDaily = new BarContext(sd, params).ref.atrDaily;
  const atr = atrLive ?? (atrDaily ? atrDaily * 0.15 : null);
  const view = (x) => setupView(x, { params, st, atr, atrApprox: atrLive == null, lastPrice, lastClose });
  let taken = 0;

  if (live) {
    const r = runSession({ session, symbol, strategy: def, params, settings: st, intervalMin, sd, live: true });
    out.trades = r.trades.map(tradeView);
    taken = r.trades.length;
    if (r.open) {
      const p = r.open;
      const dir = isLong(p.side) ? 1 : -1;
      const pnlPts = (lastPrice - p.entry) * dir;
      // Money figures are net of all charges; R = the planned net loss at the initial stop.
      const pnlRs = exitAt(p.side, p.entry, lastPrice, p.qty).net;
      out.position = {
        ...p,
        lastPrice,
        pnlPts,
        pnlRs,
        pnlR: p.plannedLoss ? pnlRs / p.plannedLoss : null,
        lossRs: exitAt(p.side, p.entry, p.stop, p.qty, st.slippagePct).net,
        profitRs: exitAt(p.side, p.entry, p.target, p.qty).net,
      };
      out.status = r.pending?.type === "exit" ? "exit" : "in_trade";
      out.note =
        out.status === "exit"
          ? `Exit signal at the ${istHHMM(r.pending.signalTime)} close — ${isLong(p.side) ? "SELL" : "BUY back"} now at market.`
          : `${isLong(p.side) ? "Long" : "Short"} since ${istHHMM(p.entryTime)} (${p.reason}).`;
      out.bias = biasOf(out.status, [], out.position);
      return out;
    }
    if (r.pending?.type === "entry") {
      const sig = r.pending.sig;
      const s = view({ side: sig.side, trigger: lastPrice, when: `signal at the ${istHHMM(r.pending.signalTime)} close — enter now at market`, stop: sig.stop, target: sig.target, atMarket: true });
      out.setups = [s];
      out.status = s.invalid ? "off" : "signal";
      out.note = s.invalid ? `Signal fired (${sig.reason}) but price has already moved past its stop — skip it.` : sig.reason;
      out.bias = biasOf(out.status, out.setups, null);
      return out;
    }
    if (r.halted) {
      out.status = "done";
      out.note = `Daily loss limit (₹${st.maxDailyLoss}) hit — no more trades today.`;
      return out;
    }
  }

  const nextMin = n ? sd.minutes[n - 1] + intervalMin : OPEN_MIN;
  const winStart = hhmmToMin(params.entryStart);
  const winEnd = Math.min(hhmmToMin(params.entryEnd), hhmmToMin(st.entryCutoff));
  if (live && taken >= st.maxTradesPerDay) {
    out.status = "done";
    out.note = `Already took ${taken} trade${taken > 1 ? "s" : ""} today (max ${st.maxTradesPerDay}).`;
    return out;
  }
  if (live && nextMin >= winEnd) {
    out.status = "done";
    out.note = `Entry window closed at ${minToHHMM(winEnd)}.`;
    return out;
  }

  const ctx = new BarContext(sd, params);
  ctx.i = n - 1;
  ctx.tradesToday = taken;
  let plan;
  try {
    plan = def.plan ? def.plan(ctx) : { status: "off", note: "This strategy has no plan() yet.", setups: [] };
  } catch (err) {
    plan = { status: "off", note: `Plan error: ${err.message}`, setups: [] };
  }
  const filterOn = st.indexFilter && st.indexFilter !== "off";
  const setups = (plan.setups || [])
    .filter((x) => (isLong(x.side) ? params.allowLong : params.allowShort))
    .map(view)
    .map((x) => ({ ...x, blocked: filterOn ? blockReason(x.side, indexNow) : null }));
  // Nearest first.
  setups.sort((a, b) => Math.abs(a.distancePct ?? 1e9) - Math.abs(b.distancePct ?? 1e9));
  out.setups = setups;
  out.status = plan.status;
  out.note = plan.note || "";
  if (nextMin < winStart && setups.length) out.note = `${out.note}${out.note ? " " : ""}Entries from ${params.entryStart}.`;
  if (out.status === "watching" && setups.length && setups.every((s) => s.invalid)) out.status = "off";
  out.bias = biasOf(out.status, setups.filter((x) => !x.blocked), null);
  if (filterOn && setups.length && setups.every((x) => x.blocked || x.invalid)) out.note = `${out.note}${out.note ? " " : ""}Blocked by the index filter right now.`;
  return out;
}

/**
 * Plans for every strategy. Reads candles from SQLite only (sync first).
 * returns { symbol, interval, phase, date, basedOn, label, lastPrice, lastBarTime, settings, strategies }
 */
export function buildPlans({ symbol, interval = LAB.defaultInterval, account: accountInput = null, nowMs = Date.now() }) {
  const intervalMin = LAB.intervals[interval];
  if (!intervalMin) throw new Error(`Unknown interval ${interval}`);
  const { account, settings } = accountSettings(accountInput || {});
  const st = settingsWithDefaults(settings);
  const now = istNow(nowMs);
  const sessions = loadSessions(symbol, interval, { from: istDate(sessionsBack(LAB.historyDays + 5, now.t)) }).filter((s) => !s.special && s.date <= now.date);
  const todayFull = sessions.find((s) => s.date === now.date) || null;
  const indexChoice = settings.indexFilter || "off";
  const indexId = referenceIndex(symbol, indexChoice === "off" ? "sector" : indexChoice);
  const indexSessions = indexId ? loadSessions(indexId, interval, { from: istDate(sessionsBack(5, now.t)) }).filter((s) => !s.special && s.date <= now.date) : [];
  const live = Boolean(todayFull) && now.minute < CLOSE_MIN;

  let session;
  let lastPrice;
  let lastBarTime;
  let date;
  let label;
  const lastSessionTrades = {};
  if (live) {
    const done = todayFull.candles.filter((c) => c.time + intervalMin * 60 <= now.t);
    session = { ...todayFull, candles: done };
    const last = todayFull.candles[todayFull.candles.length - 1];
    lastPrice = last.close;
    lastBarTime = done.length ? done[done.length - 1].time : null;
    date = now.date;
    label = lastBarTime ? `Live — ${istHHMM(lastBarTime + intervalMin * 60)} bar closed` : "Live — first bar still forming";
  } else {
    const base = sessions[sessions.length - 1];
    if (!base) return { symbol, interval, phase: "none", label: "No cached data for this symbol yet", strategies: [] };
    const prev = dailyBar(base.date, base.candles);
    session = { date: "next", special: false, candles: [], prev, history: [...(base.history || []), prev].slice(-LAB.historyDays) };
    lastPrice = prev.close;
    lastBarTime = base.candles[base.candles.length - 1].time;
    const nowIsBeforeOpen = isTradingDay(now.date) && now.minute < OPEN_MIN;
    date = nextTradingDate(now.date, nowIsBeforeOpen && base.date < now.date);
    label = `Plan for the next session${date ? ` (${date})` : ""} — levels from ${base.date}`;
    // What each strategy did in that last session (complete, so a normal backtest run).
    const sdBase = new SessionData(base, intervalMin);
    for (const def of STRATEGIES) {
      const r = runSession({ session: base, symbol, strategy: def, params: resolveParams(def), settings: st, intervalMin, sd: sdBase });
      lastSessionTrades[def.id] = r.trades.map(tradeView);
    }
  }

  session.symbol = symbol; // let strategies read ctx.symbol for per-symbol config
  if (indexId) attachIndex([session], indexSessions, { indexId });
  attachMarketFor(symbol, interval, [session], { from: istDate(sessionsBack(5, now.t)) }); // NIFTY 50 + sector for ctx.market
  const indexNow = indexId ? indexState(indexSessions[indexSessions.length - 1], indexId) : null;
  const sd = new SessionData(session, intervalMin);
  const env = { session, sd, live, lastPrice, st, intervalMin, symbol, lastSessionTrades, indexNow };
  const strategies = STRATEGIES.map((def) => planStrategy(def, env));
  strategies.sort((a, b) => {
    const d = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (d) return d;
    const da = Math.min(...a.setups.map((s) => Math.abs(s.distancePct ?? 1e9)), 1e9);
    const db = Math.min(...b.setups.map((s) => Math.abs(s.distancePct ?? 1e9)), 1e9);
    return da - db;
  });
  markDuplicateSignals(strategies); // tag same-side/same-price setups across strategies as one signal
  // Regime arbiter: label the day by CPR width and stand down opposite signals the regime disfavours,
  // then route a GAP day to Gap and Go (suppress duplicate PDH/PDL gap routes and CPR fades against it).
  const regime = cprRegime(sd.pivots?.cprWidthPct, session.history || []);
  const { conflicts } = markRegimeConflicts(strategies, regime.tag);
  const gap = gapLabel(session.candles[0]?.open ?? null, session.prev?.close ?? null, dailyAtr(session.history || [], 14));
  conflicts.push(...markGapRouting(strategies, gap));
  markTrendFamily(strategies); // Supertrend + 9/21 EMA same-direction → one combined TREND signal

  return {
    symbol,
    interval,
    phase: live ? "live" : "next",
    date,
    basedOn: live ? now.date : sessions[sessions.length - 1].date,
    label,
    asOf: now.t,
    lastPrice,
    lastBarTime,
    account,
    index: { id: indexId, name: indexId ? indexName(indexId) : null, choice: indexChoice, member: indicesOf(symbol).map((id) => ({ id, name: indexName(id) })), now: indexNow },
    settings: { riskPerTrade: st.riskPerTrade, maxPositionValue: st.maxPositionValue, maxDailyLoss: st.maxDailyLoss, profitTarget: st.profitTarget, maxTradesPerDay: st.maxTradesPerDay, squareOff: st.squareOff, entryCutoff: st.entryCutoff, slippagePct: st.slippagePct },
    regime: { tag: regime.tag, pct: regime.pct, gap, conflicts },
    strategies,
  };
}

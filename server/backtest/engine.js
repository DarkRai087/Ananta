// Bar-by-bar intraday backtester for ONE strategy on ONE session.
//
// Rules (zero lookahead, session-bound):
//  • The strategy sees bar i at its close (BarContext blocks reads beyond i).
//  • A signal fills at the NEXT bar's open, same session. A signal on the last bar is dropped.
//  • No entries before the strategy's warm-up, outside its entry window, or at/after the cutoff.
//  • Forced square-off at the open of the first bar starting at/after 15:15.
//  • Stop and target touched in the same bar → stop first. Gaps through a level fill at the open.
//  • One position at a time; max trades per day; daily max-loss halts the rest of the day.
//  • Optional index filter (settings.indexFilter ≠ "off", session.indexDir set): longs only
//    while the index is up at the signal bar, shorts only while it's down (config/indices.js).
//  • Optional breakeven / trailing stop: recomputed at each bar's close from bars ≤ i, only
//    ever tightened, and used from the next bar. R stays measured from the initial stop.
//  • Size: the most shares whose loss at the initial stop — price move, stop slippage and all
//    charges — is within settings.riskPerTrade. 1R = that planned net loss, so a stopped-out
//    trade is about −1R.
import { SessionData, BarContext } from "../lab/sessionData.js";
import { hhmmToMin, istMinute, timeBucket } from "../lab/time.js";
import { tradeCosts, sizeForRisk } from "./costs.js";

/**
 * Stop and target for an entry at `entry`, exactly as the backtest sets them.
 * sig: { stop?, target? } from the strategy; atr: ATR(params.atrPeriod) at the signal bar.
 * Returns { stop, target, riskPerShare }, or null when the stop is missing or on the wrong side
 * (the backtest skips those trades).
 */
export function bracket(side, entry, sig, params, atr) {
  let stop = null;
  if (params.stopType === "atr") {
    if (atr != null) stop = side === "long" ? entry - params.atrMult * atr : entry + params.atrMult * atr;
  } else if (params.stopType === "percent") {
    stop = side === "long" ? entry * (1 - params.stopPct / 100) : entry * (1 + params.stopPct / 100);
  } else {
    stop = sig?.stop ?? null;
  }
  if (stop == null || !Number.isFinite(stop) || (side === "long" ? stop >= entry : stop <= entry)) return null;
  const riskPerShare = Math.abs(entry - stop);
  let target = null;
  if (params.targetR > 0) target = side === "long" ? entry + params.targetR * riskPerShare : entry - params.targetR * riskPerShare;
  else if (sig?.target != null && (side === "long" ? sig.target > entry : sig.target < entry)) target = sig.target;
  return { stop, target, riskPerShare };
}

/**
 * Exit price that leaves `profitRs` in hand AFTER costs for `qty` shares entered at `entry`
 * (settings.profitTarget). Costs depend on the exit price, so it converges in a few steps.
 */
export function targetForProfit(side, entry, qty, profitRs) {
  if (!(qty > 0) || !(profitRs > 0)) return null;
  const long = side === "long";
  let t = long ? entry + profitRs / qty : entry - profitRs / qty;
  for (let k = 0; k < 4; k++) {
    const c = long ? tradeCosts(entry * qty, t * qty).total : tradeCosts(t * qty, entry * qty).total;
    t = long ? entry + (profitRs + c) / qty : entry - (profitRs + c) / qty;
  }
  return t > 0 ? t : null;
}

/**
 * live = true is for a session still in progress (pass only COMPLETED bars): a position still
 * open at the last bar is returned as `open` instead of being closed, and a signal at the last
 * bar's close is returned as `pending` (it would fill at the next bar's open, i.e. now).
 */
export function runSession({ session, symbol, strategy, params, settings, intervalMin, cacheKey = null, sd = null, live = false }) {
  const data = sd || new SessionData(session, intervalMin, cacheKey);
  const cs = data.candles;
  const n = cs.length;
  const trades = [];
  if (!n || session.special) return { trades, skipped: 0, open: null, pending: null };

  const ctx = new BarContext(data, params);
  const cutoff = hhmmToMin(settings.entryCutoff);
  const sqOff = hhmmToMin(settings.squareOff);
  const winStart = hhmmToMin(params.entryStart);
  const winEnd = Math.min(hhmmToMin(params.entryEnd), cutoff);
  const warmup = strategy.warmup ? strategy.warmup(params, intervalMin) : 0;
  const slip = settings.slippagePct / 100;

  let pos = null;
  let pending = null;
  let dayPnl = 0;
  let halted = false;
  let skipped = 0;
  let filtered = 0;
  const indexDir = settings.indexFilter && settings.indexFilter !== "off" ? session.indexDir : null;

  const close = (i, rawPrice, reason, market) => {
    const side = pos.side;
    let exit = rawPrice;
    if (market) exit = side === "long" ? rawPrice * (1 - slip) : rawPrice * (1 + slip);
    const qty = pos.qty;
    const gross = (side === "long" ? exit - pos.entry : pos.entry - exit) * qty;
    const buyValue = (side === "long" ? pos.entry : exit) * qty;
    const sellValue = (side === "long" ? exit : pos.entry) * qty;
    const costs = tradeCosts(buyValue, sellValue).total;
    const net = gross - costs;
    const riskRs = pos.plannedLoss; // net ₹ lost at the initial stop, charges included
    const forced = reason === "forced";
    trades.push({
      symbol,
      date: session.date,
      strategy: strategy.id,
      side,
      entryTime: pos.entryTime,
      exitTime: cs[i].time,
      entry: pos.entry,
      exit,
      stop: pos.stop,
      initialStop: pos.initialStop,
      target: pos.target,
      qty,
      riskRs,
      gross,
      costs,
      net,
      rGross: gross / riskRs,
      rNet: net / riskRs,
      reason,
      outcome: forced ? "forced" : net > 0 ? "win" : "loss",
      bucket: timeBucket(istMinute(pos.entryTime)),
      signal: pos.reason,
    });
    dayPnl += net;
    if (settings.maxDailyLoss > 0 && dayPnl <= -settings.maxDailyLoss) halted = true;
    pos = null;
    ctx.position = null;
  };

  for (let i = 0; i < n; i++) {
    const bar = cs[i];
    const m = data.minutes[i];

    // 1) Fill what was signalled at the previous close.
    if (pending) {
      const p = pending;
      pending = null;
      if (p.type === "exit" && pos) close(i, bar.open, "signal", true);
      else if (p.type === "entry" && !pos && !halted && m < cutoff && m < sqOff) open(i, p);
    }

    // 2) Forced square-off at 15:15.
    if (pos && m >= sqOff) close(i, bar.open, "forced", true);

    // 3) Stop / target inside this bar (stop first if both).
    if (pos) {
      const { side, stop, target } = pos;
      if (side === "long") {
        if (target != null && bar.open >= target) close(i, bar.open, "target", false);
        else if (bar.open <= stop) close(i, bar.open, stopReason(), true);
        else if (bar.low <= stop) close(i, stop, stopReason(), true);
        else if (target != null && bar.high >= target) close(i, target, "target", false);
      } else {
        if (target != null && bar.open <= target) close(i, bar.open, "target", false);
        else if (bar.open >= stop) close(i, bar.open, stopReason(), true);
        else if (bar.high >= stop) close(i, stop, stopReason(), true);
        else if (target != null && bar.low <= target) close(i, target, "target", false);
      }
    }

    // 4) Strategy decision at this bar's close.
    if (m >= sqOff) continue;
    if (pos) trailStop(i);
    ctx.i = i;
    ctx.position = pos ? { side: pos.side, entry: pos.entry, stop: pos.stop, target: pos.target, entryIndex: pos.entryIndex } : null;
    ctx.tradesToday = trades.length + (pos ? 1 : 0);
    const sig = strategy.onBar(ctx);
    if (!sig || (i >= n - 1 && !live)) continue; // nothing, or no next bar this session
    const nextMin = i < n - 1 ? data.minutes[i + 1] : data.minutes[i] + intervalMin;

    if (pos) {
      if (sig.exit) pending = { type: "exit" };
      continue;
    }
    if (!sig.side || halted) continue;
    if (sig.side === "long" && !params.allowLong) continue;
    if (sig.side === "short" && !params.allowShort) continue;
    if (i < warmup) continue;
    if (nextMin < winStart || nextMin >= winEnd || nextMin >= cutoff) continue;
    if (ctx.tradesToday >= settings.maxTradesPerDay) continue;
    // Context gate: a strategy with `contexts` trades only on days whose opening context
    // (gap/OR-width/PDH-PDL, fixed at 09:30) is in its list. Unknown context → skip.
    if (strategy.contexts && !strategy.contexts.includes(session.context?.key)) {
      filtered++;
      continue;
    }
    if (indexDir && indexDir[i] != null && indexDir[i] !== (sig.side === "long" ? 1 : -1)) {
      filtered++;
      continue;
    }
    pending = { type: "entry", sig, signalIndex: i };
  }

  if (live) {
    const openPos = pos
      ? { side: pos.side, entry: pos.entry, stop: pos.stop, initialStop: pos.initialStop, target: pos.target, qty: pos.qty, riskPerShare: pos.riskPerShare, plannedLoss: pos.plannedLoss, entryTime: pos.entryTime, reason: pos.reason }
      : null;
    const pend = pending && (pending.type === "exit" || !halted) ? { type: pending.type, sig: pending.sig ?? null, signalTime: cs[n - 1].time } : null;
    return { trades, skipped, filtered, open: openPos, pending: pend, halted };
  }
  // Data ended before 15:15 (short day / missing bars): exit at the last close, counted as forced.
  if (pos) close(n - 1, cs[n - 1].close, "forced", true);
  return { trades, skipped, filtered, open: null, pending: null };

  function open(i, p) {
    const { sig, signalIndex } = p;
    const raw = cs[i].open;
    const side = sig.side;
    const entry = side === "long" ? raw * (1 + slip) : raw * (1 - slip);
    const b = bracket(side, entry, sig, params, params.stopType === "atr" ? data.get("atr", params.atrPeriod)[signalIndex] : null);
    if (!b) {
      skipped++;
      return;
    }
    const { stop, riskPerShare } = b;
    let { target } = b;
    const size = sizeForRisk(side, entry, stop, { riskRs: settings.riskPerTrade, maxValue: settings.maxPositionValue, slippagePct: settings.slippagePct });
    const qty = size.qty;
    if (qty < 1) {
      skipped++;
      return;
    }
    if (settings.profitTarget > 0) target = targetForProfit(side, entry, qty, settings.profitTarget);
    pos = { side, entry, stop, initialStop: stop, best: entry, target, qty, riskPerShare, plannedLoss: size.lossRs, entryTime: cs[i].time, entryIndex: i, reason: sig.reason };
  }

  // A stop that has been moved (breakeven or trailing) exits as "trail".
  function stopReason() {
    return pos.stop !== pos.initialStop ? "trail" : "stop";
  }

  // Breakeven / trailing stop at the close of bar i (the position survived the bar).
  function trailStop(i) {
    const bar = cs[i];
    const long = pos.side === "long";
    pos.best = long ? Math.max(pos.best, bar.high) : Math.min(pos.best, bar.low);
    let next = pos.stop;
    // Only tighten, and never to the wrong side of the close (that would be an instant exit).
    const offer = (x) => {
      if (x == null || !Number.isFinite(x)) return;
      if (long ? x > next && x < bar.close : x < next && x > bar.close) next = x;
    };
    if (params.breakevenR > 0) {
      const fav = long ? pos.best - pos.entry : pos.entry - pos.best;
      if (fav >= params.breakevenR * pos.riskPerShare) offer(pos.entry);
    }
    if (params.trailType === "atr") {
      const a = data.get("atr", params.atrPeriod)[i];
      if (a != null) offer(long ? bar.close - params.trailAtrMult * a : bar.close + params.trailAtrMult * a);
    } else if (params.trailType === "vwap") {
      offer(data.get("vwap")[i]);
    } else if (params.trailType === "ema") {
      offer(data.get("ema", params.trailEmaPeriod)[i]);
    } else if (params.trailType === "swing") {
      const from = Math.max(pos.entryIndex, i - params.trailSwingBars + 1);
      let x = long ? Infinity : -Infinity;
      for (let k = from; k <= i; k++) x = long ? Math.min(x, cs[k].low) : Math.max(x, cs[k].high);
      offer(x);
    }
    pos.stop = next;
  }
}

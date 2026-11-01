// Today's Top 3 + the all-strategies scoreboard. The method, step by step:
//  1. Backtest every strategy (default params) over the last W sessions before today, where
//     W = oosSessions / (1 − inSampleFraction). The last `oosSessions` dates are out-of-sample.
//  2. Classify today (per symbol) once its opening range completes: gap bucket, OR width vs
//     14-day ATR, and price vs PDH/PDL (lab/context.js).
//  3. Keep only OOS trades from past sessions with the same context as today.
//  4. Rank by net expectancy in ₹ (then R), after costs. ≥ minTrades matching trades to rank;
//     only positive expectancy makes the Top 3. None → "No edge today — sit out".
//  Before today's context exists (pre-market / OR not done) it ranks on all OOS trades.
import { LAB } from "../config/lab.js";
import { RANKED_STRATEGIES as STRATEGIES } from "../strategies/index.js";
import { loadSessions, runStrategies, settingsWithDefaults } from "../backtest/run.js";
import { metrics } from "../backtest/metrics.js";
import { SessionData } from "../lab/sessionData.js";
import { istNow, istDate, hhmmToMin, OPEN_MIN } from "../lab/time.js";
import { sessionsBack } from "../data/intraday.js";
import { isTradingDay } from "../data/holidays.js";
import { universeSymbols, isUniverse, UNIVERSES } from "../data/universes.js";
import { referenceIndex, indexName } from "../data/indexMembers.js";
import { attachIndex } from "../market/indexLink.js";
import { INDEX_FILTER } from "../config/indices.js";
import { lru } from "../lru.js";

const LEVEL_LABELS = {
  orHigh: "OR high", orLow: "OR low", vwap: "VWAP", ema9: "EMA 9", ema21: "EMA 21", dayHigh: "Day high",
  dayLow: "Day low", pdh: "PDH", pdl: "PDL", pdc: "Prev close", tc: "CPR top", pivot: "Pivot", bc: "CPR bottom",
  r1: "R1", s1: "S1", supertrend: "Supertrend", bbUpper: "BB upper", bbMid: "BB mid", bbLower: "BB lower",
  open: "Open", h3: "H3", h4: "H4", l3: "L3", l4: "L4", vwapUpper: "VWAP +2σ", vwapLower: "VWAP −2σ",
};

function todayLevels(today, last, intervalMin) {
  const lv = {};
  if (today) {
    const sd = new SessionData(today, intervalMin);
    const n = today.candles.length - 1;
    const or = sd.get("or", LAB.context.orMinutes);
    if (or && Number.isFinite(or.completeIndex)) Object.assign(lv, { orHigh: or.high, orLow: or.low });
    lv.vwap = sd.get("vwap")[n];
    lv.open = today.candles[0]?.open;
    const vb = sd.get("vwapBands", 2);
    Object.assign(lv, { vwapUpper: vb.upper[n], vwapLower: vb.lower[n] });
    lv.ema9 = sd.get("ema", 9)[n];
    lv.ema21 = sd.get("ema", 21)[n];
    lv.supertrend = sd.get("supertrend", 10, 3).value[n];
    const bb = sd.get("bb", 20, 2);
    Object.assign(lv, { bbUpper: bb.upper[n], bbMid: bb.mid[n], bbLower: bb.lower[n] });
    lv.dayHigh = Math.max(...today.candles.map((c) => c.high));
    lv.dayLow = Math.min(...today.candles.map((c) => c.low));
    if (today.prev) Object.assign(lv, { pdh: today.prev.high, pdl: today.prev.low, pdc: today.prev.close }, sd.pivots);
  } else if (last) {
    // Pre-market: the last session becomes "previous day".
    const prev = { high: Math.max(...last.candles.map((c) => c.high)), low: Math.min(...last.candles.map((c) => c.low)), close: last.candles[last.candles.length - 1].close };
    const sd = new SessionData({ ...last, candles: [], prev }, intervalMin);
    Object.assign(lv, { pdh: prev.high, pdl: prev.low, pdc: prev.close }, sd.pivots);
  }
  return lv;
}

const pct = (x) => (x == null ? "—" : `${x.toFixed(1)}%`);

// The window's backtest ends yesterday, so it is the same all day: it runs once per day per
// request shape and is kept here (the jobs pool sends one target's refreshes to one worker).
const windowCache = lru({ max: 4 });

// Every strategy over the last `window` sessions before today, without and with the index
// filter (one pass, shared indicators), so the scoreboard can show whether trading with the
// index helps.
function backtestWindow({ symbols, interval, window, oosSessions, settings, compareWith, now, onProgress }) {
  const loadFrom = istDate(sessionsBack(window + LAB.context.atrDays + 5, now.t));
  const allDates = new Set();
  const perSymbol = symbols.map((symbol) => {
    const hist = loadSessions(symbol, interval, { from: loadFrom }).filter((s) => !s.special && s.date < now.date);
    hist.slice(-window).forEach((s) => allDates.add(s.date));
    return { symbol, hist };
  });
  const dates = [...allDates].sort().slice(-window);
  const oosFrom = dates.length ? dates[Math.max(0, dates.length - oosSessions)] : null;
  const windowFrom = dates[0] ?? null;

  // Each stock's index (its sector index, or NIFTY 50), lined up bar by bar.
  const refBySymbol = {};
  const indexCache = new Map();
  for (const p of perSymbol) {
    const ref = referenceIndex(p.symbol, compareWith);
    refBySymbol[p.symbol] = ref;
    if (!ref) continue;
    if (!indexCache.has(ref)) indexCache.set(ref, loadSessions(ref, interval, { from: loadFrom }).filter((x) => !x.special));
    attachIndex(p.hist, indexCache.get(ref), { indexId: ref });
  }

  const symbolSessions = perSymbol.map((p) => ({ symbol: p.symbol, sessions: p.hist.filter((s) => windowFrom && s.date >= windowFrom) }));
  const entries = STRATEGIES.flatMap((x) => [
    { id: x.id, key: `${x.id}|off`, settings: { indexFilter: "off" } },
    { id: x.id, key: `${x.id}|on`, settings: { indexFilter: compareWith } },
  ]);
  const t = runStrategies(symbolSessions, entries, { interval, settings, onProgress }).tradesByStrategy;
  const pick = (v) => Object.fromEntries(STRATEGIES.map((x) => [x.id, t[`${x.id}|${v}`]]));
  return { oosFrom, windowFrom, refBySymbol, base: pick("off"), withIndex: pick("on") };
}

export function computeToday({ target, interval = LAB.defaultInterval, oosSessions = LAB.ranking.oosSessions, settings = {}, nowMs = Date.now(), onProgress } = {}) {
  const T = String(target).toUpperCase();
  const universe = isUniverse(T);
  const symbols = universe ? universeSymbols(T) : [T];
  const intervalMin = LAB.intervals[interval];
  const frac = LAB.walkForward.inSampleFraction;
  const window = Math.ceil(oosSessions / (1 - frac));
  const now = istNow(nowMs);
  const freezeMin = hhmmToMin(LAB.ranking.freezeAt);
  const minTrades = LAB.ranking.minTrades;

  const st = settingsWithDefaults(settings);
  const indexChoice = st.indexFilter || "off";
  const compareWith = indexChoice === "off" ? "sector" : indexChoice;

  // 1. The window backtest (cached for the day).
  const key = [now.date, T, interval, oosSessions, JSON.stringify(settings)].join("|");
  const { oosFrom, windowFrom, refBySymbol, base, withIndex } = windowCache.use(key, () =>
    backtestWindow({ symbols, interval, window, oosSessions, settings, compareWith, now, onProgress })
  );
  const tradesByStrategy = indexChoice === "off" ? base : withIndex;

  // 2. Today per symbol: its context needs only the previous day and the ATR days before it.
  const recentFrom = istDate(sessionsBack(LAB.context.atrDays + 5, now.t));
  const perSymbol = symbols.map((symbol) => {
    const ss = loadSessions(symbol, interval, { from: recentFrom, doneBy: now.t }).filter((s) => !s.special);
    const hist = ss.filter((s) => s.date < now.date);
    return { symbol, today: ss.find((s) => s.date === now.date) || null, last: hist[hist.length - 1] || null };
  });
  const ctxBySymbol = {};
  for (const p of perSymbol) if (p.today?.context?.ready) ctxBySymbol[p.symbol] = p.today.context;
  const anyToday = perSymbol.some((p) => p.today);
  const readyCount = Object.keys(ctxBySymbol).length;

  let mode;
  let label;
  if (readyCount > 0) {
    mode = now.minute >= freezeMin ? "frozen" : "live";
    label = mode === "frozen" ? `Frozen at ${LAB.ranking.freezeAt} — today's context` : "Today's context (opening range complete)";
  } else if (anyToday || (now.minute >= OPEN_MIN && now.minute < OPEN_MIN + intervalMin && isTradingDay(now.date))) {
    // (the second case: the session has started but its first bar hasn't closed yet)
    mode = "waiting";
    label = `Waiting for the ${LAB.context.orMinutes}-minute opening range — ranking on recent performance`;
  } else {
    mode = "premarket";
    label =
      isTradingDay(now.date) && now.minute < OPEN_MIN
        ? "Pre-market (no today context yet)"
        : "Market closed today — ranking on recent performance (no today context)";
  }
  const useContext = readyCount > 0;

  // 4. Scoreboard + ranking.
  const scoreboard = [];
  const candidates = [];
  for (const s of STRATEGIES) {
    const trades = tradesByStrategy[s.id];
    const like = useContext ? trades.filter((t) => ctxBySymbol[t.symbol] && t.ctx === ctxBySymbol[t.symbol].key) : [];
    const split = (arr) => ({ is: metrics(arr.filter((t) => t.date < oosFrom)), oos: metrics(arr.filter((t) => t.date >= oosFrom)) });
    const likeOf = (arr) => (useContext ? arr.filter((t) => ctxBySymbol[t.symbol] && t.ctx === ctxBySymbol[t.symbol].key) : []);
    const row = {
      id: s.id,
      name: s.name,
      all: split(trades),
      like: useContext ? split(like) : null,
      // Both versions, for the index-filter comparison.
      cmp: {
        off: { all: split(base[s.id]), like: useContext ? split(likeOf(base[s.id])) : null },
        on: { all: split(withIndex[s.id]), like: useContext ? split(likeOf(withIndex[s.id])) : null },
      },
    };
    scoreboard.push(row);

    const pool = useContext ? row.like.oos : row.all.oos;
    const poolDays = new Set((useContext ? like : trades).filter((t) => t.date >= oosFrom).map((t) => t.date)).size;
    candidates.push({ id: s.id, name: s.name, m: pool, days: poolDays, levelKeys: s.levels || [] });
  }

  const ctxText = !useContext
    ? `Last ${oosSessions} sessions`
    : universe
      ? `Each stock's own context today (${readyCount}/${symbols.length} ready)`
      : ctxBySymbol[T].label;

  const ranked = [];
  const notEnough = [];
  const negative = [];
  for (const c of candidates) {
    if (c.m.trades < minTrades) notEnough.push({ id: c.id, name: c.name, trades: c.m.trades, reason: `not enough data (${c.m.trades} of ${minTrades} trades)` });
    else if (!(c.m.expectancyRs > 0)) negative.push({ id: c.id, name: c.name, trades: c.m.trades, expectancyRs: c.m.expectancyRs, expectancyR: c.m.expectancyR });
    else ranked.push(c);
  }
  ranked.sort((a, b) => b.m.expectancyRs - a.m.expectancyRs || b.m.expectancyR - a.m.expectancyR);

  const single = !universe ? perSymbol[0] : null;
  const levels = single ? todayLevels(single.today, single.last, intervalMin) : {};

  const top3 = ranked.slice(0, 3).map((c, k) => ({
    rank: k + 1,
    id: c.id,
    name: c.name,
    why: `${ctxText}: ${c.name} made money after charges on ${pct(c.m.winPct)} (${c.m.wins} of ${c.m.trades}) ${useContext ? "similar " : ""}trades over ${c.days} days`,
    winPct: c.m.winPct,
    winLow: c.m.winLow,
    winHigh: c.m.winHigh,
    wins: c.m.wins,
    breakEvenWinPct: c.m.breakEvenWinPct,
    exits: c.m.exits,
    lossPct: c.m.lossPct,
    forcedPct: c.m.forcedPct,
    expectancyRs: c.m.expectancyRs,
    expectancyR: c.m.expectancyR,
    trades: c.m.trades,
    days: c.days,
    levels: single
      ? c.levelKeys
          .filter((k2) => levels[k2] != null && Number.isFinite(levels[k2]))
          .map((k2) => ({ key: k2, label: LEVEL_LABELS[k2], price: levels[k2] }))
      : [],
  }));

  // Did the index filter help? Out-of-sample net ₹ over all sessions, per strategy and in total.
  function indexSummary() {
    const refs = [...new Set(Object.values(refBySymbol).filter(Boolean))];
    let improved = 0;
    let compared = 0;
    let betterPerTrade = 0;
    let comparedPerTrade = 0;
    let netOff = 0;
    let netOn = 0;
    let tradesOff = 0;
    let tradesOn = 0;
    for (const row of scoreboard) {
      const a = row.cmp.off.all.oos;
      const b = row.cmp.on.all.oos;
      netOff += a.netPnl;
      netOn += b.netPnl;
      tradesOff += a.trades;
      tradesOn += b.trades;
      if (!a.trades) continue;
      compared++;
      // Made more money, or lost less (skipping a losing trade counts).
      if (b.netPnl > a.netPnl) improved++;
      // The stricter test: was the average trade better? Needs enough trades either way.
      if (a.trades >= 10 && b.trades >= 10) {
        comparedPerTrade++;
        if (b.expectancyR > a.expectancyR) betterPerTrade++;
      }
    }
    return {
      choice: indexChoice,
      compareWith,
      rule: INDEX_FILTER.rule,
      refs: refs.map((id) => ({ id, name: indexName(id) })),
      refBySymbol: universe ? null : refBySymbol,
      improved,
      compared,
      betterPerTrade,
      comparedPerTrade,
      netOff,
      netOn,
      tradesOff,
      tradesOn,
    };
  }

  return {
    target: T,
    targetName: universe ? UNIVERSES[T].name : T,
    universe,
    symbols: symbols.length,
    interval,
    mode,
    label,
    asOf: now.t,
    date: now.date,
    context: single ? (single.today?.context ?? null) : null,
    contextsReady: readyCount,
    index: indexSummary(),
    sizing: (({ riskPerTrade, maxPositionValue, profitTarget, maxDailyLoss }) => ({ riskPerTrade, maxPositionValue, profitTarget, maxDailyLoss }))(settingsWithDefaults(settings)),
    method: {
      windowSessions: window,
      oosSessions,
      windowFrom,
      oosFrom,
      minTrades,
      match: LAB.context.match,
      freezeAt: LAB.ranking.freezeAt,
      refreshMinutes: LAB.ranking.refreshMinutes,
    },
    top3,
    noEdge: top3.length === 0,
    noEdgeReason:
      top3.length > 0
        ? null
        : negative.length
          ? `Every strategy with ≥${minTrades} matching trades lost money after costs.`
          : `No strategy has ${minTrades}+ matching out-of-sample trades yet — backfill more history or widen the universe.`,
    notEnough,
    negative,
    scoreboard,
    levels,
  };
}

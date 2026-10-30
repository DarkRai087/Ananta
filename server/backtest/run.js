// Runs strategies over many symbols/sessions and summarises with a walk-forward split.
// Reads candles from SQLite only (data must already be synced), so it can run in a worker.
import { LAB } from "../config/lab.js";
import { loadIntraday } from "../data/intraday.js";
import { buildSessions } from "../lab/sessions.js";
import { annotateContexts } from "../lab/context.js";
import { SessionData } from "../lab/sessionData.js";
import { istEpoch } from "../lab/time.js";
import { runSession } from "./engine.js";
import { metrics, walkForwardFlag } from "./metrics.js";
import { getStrategy, resolveParams } from "../strategies/index.js";
import { attachMarketFor } from "../market/marketData.js";

export const settingsWithDefaults = (s = {}) => {
  const out = { ...LAB.backtest };
  for (const [k, v] of Object.entries(s || {})) {
    if (v === undefined || v === null || v === "") continue;
    out[k] = typeof LAB.backtest[k] === "number" ? Number(v) : typeof LAB.backtest[k] === "boolean" ? v === true || v === "true" : v;
  }
  return out;
};

// Sessions for a symbol with prior-day refs and contexts. `lookbackDays` of extra history
// before `from` is loaded only for reference levels / ATR context (never traded).
// doneBy (unix s): leave out candles still forming at that time.
export function loadSessions(symbol, interval, { from = null, to = null, lookbackDays = 40, doneBy = null } = {}) {
  const fromSec = from ? istEpoch(from) - lookbackDays * 86400 : 0;
  const toSec = Math.min(to ? istEpoch(to, "23:59") : 4e9, doneBy ? doneBy - LAB.intervals[interval] * 60 : 4e9);
  const sessions = buildSessions(loadIntraday(symbol, interval, { fromSec, toSec }));
  annotateContexts(sessions, LAB.intervals[interval]);
  return sessions;
}

/**
 * symbolSessions: [{ symbol, sessions }] — sessions to trade (already filtered to the range)
 * strategies: [{ id, params }]
 * returns { tradesByStrategy: { id: trades[] }, skipped, dates: sorted unique dates traded }
 */
export function runStrategies(symbolSessions, strategies, { interval, settings, onProgress }) {
  const intervalMin = LAB.intervals[interval];
  const st = settingsWithDefaults(settings);
  const resolved = strategies.map((s) => {
    const def = getStrategy(s.id);
    return { def, params: resolveParams(def, s.params) };
  });
  const tradesByStrategy = Object.fromEntries(resolved.map((r) => [r.def.id, []]));
  // Strategies that read the market (ctx.market) get NIFTY 50 + the sector index lined up.
  if (resolved.some((r) => r.def.needsMarket)) {
    for (const { symbol, sessions } of symbolSessions) if (sessions.length && !sessions[0].market) attachMarketFor(symbol, interval, sessions);
  }
  const dates = new Set();
  let skipped = 0;
  const total = symbolSessions.reduce((n, x) => n + x.sessions.length, 0);
  let done = 0;

  for (const { symbol, sessions } of symbolSessions) {
    for (const s of sessions) {
      done++;
      if (s.special && !st.includeSpecialSessions) continue;
      dates.add(s.date);
      const sd = new SessionData(s, intervalMin, `${symbol}|${interval}|${s.date}`);
      for (const { def, params } of resolved) {
        const r = runSession({ session: s, symbol, strategy: def, params, settings: st, intervalMin, sd });
        skipped += r.skipped;
        for (const t of r.trades) {
          t.ctx = s.context?.key ?? null;
          t.ctxParts = s.context?.parts ?? null;
          tradesByStrategy[def.id].push(t);
        }
      }
      if (onProgress && done % 20 === 0) onProgress(done, total);
    }
  }
  onProgress?.(total, total);
  return { tradesByStrategy, skipped, dates: [...dates].sort() };
}

// First `inSampleFraction` of dates = in-sample, the rest = out-of-sample.
export function splitDate(dates, frac = LAB.walkForward.inSampleFraction) {
  if (!dates.length) return null;
  return dates[Math.min(dates.length - 1, Math.floor(dates.length * frac))];
}

export function walkForward(trades, split, { withEquity = false } = {}) {
  const is = trades.filter((t) => split && t.date < split);
  const oos = trades.filter((t) => !split || t.date >= split);
  const mIs = metrics(is, { withEquity });
  const mOos = metrics(oos, { withEquity });
  return { all: metrics(trades, { withEquity }), is: mIs, oos: mOos, flag: walkForwardFlag(mIs, mOos, 5) };
}

// Lab: one strategy, many symbols, a date range.
export function runLabBacktest({ symbols, interval, from, to, strategy, params, settings, onProgress }) {
  const symbolSessions = symbols.map((symbol) => ({
    symbol,
    sessions: loadSessions(symbol, interval, { from, to }).filter((s) => (!from || s.date >= from) && (!to || s.date <= to)),
  }));
  const { tradesByStrategy, skipped, dates } = runStrategies(symbolSessions, [{ id: strategy, params }], { interval, settings, onProgress });
  const trades = tradesByStrategy[strategy].sort((a, b) => a.entryTime - b.entryTime);
  const split = splitDate(dates);
  const def = getStrategy(strategy);
  return {
    kind: "backtest",
    strategy: { id: def.id, name: def.name, params: resolveParams(def, params) },
    settings: settingsWithDefaults(settings),
    symbols,
    interval,
    from: dates[0] ?? from,
    to: dates[dates.length - 1] ?? to,
    sessions: dates.length,
    splitDate: split,
    skipped,
    ...walkForward(trades, split, { withEquity: true }),
    trades: trades.length > 20000 ? trades.slice(-20000) : trades,
    tradesTruncated: trades.length > 20000,
    symbolsWithData: symbolSessions.filter((x) => x.sessions.length).map((x) => x.symbol),
  };
}

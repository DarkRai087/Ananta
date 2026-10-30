// Everything the worker threads run, by name (workers/pool.js). Jobs report progress through
// `progress(done, total, message)`; live tasks answer one HTTP request each, syncing first.
import { LAB } from "../config/lab.js";
import { MARKET_INDEX } from "../config/indices.js";
import { AppError } from "../errors.js";
import { runLabBacktest, loadSessions } from "../backtest/run.js";
import { patternStats } from "../patterns/stats.js";
import { computeToday } from "../ranking/today.js";
import { getCandles } from "../data/candles.js";
import { loadIntraday, syncIntraday, sessionsBack } from "../data/intraday.js";
import { referenceIndex } from "../data/indexMembers.js";
import { buildSessions } from "../lab/sessions.js";
import { computeOverlays, patternMarkers } from "../lab/overlays.js";
import { istEpoch } from "../lab/time.js";
import { buildPlans } from "../plans/index.js";
import { decisionReport, syncForReport } from "../decision/live.js";
import { predict } from "../prediction/index.js";
import { indexLink } from "../market/index.js";

export const TASKS = {
  // ── Jobs (backtest/jobs.js) ──
  backtest: (input, progress) => runLabBacktest({ ...input, onProgress: (d, t) => progress(d, t, "Backtesting sessions") }),

  patterns(input, progress) {
    const inRange = (s) => (!input.from || s.date >= input.from) && (!input.to || s.date <= input.to);
    const sessionsBySymbol = input.symbols.map((symbol) => ({ symbol, sessions: loadSessions(symbol, input.interval, { from: input.from, to: input.to }).filter(inRange) }));
    return {
      kind: "patterns",
      symbols: input.symbols,
      interval: input.interval,
      from: input.from,
      to: input.to,
      sessions: sessionsBySymbol.reduce((n, x) => n + x.sessions.length, 0),
      ...patternStats(sessionsBySymbol, {
        intervalMin: LAB.intervals[input.interval],
        patternIds: input.patternIds?.length ? input.patternIds : null,
        horizons: input.horizons,
        onProgress: (d, t) => progress(d, t, "Scanning sessions"),
      }),
    };
  },

  today: (input, progress) => ({ kind: "today", ...computeToday({ ...input, onProgress: (d, t) => progress(d, t, "Backtesting all strategies") }) }),

  // ── Live requests (routes) ──
  candles: ({ symbol, interval, opts }) => getCandles(symbol, interval, opts),

  // Dates that have cached candles (no network).
  sessions: ({ symbol, interval, from, to }) =>
    buildSessions(loadIntraday(symbol, interval, { fromSec: from ? istEpoch(from) : 0, toSec: to ? istEpoch(to, "23:59") : 4e9 })).map((s) => ({
      date: s.date,
      special: s.special,
      bars: s.candles.length,
    })),

  // One session's candles (+ overlays, pattern markers), from the cache.
  session({ symbol, interval, date, overlays, patterns, orMinutes }) {
    const rows = loadIntraday(symbol, interval, { fromSec: istEpoch(date) - 15 * 86400, toSec: istEpoch(date, "23:59") });
    const s = buildSessions(rows).find((x) => x.date === date);
    if (!s) throw new AppError(404, "NOT_FOUND", `No ${interval} data for ${symbol} on ${date}`);
    return {
      symbol,
      interval,
      date,
      special: s.special,
      prev: s.prev,
      candles: s.candles,
      overlays: overlays.length ? computeOverlays([s], overlays, { intervalMin: LAB.intervals[interval], orMinutes, symbol, interval }) : {},
      markers: patterns.length ? patternMarkers([s], patterns) : [],
    };
  },

  // Today's plan for every strategy. Tops up the symbol, its index and NIFTY 50 first.
  async plans({ symbol, interval, account }) {
    let warning = null;
    try {
      ({ warning } = await syncIntraday(symbol, interval, { fromSec: sessionsBack(LAB.historyDays + 10) }));
      const f = account.indexFilter;
      const ix = referenceIndex(symbol, f && f !== "off" ? f : "sector");
      if (ix) await syncIntraday(ix, interval, { fromSec: sessionsBack(10) });
      if (ix !== MARKET_INDEX && symbol !== MARKET_INDEX) await syncIntraday(MARKET_INDEX, interval, { fromSec: sessionsBack(10) });
    } catch (err) {
      warning = err.message;
    }
    return { ...buildPlans({ symbol, interval, account }), warning };
  },

  // A decision engine's full report. Tops up the symbol, NIFTY 50 and its sector index first.
  async decision({ strategy, symbol, interval, account }) {
    const warnings = await syncForReport(symbol, interval);
    return { ...(await decisionReport({ strategy, symbol, interval, account })), warnings };
  },

  predict: ({ symbol, interval }) => predict(symbol, { interval }),
  indexLink: ({ symbol, interval }) => indexLink(symbol, { interval }),
};

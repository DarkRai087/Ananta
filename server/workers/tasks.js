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
import { buildSessions, isSessionCandle } from "../lab/sessions.js";
import { computeOverlays, patternMarkers } from "../lab/overlays.js";
import { istEpoch, istDate, istHHMM } from "../lab/time.js";
import { runTimeMachine } from "../timemachine/src/index.js";
import { fromKite } from "../timemachine/src/kite.js";
import { TimeMachineError } from "../timemachine/src/errors.js";
import { slotOf } from "../timemachine/src/time.js";
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

  // Time Machine: a long plan (no stop and target = a price forecast) replayed from the stock's
  // own last `sessions` 5m sessions before the plan date. Today's morning (completed bars before
  // the entry time) and NIFTY 50 are loaded only for analog days or a forecast without an entry.
  async timemachine({ symbol, plan, options, sessions, analog }) {
    const before = istEpoch(plan.date);
    const fromSec = sessionsBack(sessions + 10, before);
    const needToday = analog || plan.entry == null;
    const doneBy = needToday ? Math.min(before + 86399, Math.floor(Date.now() / 1000) - 300) : before - 1;
    const warnings = new Set();
    for (const s of analog ? [symbol, MARKET_INDEX] : [symbol])
      await syncIntraday(s, "5m", { fromSec }).then((r) => r.warning && warnings.add(r.warning), (err) => warnings.add(err.message));
    const warning = [...warnings].join("; ") || null;
    const load = (s) =>
      fromKite(
        loadIntraday(s, "5m", { fromSec, toSec: doneBy })
          .filter((c) => isSessionCandle(c.time))
          .map((c) => ({ date: `${istDate(c.time)}T${istHHMM(c.time)}`, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }))
      );
    try {
      const mine = load(symbol);
      const day = needToday && mine.find((s) => s.date === plan.date);
      const today = day ? { date: plan.date, bars: day.bars.slice(0, slotOf(plan.entryTime)) } : undefined;
      const index = analog ? load(MARKET_INDEX) : undefined;
      const past = mine.filter((s) => s.date < plan.date).slice(-sessions);
      return { ...runTimeMachine({ symbol, ...plan }, past, { ...options, today, index, conditioning: { enabled: analog } }), warning };
    } catch (e) {
      if (e instanceof TimeMachineError) throw new AppError(400, e.code, warning && e.code === "INSUFFICIENT_SESSIONS" ? `${e.message}. ${warning}` : e.message);
      throw e;
    }
  },

  predict: ({ symbol, interval }) => predict(symbol, { interval }),
  indexLink: ({ symbol, interval }) => indexLink(symbol, { interval }),
};

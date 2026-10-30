// /api/lab/* — intraday lab endpoints.
import { Router } from "express";
import { createHash } from "node:crypto";
import db from "../db.js";
import { LAB } from "../config/lab.js";
import { COSTS } from "../config/costs.js";
import { MARKET } from "../config/market.js";
import { patternList } from "../patterns/index.js";
import { strategyList, STRATEGY_BY_ID } from "../strategies/index.js";
import { OVERLAYS, computeOverlays, patternMarkers } from "../lab/overlays.js";
import { listUniverses, resolveTarget, isUniverse, getWatchlist, setWatchlist } from "../data/universes.js";
import { labSource, loadIntraday, syncIntraday, sessionsBack } from "../data/intraday.js";
import { buildPlans } from "../plans/index.js";
import { decisionReport, syncForReport, hasDecisionReport, DECISION_STRATEGIES } from "../decision/live.js";
import { accountSettings, accountKey } from "../backtest/account.js";
import { referenceIndex } from "../data/indexMembers.js";
import { marketIdsFor } from "../market/marketData.js";
import { MARKET_INDEX } from "../config/indices.js";
import { buildSessions } from "../lab/sessions.js";
import { istEpoch, istNow, hhmmToMin } from "../lab/time.js";
import { startJob, getJob } from "../backtest/jobs.js";
import * as smartapi from "../data/providers/smartapi/index.js";
import { getJwt } from "../data/providers/smartapi/auth.js";
import { ensureInstruments } from "../data/providers/smartapi/instruments.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS today_snapshots (
    key        TEXT PRIMARY KEY,   -- target|interval|oosSessions|date
    json       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
`);

const router = Router();
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, msg) => res.status(400).json({ error: msg, code: "BAD_REQUEST" });

router.get("/meta", (_req, res) => {
  res.json({
    provider: { ...labSource(), smartapiConfigured: smartapi.isConfigured() },
    intervals: Object.keys(LAB.intervals),
    defaultInterval: LAB.defaultInterval,
    patterns: patternList(),
    strategies: strategyList(),
    overlays: OVERLAYS,
    universes: listUniverses(),
    backtest: LAB.backtest,
    ranking: LAB.ranking,
    context: LAB.context,
    patternStats: LAB.patternStats,
    costs: COSTS,
    timeBuckets: MARKET.timeBuckets,
  });
});

router.get("/universes", (_req, res) => res.json(listUniverses()));
router.get("/watchlist", (_req, res) => res.json(getWatchlist()));
router.put("/watchlist", (req, res) => res.json(setWatchlist(req.body?.symbols)));

// Tests the SmartAPI login and instrument master.
router.post("/smartapi/test", wrap(async (_req, res) => {
  if (!smartapi.isConfigured()) return res.status(400).json({ ok: false, error: "Credentials missing in server/.env" });
  try {
    await getJwt();
    const n = await ensureInstruments();
    res.json({ ok: true, instruments: n });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
}));

// Dates that have cached candles (no network).
router.get("/sessions", (req, res) => {
  const { symbol, interval = LAB.defaultInterval, from, to } = req.query;
  if (!symbol) return bad(res, "symbol required");
  const rows = loadIntraday(String(symbol).toUpperCase(), interval, {
    fromSec: from ? istEpoch(from) : 0,
    toSec: to ? istEpoch(to, "23:59") : 4e9,
  });
  res.json(buildSessions(rows).map((s) => ({ date: s.date, special: s.special, bars: s.candles.length })));
});

// One session's candles (+ overlays, pattern markers). Uses the cache; no network.
router.get("/session", (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  const { interval = LAB.defaultInterval, date } = req.query;
  if (!symbol || !date) return bad(res, "symbol and date required");
  const rows = loadIntraday(symbol, interval, { fromSec: istEpoch(date) - 15 * 86400, toSec: istEpoch(date, "23:59") });
  const sessions = buildSessions(rows);
  const s = sessions.find((x) => x.date === date);
  if (!s) return res.status(404).json({ error: `No ${interval} data for ${symbol} on ${date}`, code: "NOT_FOUND" });
  const overlays = String(req.query.overlays || "").split(",").filter(Boolean);
  const patterns = String(req.query.patterns || "").split(",").filter(Boolean);
  res.json({
    symbol,
    interval,
    date,
    special: s.special,
    prev: s.prev,
    candles: s.candles,
    overlays: overlays.length ? computeOverlays([s], overlays, { intervalMin: LAB.intervals[interval], orMinutes: Number(req.query.orMinutes) || 15, symbol, interval }) : {},
    markers: patterns.length ? patternMarkers([s], patterns) : [],
  });
});

// Today's trade plan for every strategy on one symbol (entry / stop / target prices, open
// positions, fresh signals). Tops up the candle cache first; cheap enough to poll.
router.get("/plans", wrap(async (req, res) => {
  const symbol = String(req.query.symbol || "").toUpperCase();
  const interval = req.query.interval || LAB.defaultInterval;
  if (!symbol) return bad(res, "symbol required");
  if (!LAB.intervals[interval]) return bad(res, "bad interval");
  const { capital, riskPct, profitPct, leverage, indexFilter } = req.query;
  let warning = null;
  try {
    ({ warning } = await syncIntraday(symbol, interval, { fromSec: sessionsBack(LAB.historyDays + 10) }));
    const ix = referenceIndex(symbol, indexFilter && indexFilter !== "off" ? indexFilter : "sector");
    if (ix) await syncIntraday(ix, interval, { fromSec: sessionsBack(10) });
    if (ix !== MARKET_INDEX && symbol !== MARKET_INDEX) await syncIntraday(MARKET_INDEX, interval, { fromSec: sessionsBack(10) });
  } catch (err) {
    warning = err.message;
  }
  res.json({ ...buildPlans({ symbol, interval, account: { capital, riskPct, profitPct, leverage, indexFilter } }), warning });
}));

// Full decision report for a strategy with a decision engine (orb, vwapBands) on one symbol:
// analysis, score, mandatory checks, and trade numbers only when the decision allows them.
// Tops up the symbol, NIFTY 50 and its sector index, and reads live SmartAPI quotes.
// /vwap-report is the older address for strategy=vwapBands.
const decisionRoute = (fixed) =>
  wrap(async (req, res) => {
    const strategy = fixed || String(req.query.strategy || "");
    const symbol = String(req.query.symbol || "").toUpperCase();
    const interval = req.query.interval || LAB.defaultInterval;
    if (!hasDecisionReport(strategy)) return bad(res, `strategy must be one with a decision engine: ${DECISION_STRATEGIES.join(", ")}`);
    if (!symbol) return bad(res, "symbol required");
    if (!LAB.intervals[interval]) return bad(res, "bad interval");
    const { capital, riskPct, profitPct, leverage } = req.query;
    const warnings = await syncForReport(symbol, interval);
    res.json({ ...(await decisionReport({ strategy, symbol, interval, account: { capital, riskPct, profitPct, leverage } })), warnings });
  });
router.get("/decision-report", decisionRoute(null));
router.get("/vwap-report", decisionRoute("vwapBands"));

// Start a backtest or pattern-stats job.
router.post("/jobs", (req, res) => {
  const b = req.body || {};
  const interval = b.interval || LAB.defaultInterval;
  if (!LAB.intervals[interval]) return bad(res, `interval must be one of ${Object.keys(LAB.intervals).join(", ")}`);
  const symbols = resolveTarget(b.target);
  if (!symbols.length) return bad(res, isUniverse(b.target) ? "That universe is empty" : "Pick a symbol or universe");
  if (!b.from || !b.to) return bad(res, "from and to dates required");
  if (b.kind === "backtest") {
    if (!STRATEGY_BY_ID[b.strategy]) return bad(res, "Unknown strategy");
    // Strategies that read the market need NIFTY 50 and each stock's sector index synced too.
    const syncExtra = STRATEGY_BY_ID[b.strategy].needsMarket ? [...new Set(symbols.flatMap((s) => Object.values(marketIdsFor(s)).filter(Boolean)))] : [];
    return res.json(startJob("backtest", { symbols, interval, from: b.from, to: b.to, strategy: b.strategy, params: b.params, settings: b.settings, syncExtra }));
  }
  if (b.kind === "patterns") {
    return res.json(startJob("patterns", { symbols, interval, from: b.from, to: b.to, patternIds: b.patternIds, horizons: b.horizons }));
  }
  return bad(res, "kind must be backtest or patterns");
});

router.get("/jobs/:id", (req, res) => {
  const j = getJob(req.params.id);
  if (!j) return res.status(404).json({ error: "Job not found (expired?)", code: "NOT_FOUND" });
  res.json(j);
});

// Today's Top 3 + scoreboard. Returns { result } (frozen snapshot) or { job }.
const recent = new Map(); // key -> { at, jobId }
// Saved results go stale when the charges or the sizing / stats rules change: bump RESULTS_V
// on a rules change; a charges change is picked up by itself.
const RESULTS_V = 2;
const resultsStamp = createHash("sha1").update(JSON.stringify({ v: RESULTS_V, COSTS, bt: LAB.backtest })).digest("hex").slice(0, 8);
router.post("/today", (req, res) => {
  const b = req.body || {};
  const target = String(b.target || "").toUpperCase();
  const interval = b.interval || LAB.defaultInterval;
  const oosSessions = Math.max(10, Number(b.oosSessions) || LAB.ranking.oosSessions);
  if (!target) return bad(res, "target required");
  if (!LAB.intervals[interval]) return bad(res, "bad interval");
  const symbols = resolveTarget(target);
  if (!symbols.length) return bad(res, "That universe is empty");

  // The trader's account (capital, risk %, profit target) sizes every backtested trade.
  const { account, settings } = accountSettings(b.account || {});
  const now = istNow();
  const key = `${target}|${interval}|${oosSessions}|${accountKey(account)}|${now.date}|${resultsStamp}`;
  if (now.minute >= hhmmToMin(LAB.ranking.freezeAt)) {
    const snap = db.prepare("SELECT json FROM today_snapshots WHERE key = ?").get(key);
    if (snap) return res.json({ result: JSON.parse(snap.json), snapshot: true });
  }
  // Reuse a job started in the last 4 minutes for the same request (unless forced).
  const r = recent.get(key);
  if (!b.force && r && Date.now() - r.at < 4 * 60_000 && getJob(r.jobId)?.status !== "error") return res.json({ job: getJob(r.jobId) });

  const window = Math.ceil(oosSessions / (1 - LAB.walkForward.inSampleFraction));
  const job = startJob(
    "today",
    {
      symbols,
      interval,
      target,
      oosSessions,
      settings,
      syncSessions: window + LAB.context.atrDays + 10,
      syncExtra: [...new Set([MARKET_INDEX, ...symbols.map((s) => referenceIndex(s, settings.indexFilter && settings.indexFilter !== "off" ? settings.indexFilter : "sector"))].filter(Boolean))],
    },
    {
      onDone: (result) => {
        if (result.mode === "frozen") {
          db.prepare("INSERT OR REPLACE INTO today_snapshots (key, json, created_at) VALUES (?, ?, ?)").run(key, JSON.stringify(result), Date.now());
        }
      },
    }
  );
  recent.set(key, { at: Date.now(), jobId: job.id });
  res.json({ job });
});

export default router;

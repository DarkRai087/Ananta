// /api/lab/* — intraday lab endpoints. Inputs are checked here (routes/validate.js); anything
// heavier than a lookup runs on the live worker or as a job (workers/pool.js).
import { Router } from "express";
import { createHash } from "node:crypto";
import db from "../db.js";
import { LAB } from "../config/lab.js";
import { COSTS } from "../config/costs.js";
import { MARKET } from "../config/market.js";
import { MARKET_INDEX } from "../config/indices.js";
import { AppError } from "../errors.js";
import { patternList } from "../patterns/index.js";
import { strategyList, STRATEGY_BY_ID, DECISION_STRATEGIES } from "../strategies/index.js";
import { OVERLAYS } from "../lab/overlays.js";
import { listUniverses, resolveTarget, isUniverse, getWatchlist, setWatchlist } from "../data/universes.js";
import { labSource } from "../data/intraday.js";
import { holidayDates } from "../data/holidays.js";
import { accountSettings, accountKey } from "../backtest/account.js";
import { referenceIndex } from "../data/indexMembers.js";
import { marketIdsFor } from "../market/marketData.js";
import { istNow, hhmmToMin, OPEN_MIN, CLOSE_MIN } from "../lab/time.js";
import { startJob, getJob } from "../backtest/jobs.js";
import { livePool } from "../workers/pool.js";
import { lru } from "../lru.js";
import * as smartapi from "../data/providers/smartapi/index.js";
import { getJwt } from "../data/providers/smartapi/auth.js";
import { ensureInstruments } from "../data/providers/smartapi/instruments.js";
import { symbolOf, intervalOf, dateOf, listOf, intOf } from "./validate.js";

const router = Router();
const bad = (msg) => new AppError(400, "BAD_REQUEST", msg);
const accountOf = (q) => ({ capital: q.capital, riskPct: q.riskPct, profitPct: q.profitPct, leverage: q.leverage, indexFilter: q.indexFilter });

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
    // The client's market clock (IST minutes) and holiday list, so it never hard-codes them.
    market: { open: OPEN_MIN, close: CLOSE_MIN, holidays: holidayDates() },
  });
});

router.get("/universes", (_req, res) => res.json(listUniverses()));
router.get("/watchlist", (_req, res) => res.json(getWatchlist()));
router.put("/watchlist", (req, res) => res.json(setWatchlist((req.body?.symbols || []).map((s) => symbolOf(s)))));

// Tests the SmartAPI login and instrument master.
router.post("/smartapi/test", async (_req, res) => {
  if (!smartapi.isConfigured()) return res.status(400).json({ ok: false, error: "Credentials missing in server/.env" });
  try {
    await getJwt();
    res.json({ ok: true, instruments: await ensureInstruments() });
  } catch (err) {
    res.status(502).json({ ok: false, error: err.message });
  }
});

// Dates that have cached candles (no network).
router.get("/sessions", async (req, res) => {
  const q = req.query;
  res.json(await livePool.run("sessions", { symbol: symbolOf(q.symbol), interval: intervalOf(q.interval), from: dateOf(q.from, "from", { optional: true }), to: dateOf(q.to, "to", { optional: true }) }));
});

// One session's candles (+ overlays, pattern markers). Uses the cache; no network.
router.get("/session", async (req, res) => {
  const q = req.query;
  res.json(
    await livePool.run("session", {
      symbol: symbolOf(q.symbol),
      interval: intervalOf(q.interval),
      date: dateOf(q.date),
      overlays: listOf(q.overlays),
      patterns: listOf(q.patterns),
      orMinutes: Number(q.orMinutes) || 15,
    })
  );
});

// Today's trade plan for every strategy on one symbol (entry / stop / target prices, open
// positions, fresh signals). Tops up the candle cache first; cheap enough to poll.
router.get("/plans", async (req, res) => {
  res.json(await livePool.run("plans", { symbol: symbolOf(req.query.symbol), interval: intervalOf(req.query.interval), account: accountOf(req.query) }));
});

// Full decision report for a strategy with a decision engine (orb, vwapBands) on one symbol:
// analysis, score, mandatory checks, and trade numbers only when the decision allows them.
// /vwap-report is the older address for strategy=vwapBands.
const decisionRoute = (fixed) => async (req, res) => {
  const strategy = fixed || String(req.query.strategy || "");
  if (!DECISION_STRATEGIES.includes(strategy)) throw bad(`strategy must be one with a decision engine: ${DECISION_STRATEGIES.join(", ")}`);
  res.json(await livePool.run("decision", { strategy, symbol: symbolOf(req.query.symbol), interval: intervalOf(req.query.interval), account: accountOf(req.query) }));
};
router.get("/decision-report", decisionRoute(null));
router.get("/vwap-report", decisionRoute("vwapBands"));

// Time Machine (server/timemachine/): Monte Carlo odds + ORB history for a long plan on 5m bars,
// or a price forecast when stop and target are both blank; analog=true weights similar mornings.
// The engine checks the plan and refuses with a code (400); only sizes are capped here.
router.post("/timemachine", async (req, res) => {
  const b = req.body || {};
  const p = b.plan || {};
  const price = (v) => (v === "" || v == null ? undefined : Number(v)); // blank = not given
  res.json(
    await livePool.run("timemachine", {
      symbol: symbolOf(b.symbol),
      plan: {
        date: dateOf(p.date, "date", { optional: true }) ?? istNow().date,
        entry: price(p.entry),
        stop: price(p.stop),
        target: price(p.target),
        entryTime: String(p.entryTime ?? ""),
        until: String(p.until || "15:15"),
      },
      options: { seed: intOf(b.seed, 19, 0, 2 ** 32 - 1), replays: intOf(b.replays, 10000, 100, 100_000), window: intOf(b.window, 2, 0, 12) },
      sessions: intOf(b.sessions, 60, 20, 250),
      analog: b.analog === true,
    })
  );
});

// Start a backtest or pattern-stats job.
router.post("/jobs", (req, res) => {
  const b = req.body || {};
  const interval = intervalOf(b.interval);
  const target = symbolOf(b.target, "target");
  const symbols = resolveTarget(target);
  if (!symbols.length) throw bad(isUniverse(target) ? "That universe is empty" : "Pick a symbol or universe");
  const from = dateOf(b.from, "from");
  const to = dateOf(b.to, "to");
  if (from > to) throw bad("from must be on or before to");
  if (b.kind === "backtest") {
    const def = STRATEGY_BY_ID[b.strategy];
    if (!def) throw bad("Unknown strategy");
    // Strategies that read the market need NIFTY 50 and each stock's sector index synced too.
    const syncExtra = def.needsMarket ? [...new Set(symbols.flatMap((s) => Object.values(marketIdsFor(s)).filter(Boolean)))] : [];
    return res.json(startJob("backtest", { symbols, interval, from, to, strategy: b.strategy, params: b.params, settings: b.settings, syncExtra }));
  }
  if (b.kind === "patterns") return res.json(startJob("patterns", { symbols, interval, from, to, patternIds: b.patternIds, horizons: b.horizons }));
  throw bad("kind must be backtest or patterns");
});

router.get("/jobs/:id", (req, res) => {
  const j = getJob(req.params.id);
  if (!j) throw new AppError(404, "NOT_FOUND", "Job not found (expired?)");
  res.json(j);
});

// Today's Top 3 + scoreboard. Returns { result } (frozen snapshot) or { job }.
const recent = lru({ max: 200, ttlMs: 4 * 60_000 }); // key -> { jobId }: reuse a job started in the last 4 minutes
// Saved results go stale when the charges or the sizing / stats rules change: bump RESULTS_V
// on a rules change; a charges change is picked up by itself.
const RESULTS_V = 2;
const resultsStamp = createHash("sha1").update(JSON.stringify({ v: RESULTS_V, COSTS, bt: LAB.backtest })).digest("hex").slice(0, 8);
router.post("/today", (req, res) => {
  const b = req.body || {};
  const target = symbolOf(b.target, "target");
  const interval = intervalOf(b.interval);
  const oosSessions = Math.min(500, Math.max(10, Number(b.oosSessions) || LAB.ranking.oosSessions));
  const symbols = resolveTarget(target);
  if (!symbols.length) throw bad("That universe is empty");

  // The trader's account (capital, risk %, profit target) sizes every backtested trade.
  const { account, settings } = accountSettings(b.account || {});
  const now = istNow();
  const key = `${target}|${interval}|${oosSessions}|${accountKey(account)}|${now.date}|${resultsStamp}`;
  if (now.minute >= hhmmToMin(LAB.ranking.freezeAt)) {
    const snap = db.prepare("SELECT json FROM today_snapshots WHERE key = ?").get(key);
    if (snap) return res.json({ result: JSON.parse(snap.json), snapshot: true });
  }
  // Reuse a recent job for the same request (unless forced).
  const r = recent.get(key);
  const prev = r && getJob(r.jobId);
  if (!b.force && prev && prev.status !== "error") return res.json({ job: prev });

  const window = Math.ceil(oosSessions / (1 - LAB.walkForward.inSampleFraction));
  const filter = settings.indexFilter && settings.indexFilter !== "off" ? settings.indexFilter : "sector";
  const job = startJob(
    "today",
    {
      symbols,
      interval,
      target,
      oosSessions,
      settings,
      syncSessions: window + LAB.context.atrDays + 10,
      syncExtra: [...new Set([MARKET_INDEX, ...symbols.map((s) => referenceIndex(s, filter))].filter(Boolean))],
    },
    {
      // Same target → same worker, where the day's window backtest is cached (ranking/today.js).
      affinity: `${target}|${interval}`,
      onDone: (result) => {
        if (result.mode === "frozen") db.prepare("INSERT OR REPLACE INTO today_snapshots (key, json, created_at) VALUES (?, ?, ?)").run(key, JSON.stringify(result), Date.now());
      },
    }
  );
  recent.set(key, { jobId: job.id });
  res.json({ job });
});

export default router;

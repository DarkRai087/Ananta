// Candle cache: reads from SQLite, tops up only the missing candles from the provider,
// falls back to cache when offline, and builds 1W / 1M bars from daily data.
// Intraday lab intervals (15m / 5m / 3m / 1m) are served from the lab store instead.
import db from "../db.js";
import * as provider from "./providers/yahoo.js";
import { ProviderError } from "./providers/errors.js";
import { getSymbol } from "./symbols.js";
import { syncIntraday, loadIntraday, sessionsBack, labSource, DataError } from "./intraday.js";
import { buildSessions } from "../lab/sessions.js";
import { computeOverlays, patternMarkers } from "../lab/overlays.js";
import { LAB } from "../config/lab.js";

// UI intervals → which stored interval they are built from (Yahoo, Phase 1).
export const UI_INTERVALS = {
  "1d": "1d",
  "1w": "1d",
  "1mo": "1d",
  "1h": "1h",
};
export const LAB_UI_INTERVALS = ["15m", "5m", "3m", "1m"];

// Don't ask the provider again if we asked this recently.
const FRESH_MS = { "1d": 10 * 60_000, "1h": 2 * 60_000 };

const IST_OFFSET_SEC = 5.5 * 3600;

const stmts = {
  lastTime: db.prepare("SELECT MAX(time) AS t FROM candles WHERE symbol = ? AND interval = ?"),
  count: db.prepare("SELECT COUNT(*) AS n FROM candles WHERE symbol = ? AND interval = ?"),
  select: db.prepare(
    "SELECT time, open, high, low, close, volume FROM candles WHERE symbol = ? AND interval = ? ORDER BY time"
  ),
  upsert: db.prepare(
    `INSERT OR REPLACE INTO candles (symbol, interval, time, open, high, low, close, volume)
     VALUES (@symbol, @interval, @time, @open, @high, @low, @close, @volume)`
  ),
  getFetched: db.prepare("SELECT fetched_at FROM fetch_log WHERE symbol = ? AND interval = ?"),
  setFetched: db.prepare("INSERT OR REPLACE INTO fetch_log (symbol, interval, fetched_at) VALUES (?, ?, ?)"),
};

export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const inFlight = new Map();

/**
 * Bring the cache for symbol+interval up to date.
 * Returns { added, warning } — warning is set when we had to fall back to cached data.
 */
export async function refreshCandles(symbol, interval, { force = false } = {}) {
  const key = `${symbol}|${interval}`;
  if (inFlight.has(key)) return inFlight.get(key);
  const p = doRefresh(symbol, interval, force).finally(() => inFlight.delete(key));
  inFlight.set(key, p);
  return p;
}

async function doRefresh(symbol, interval, force) {
  const last = stmts.lastTime.get(symbol, interval)?.t ?? null;
  const fetchedAt = stmts.getFetched.get(symbol, interval)?.fetched_at ?? 0;
  if (!force && last != null && Date.now() - fetchedAt < FRESH_MS[interval]) {
    return { added: 0, warning: null };
  }

  // Re-fetch from the last stored candle (inclusive) so a partial "today" candle gets updated.
  const from = last != null ? new Date(last * 1000) : null;

  try {
    const candles = await provider.fetchCandles(symbol, interval, { from });
    db.transaction(() => {
      for (const c of candles) stmts.upsert.run({ symbol, interval, ...c });
      stmts.setFetched.run(symbol, interval, Date.now());
    })();
    if (last == null && candles.length === 0) {
      throw new AppError(404, "NOT_FOUND", `No data found for ${symbol}`);
    }
    return { added: candles.filter((c) => last == null || c.time > last).length, warning: null };
  } catch (err) {
    if (err instanceof AppError) throw err;
    const code = err instanceof ProviderError ? err.code : "UNKNOWN";
    const hasCache = last != null;

    if (code === "NOT_FOUND") {
      if (hasCache) return { added: 0, warning: null }; // nothing new in that range
      throw new AppError(404, "NOT_FOUND", `Symbol "${symbol}" not found on ${provider.name}`);
    }
    if (code === "NETWORK") {
      if (hasCache) return { added: 0, warning: "Offline — showing cached data" };
      throw new AppError(503, "NETWORK", `No internet connection and no cached data for ${symbol}`);
    }
    if (code === "RATE_LIMIT") {
      if (hasCache) return { added: 0, warning: "Yahoo rate limit — showing cached data" };
      throw new AppError(429, "RATE_LIMIT", "Yahoo is rate limiting requests. Wait a minute and try again.");
    }
    if (hasCache) return { added: 0, warning: `Update failed (${err.message}) — showing cached data` };
    throw new AppError(502, "PROVIDER_ERROR", err.message);
  }
}

// ── Aggregation ─────────────────────────────────────────────────────────────

function bucketStart(time, interval) {
  const d = new Date(time * 1000); // daily time is 00:00 UTC of the IST date
  if (interval === "1w") {
    const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
    return time - dow * 86400;
  }
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; // 1mo
}

export function aggregate(daily, interval) {
  const out = [];
  let cur = null;
  for (const c of daily) {
    const t = bucketStart(c.time, interval);
    if (!cur || cur.time !== t) {
      cur = { time: t, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
      out.push(cur);
    } else {
      if (c.high > cur.high) cur.high = c.high;
      if (c.low < cur.low) cur.low = c.low;
      cur.close = c.close;
      cur.volume += c.volume;
    }
  }
  return out;
}

// ── Header stats ────────────────────────────────────────────────────────────

function istDay(time, interval) {
  return interval === "1d" ? time : Math.floor((time + IST_OFFSET_SEC) / 86400);
}

// Last close and change vs the previous trading day's close.
function dayStats(rows, interval) {
  if (!rows.length) return { lastClose: null, prevClose: null, change: null, changePct: null };
  const last = rows[rows.length - 1];
  const lastDay = istDay(last.time, interval);
  let prev = null;
  for (let i = rows.length - 2; i >= 0; i--) {
    if (istDay(rows[i].time, interval) !== lastDay) { prev = rows[i]; break; }
  }
  const change = prev ? last.close - prev.close : null;
  return {
    lastClose: last.close,
    prevClose: prev?.close ?? null,
    change,
    changePct: prev ? (change / prev.close) * 100 : null,
  };
}

// ── Public ──────────────────────────────────────────────────────────────────

export async function getCandles(rawSymbol, uiInterval = "1d", opts = {}) {
  const symbol = String(rawSymbol || "").trim().toUpperCase();
  if (!symbol) throw new AppError(400, "BAD_REQUEST", "Symbol is required");
  if (LAB_UI_INTERVALS.includes(uiInterval)) return getIntradayChart(symbol, uiInterval, opts);
  const base = UI_INTERVALS[uiInterval];
  if (!base) throw new AppError(400, "BAD_REQUEST", `Unknown interval "${uiInterval}"`);

  const { warning } = await refreshCandles(symbol, base);

  const rows = stmts.select.all(symbol, base);
  if (!rows.length) throw new AppError(404, "NOT_FOUND", `No data found for ${symbol}`);

  const candles = base === uiInterval ? rows : aggregate(rows, uiInterval);
  const info = getSymbol(symbol);
  const maxDays = provider.INTERVALS[base].maxDays;

  return {
    symbol,
    name: info?.name ?? symbol,
    type: info?.type ?? "EQ",
    interval: uiInterval,
    intraday: base !== "1d",
    candles,
    stats: {
      ...dayStats(rows, base),
      from: rows[0].time,
      to: rows[rows.length - 1].time,
      count: candles.length,
    },
    note: maxDays
      ? `${uiInterval} history is limited to the last ~${maxDays + 1} days by ${provider.name} (older cached bars are kept).`
      : null,
    warning,
    provider: provider.name,
  };
}

/**
 * Daily bars (Yahoo, split-adjusted, oldest first), topped up from the provider.
 * time = 00:00 UTC of the IST date. Returns { symbol, rows, warning }.
 */
export async function getDailyBars(rawSymbol) {
  const symbol = String(rawSymbol || "").trim().toUpperCase();
  if (!symbol) throw new AppError(400, "BAD_REQUEST", "Symbol is required");
  const { warning } = await refreshCandles(symbol, "1d");
  return { symbol, rows: stmts.select.all(symbol, "1d"), warning };
}

// ── Intraday (lab store) ────────────────────────────────────────────────────

/**
 * Last N sessions of 09:15–15:30 candles from the lab provider, with optional overlays
 * (opts.overlays: ids) and pattern markers (opts.patterns: detector ids).
 */
export async function getIntradayChart(symbol, interval, { overlays = [], patterns = [], orMinutes = 15 } = {}) {
  const src = labSource();
  if (!src.intervals.includes(interval)) {
    throw new AppError(400, "BAD_INTERVAL", `${src.name} doesn't provide ${interval} candles`);
  }
  const nSessions = LAB.chartSessions[interval];
  let warning = null;
  try {
    ({ warning } = await syncIntraday(symbol, interval, { fromSec: sessionsBack(nSessions) }));
  } catch (err) {
    if (err instanceof DataError) throw new AppError(err.status, err.code, err.message);
    throw err;
  }

  // One extra session in front so the first shown day still has prior-day levels.
  const all = buildSessions(loadIntraday(symbol, interval, { fromSec: sessionsBack(nSessions + 2) }));
  const shown = all.slice(-nSessions);
  const candles = shown.flatMap((s) => s.candles);
  if (!candles.length) throw new AppError(404, "NOT_FOUND", `No ${interval} data for ${symbol}`);

  const info = getSymbol(symbol);
  const intervalMin = LAB.intervals[interval];
  const maxDays = src.limits[interval];
  return {
    symbol,
    name: info?.name ?? symbol,
    type: info?.type ?? "EQ",
    interval,
    intraday: true,
    candles,
    stats: { ...dayStats(candles, interval), from: candles[0].time, to: candles[candles.length - 1].time, count: candles.length },
    note:
      `${src.name} · last ${shown.length} sessions, 09:15–15:30 IST` +
      (maxDays ? ` · ${interval} history limited to ~${maxDays} days (add SmartAPI keys for more)` : ""),
    warning,
    provider: src.name,
    sessions: shown.map((s) => ({ date: s.date, special: s.special })),
    overlays: overlays.length ? computeOverlays(shown, overlays, { intervalMin, orMinutes, symbol, interval }) : {},
    markers: patterns.length ? patternMarkers(shown, patterns) : [],
  };
}

// Chart candles: Yahoo daily bars (built up to 1W / 1M) and hourly bars, and the lab's intraday
// bars with overlays. All of them live in the one candle store (data/intraday.js), which tops
// up only what is missing and falls back to the cache when offline.
import { chartProvider as provider } from "./provider.js";
import { AppError } from "../errors.js";
import { getSymbol } from "./symbols.js";
import { syncCandles, syncIntraday, loadCandles, loadIntraday, sessionsBack, labSource } from "./intraday.js";
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

// Don't ask Yahoo again if we asked this recently (seconds). Daily history is kept from 1990.
const TTL_SEC = { "1d": 600, "1h": 120 };
const FULL_HISTORY = Date.parse("1990-01-01T00:00:00Z") / 1000;

const IST_OFFSET_SEC = 5.5 * 3600;

/** Bring Yahoo's symbol + interval up to date. Returns { added, warning } (warning = cached data shown). */
export const refreshCandles = (symbol, interval, { force = false } = {}) =>
  syncCandles(provider, symbol, interval, { fromSec: FULL_HISTORY, ttlSec: TTL_SEC[interval], force });

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

  const rows = loadCandles(provider.id, symbol, base);
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
  return { symbol, rows: loadCandles(provider.id, symbol, "1d"), warning };
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
  const { warning } = await syncIntraday(symbol, interval, { fromSec: sessionsBack(nSessions) });

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

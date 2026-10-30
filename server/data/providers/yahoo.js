// Yahoo Finance provider (Phase 1 chart; lab fallback when SmartAPI isn't configured).
// Interface (same for every provider):
//   id, name, INTERVALS { [iv]: { maxDays|null } }, LAB_INTERVALS [iv…]
//   fetchCandles(symbol, interval, { from, to, onChunk, reverse }) → [{ time, open, high, low, close, volume }]
//     time = unix seconds (UTC); for '1d' it's 00:00 UTC of the IST date. Split/bonus adjusted.
//   isConfigured() → boolean
import YahooFinance from "yahoo-finance2";
import { INDICES } from "../../config/indices.js";
import { ProviderError, sleep, isNetworkError } from "./errors.js";
import { aggregateMinutes } from "../../lab/sessions.js";

export const id = "yahoo";
export const name = "Yahoo Finance";

const yf = new YahooFinance({ suppressNotices: ["yahooSurvey", "ripHistorical"] });

export const INTERVALS = {
  "1d": { maxDays: null },
  "1h": { maxDays: 729 },
  "15m": { maxDays: 59 },
  "5m": { maxDays: 59 },
  "3m": { maxDays: 7 }, // built from 1m
  "1m": { maxDays: 7 },
};
export const LAB_INTERVALS = ["1m", "3m", "5m", "15m"];

const INDEX_TICKERS = Object.fromEntries(Object.entries(INDICES).map(([k, v]) => [k, v.yahoo]));
const IST_OFFSET_SEC = 5.5 * 3600;
const FULL_HISTORY_START = new Date("1990-01-01T00:00:00Z");

export const isConfigured = () => true;

function toYahooTicker(symbol) {
  return INDEX_TICKERS[symbol] || `${symbol}.NS`;
}

function classify(err) {
  if (err instanceof ProviderError) return err;
  const msg = String(err?.message || err);
  const status = err?.code;
  if (status === 429 || /too many requests|rate limit/i.test(msg)) return new ProviderError("RATE_LIMIT", "Yahoo rate limit hit");
  if (status === 404 || err?.name === "NotFoundError" || /no data found|delisted|not found/i.test(msg)) {
    return new ProviderError("NOT_FOUND", "Symbol not found on Yahoo Finance");
  }
  if (isNetworkError(err)) return new ProviderError("NETWORK", "Cannot reach Yahoo Finance (no internet?)");
  return new ProviderError("UNKNOWN", msg);
}

// Retry only on rate limits: 2s, 4s, 8s, 16s.
async function withBackoff(fn, retries = 4) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (raw) {
      const err = classify(raw);
      if (err.code !== "RATE_LIMIT" || attempt >= retries) throw err;
      const wait = 2000 * 2 ** attempt;
      console.warn(`[yahoo] rate limited, retrying in ${wait / 1000}s (attempt ${attempt + 1}/${retries})`);
      await sleep(wait);
    }
  }
}

function dailyKey(date) {
  const ist = new Date(date.getTime() + IST_OFFSET_SEC * 1000);
  return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()) / 1000;
}

export async function fetchCandles(symbol, interval, { from, to, onChunk } = {}) {
  if (!INTERVALS[interval]) throw new ProviderError("UNKNOWN", `Unsupported interval ${interval}`);
  if (interval === "3m") {
    const ones = await fetchCandles(symbol, "1m", { from, to });
    const out = aggregateMinutes(ones, 3);
    if (onChunk) await onChunk(out, 1, 1);
    return out;
  }

  const { maxDays } = INTERVALS[interval];
  const now = new Date();
  let period1 = from ? new Date(from) : FULL_HISTORY_START;
  if (maxDays) {
    const earliest = new Date(now.getTime() - maxDays * 86400_000);
    if (period1 < earliest) period1 = earliest;
  }
  const period2 = to ? new Date(to) : now;
  if (period1 >= period2) return [];

  const result = await withBackoff(() =>
    yf.chart(
      toYahooTicker(symbol),
      { period1, period2, interval, includePrePost: false, events: "split" },
      { validateResult: false }
    )
  );

  // chart() OHLC is split-adjusted (bonus issues are recorded as splits). adjclose would
  // also strip dividends, which we deliberately don't do.
  const byTime = new Map();
  for (const q of result?.quotes || []) {
    if (q.open == null || q.high == null || q.low == null || q.close == null) continue;
    const date = q.date instanceof Date ? q.date : new Date(q.date);
    const time = interval === "1d" ? dailyKey(date) : Math.floor(date.getTime() / 1000);
    byTime.set(time, { time, open: q.open, high: q.high, low: q.low, close: q.close, volume: q.volume ?? 0 });
  }
  const out = [...byTime.values()].sort((a, b) => a.time - b.time);
  if (onChunk) await onChunk(out, 1, 1);
  return out;
}

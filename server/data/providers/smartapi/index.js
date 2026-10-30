// Angel One SmartAPI provider. Same interface as the Yahoo provider:
//   id, name, INTERVALS, LAB_INTERVALS, isConfigured(), fetchCandles(symbol, interval, opts)
import { SMARTAPI } from "../../../config/smartapi.js";
import { ProviderError, sleep } from "../errors.js";
import { apiPost } from "./client.js";
import { getJwt, renewJwt, isConfigured as configured, credentials } from "./auth.js";
import { getToken } from "./instruments.js";
import { istDate, istHHMM } from "../../../lab/time.js";

export const id = "smartapi";
export const name = "Angel One SmartAPI";
export const INTERVALS = Object.fromEntries(Object.keys(SMARTAPI.intervals).map((k) => [k, { maxDays: null }]));
export const LAB_INTERVALS = ["1m", "3m", "5m", "15m"];
export const isConfigured = configured;

// "yyyy-MM-dd HH:mm" in IST, as SmartAPI expects.
export const fmt = (t) => `${istDate(t)} ${istHHMM(t)}`;

/**
 * Split [from, to] (unix seconds) into ranges of at most maxDays calendar days each.
 */
export function splitRange(from, to, maxDays) {
  const span = maxDays * 86400;
  const out = [];
  for (let s = from; s <= to; s += span) out.push({ from: s, to: Math.min(s + span - 60, to) });
  return out;
}

// One request with: token renewal on auth errors, exponential backoff on rate limits / network.
async function call(body) {
  const { retries, baseMs } = SMARTAPI.backoff;
  let renewed = false;
  for (let attempt = 0; ; attempt++) {
    try {
      const token = await getJwt();
      return await apiPost(SMARTAPI.endpoints.candles, body, { apiKey: credentials().apiKey, token });
    } catch (err) {
      if (err.code === "AUTH" && err.tokenError && !renewed) {
        renewed = true;
        await renewJwt();
        continue;
      }
      if ((err.code === "RATE_LIMIT" || err.code === "NETWORK") && attempt < retries) {
        const wait = baseMs * 2 ** attempt;
        console.warn(`[smartapi] ${err.code === "RATE_LIMIT" ? "rate limited" : "network error"}; retry in ${wait / 1000}s`);
        await sleep(wait);
        continue;
      }
      if (/no data/i.test(err.message)) return { data: [] };
      throw err;
    }
  }
}

export function parseRows(rows) {
  const out = [];
  for (const r of rows || []) {
    const t = Math.floor(Date.parse(r[0]) / 1000);
    if (!Number.isFinite(t) || r[1] == null) continue;
    out.push({ time: t, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] || 0 });
  }
  return out;
}

/**
 * opts: { from: Date, to: Date, onChunk(rows, k, total), reverse }
 * reverse = fetch newest chunk first (used when extending history backwards, so an
 * interruption still leaves one contiguous block).
 */
export async function fetchCandles(symbol, interval, { from, to, onChunk, reverse = false } = {}) {
  const cfg = SMARTAPI.intervals[interval];
  if (!cfg) throw new ProviderError("UNKNOWN", `SmartAPI lab intervals are 1m, 3m, 5m, 15m (got ${interval})`);
  if (!isConfigured()) throw new ProviderError("NOT_CONFIGURED", "SmartAPI credentials missing in server/.env");
  const token = await getToken(symbol);
  const f = Math.floor((from ? new Date(from) : new Date(Date.now() - 30 * 86400_000)).getTime() / 1000);
  const t = Math.floor((to ? new Date(to) : new Date()).getTime() / 1000);
  if (f >= t) return [];

  const chunks = splitRange(f, t, cfg.maxDaysPerRequest);
  if (reverse) chunks.reverse();
  const byTime = new Map();
  for (let k = 0; k < chunks.length; k++) {
    const ch = chunks[k];
    const json = await call({ exchange: "NSE", symboltoken: token, interval: cfg.code, fromdate: fmt(ch.from), todate: fmt(ch.to) });
    const rows = parseRows(json.data);
    for (const r of rows) byTime.set(r.time, r);
    if (onChunk) await onChunk(rows, k + 1, chunks.length);
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

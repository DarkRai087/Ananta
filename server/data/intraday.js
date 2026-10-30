// The candle store: every candle the app keeps (the lab's 1m–15m bars and the chart's Yahoo
// 1d / 1h bars), tagged with the provider it came from, so Yahoo and SmartAPI rows never mix.
//
// Sync rules:
//  • Older history ([from, first cached)) is fetched newest-chunk-first, so an interruption
//    still leaves one contiguous block; it's marked done only when the whole range finishes.
//  • New candles ([last cached, now]) are fetched oldest-first and saved chunk by chunk. The
//    last stored candle is fetched again, so one that was still forming gets completed.
//  • Candles are stored as received. Reads (buildSessions) keep only 09:15–15:30 or a special
//    session's window, so a special date learned late still finds its candles.
import db from "../db.js";
import { labProvider } from "./provider.js";
import { AppError, ProviderError } from "../errors.js";
import { LAB } from "../config/lab.js";

const q = {
  bounds: db.prepare("SELECT MIN(time) AS first, MAX(time) AS last FROM candles WHERE source = ? AND symbol = ? AND interval = ?"),
  upsert: db.prepare(
    `INSERT OR REPLACE INTO candles (source, symbol, interval, time, open, high, low, close, volume)
     VALUES (@source, @symbol, @interval, @time, @open, @high, @low, @close, @volume)`
  ),
  load: db.prepare(
    `SELECT time, open, high, low, close, volume FROM candles
     WHERE source = ? AND symbol = ? AND interval = ? AND time >= ? AND time <= ? ORDER BY time`
  ),
  getSync: db.prepare("SELECT earliest, fetched_at FROM candle_sync WHERE source = ? AND symbol = ? AND interval = ?"),
  setSync: db.prepare("INSERT OR REPLACE INTO candle_sync (source, symbol, interval, earliest, fetched_at) VALUES (?, ?, ?, ?, ?)"),
};

export function labSource() {
  const p = labProvider();
  return { id: p.id, name: p.name, intervals: p.LAB_INTERVALS, limits: Object.fromEntries(p.LAB_INTERVALS.map((iv) => [iv, p.INTERVALS[iv]?.maxDays ?? null])) };
}

const save = db.transaction((source, symbol, interval, rows) => {
  for (const r of rows) q.upsert.run({ source, symbol, interval, ...r });
});

const inFlight = new Map(); // source|symbol|interval -> { p, from }

/**
 * Make sure `prov`'s candles exist from opts.fromSec to now. Returns { warning, added }.
 * opts: { fromSec, force, ttlSec (min seconds between forward syncs), onProgress({ symbol, chunk, chunks }) }
 *
 * One sync per source + symbol + interval at a time: a request that a running sync already
 * covers (same or shorter history) shares its result; any other waits for it, then fetches
 * only what is still missing.
 */
export function syncCandles(prov, symbol, interval, opts = {}) {
  const key = `${prov.id}|${symbol}|${interval}`;
  const from = opts.fromSec ?? -Infinity; // no fromSec = the full default history
  const cur = inFlight.get(key);
  if (cur && !opts.force && from >= cur.from) return cur.p;
  const p = (cur ? cur.p.catch(() => {}) : Promise.resolve()).then(() => doSync(prov, symbol, interval, opts));
  const entry = { p, from };
  inFlight.set(key, entry);
  p.catch(() => {}).finally(() => inFlight.get(key) === entry && inFlight.delete(key));
  return p;
}

// The lab's candles, from the lab provider (SmartAPI, or Yahoo without keys).
export const syncIntraday = (symbol, interval, opts) => syncCandles(labProvider(), symbol, interval, opts);

async function doSync(prov, symbol, interval, { fromSec, force = false, ttlSec = LAB.syncTtlSec, onProgress } = {}) {
  const src = prov.id;
  if (!prov.INTERVALS[interval]) throw new AppError(400, "BAD_INTERVAL", `${prov.name} doesn't provide ${interval} candles`);
  const now = Math.floor(Date.now() / 1000);
  const maxDays = prov.INTERVALS[interval].maxDays;
  let from = fromSec ?? now - LAB.backfillYears * 365 * 86400;
  if (maxDays) from = Math.max(from, now - maxDays * 86400);

  const { first, last } = q.bounds.get(src, symbol, interval);
  const sync = q.getSync.get(src, symbol, interval) || { earliest: null, fetched_at: 0 };
  const tasks = [];
  if (last == null) {
    tasks.push({ kind: "older", from, to: now });
  } else {
    if (from < first && (sync.earliest == null || from < sync.earliest)) tasks.push({ kind: "older", from, to: first });
    if (force || now - (sync.fetched_at || 0) > ttlSec) tasks.push({ kind: "newer", from: last, to: now });
  }
  if (!tasks.length) return { warning: null, added: 0 };

  let added = 0;
  try {
    for (const t of tasks) {
      await prov.fetchCandles(symbol, interval, {
        from: new Date(t.from * 1000),
        to: new Date(t.to * 1000),
        reverse: t.kind === "older",
        onChunk: (rows, k, total) => {
          save(src, symbol, interval, rows);
          added += rows.length;
          onProgress?.({ symbol, chunk: k, chunks: total });
        },
      });
      const cur = q.getSync.get(src, symbol, interval) || { earliest: null, fetched_at: 0 };
      if (t.kind === "older") q.setSync.run(src, symbol, interval, Math.min(cur.earliest ?? t.from, t.from), last == null ? now : cur.fetched_at);
      else q.setSync.run(src, symbol, interval, cur.earliest ?? first, now);
    }
    return { warning: null, added };
  } catch (err) {
    const code = err instanceof ProviderError ? err.code : "UNKNOWN";
    if (code === "AUTH") throw err;
    if (q.bounds.get(src, symbol, interval).last != null) {
      if (code === "NOT_FOUND") return { warning: null, added }; // nothing new in that range
      const why = code === "NETWORK" ? "Offline" : code === "RATE_LIMIT" ? "Rate limited" : `Update failed (${err.message})`;
      return { warning: `${why} — showing cached data`, added };
    }
    const msg = {
      NOT_FOUND: `${symbol}: ${err.message}`,
      NETWORK: `No internet and no cached ${interval} data for ${symbol}`,
      RATE_LIMIT: `${prov.name} is rate limiting requests. Try again in a minute.`,
    }[code];
    throw new AppError(err.status ?? 502, code === "UNKNOWN" ? "PROVIDER_ERROR" : code, msg ?? err.message);
  }
}

export function loadCandles(source, symbol, interval, { fromSec = 0, toSec = 4e9 } = {}) {
  return q.load.all(source, symbol, interval, fromSec, toSec);
}

export const loadIntraday = (symbol, interval, range) => loadCandles(labProvider().id, symbol, interval, range);

// Rough unix-seconds start that covers the last `sessions` trading days (+ margin).
export function sessionsBack(sessions, nowSec = Math.floor(Date.now() / 1000)) {
  return nowSec - Math.ceil(sessions * 1.5 + 7) * 86400;
}

export function cachedBounds(symbol, interval) {
  return q.bounds.get(labProvider().id, symbol, interval);
}

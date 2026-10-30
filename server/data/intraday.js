// Intraday candle store for the lab (1m / 3m / 5m / 15m). Rows are tagged with the provider
// they came from, so switching Yahoo ↔ SmartAPI never mixes the two.
//
// Sync rules:
//  • Older history ([from, first cached)) is fetched newest-chunk-first, so an interruption
//    still leaves one contiguous block; it's marked done only when the whole range finishes.
//  • New candles ([last cached, now]) are fetched oldest-first and saved chunk by chunk.
//  • Candles are stored as received. Reads (buildSessions) keep only 09:15–15:30 or a special
//    session's window, so a special date learned late still finds its candles.
import db from "../db.js";
import { labProvider, ProviderError } from "./provider.js";
import { LAB } from "../config/lab.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS lab_candles (
    source   TEXT    NOT NULL,
    symbol   TEXT    NOT NULL,
    interval TEXT    NOT NULL,
    time     INTEGER NOT NULL,
    open REAL, high REAL, low REAL, close REAL, volume REAL,
    PRIMARY KEY (source, symbol, interval, time)
  ) WITHOUT ROWID;

  CREATE TABLE IF NOT EXISTS lab_sync (
    source     TEXT NOT NULL,
    symbol     TEXT NOT NULL,
    interval   TEXT NOT NULL,
    earliest   INTEGER,          -- oldest 'from' fully fetched
    fetched_at INTEGER,          -- last forward sync (unix s)
    PRIMARY KEY (source, symbol, interval)
  );
`);

const q = {
  bounds: db.prepare("SELECT MIN(time) AS first, MAX(time) AS last FROM lab_candles WHERE source = ? AND symbol = ? AND interval = ?"),
  upsert: db.prepare(
    `INSERT OR REPLACE INTO lab_candles (source, symbol, interval, time, open, high, low, close, volume)
     VALUES (@source, @symbol, @interval, @time, @open, @high, @low, @close, @volume)`
  ),
  load: db.prepare(
    `SELECT time, open, high, low, close, volume FROM lab_candles
     WHERE source = ? AND symbol = ? AND interval = ? AND time >= ? AND time <= ? ORDER BY time`
  ),
  getSync: db.prepare("SELECT earliest, fetched_at FROM lab_sync WHERE source = ? AND symbol = ? AND interval = ?"),
  setSync: db.prepare("INSERT OR REPLACE INTO lab_sync (source, symbol, interval, earliest, fetched_at) VALUES (?, ?, ?, ?, ?)"),
};

export class DataError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function labSource() {
  const p = labProvider();
  return { id: p.id, name: p.name, intervals: p.LAB_INTERVALS, limits: Object.fromEntries(p.LAB_INTERVALS.map((iv) => [iv, p.INTERVALS[iv]?.maxDays ?? null])) };
}

function save(source, symbol, interval, rows) {
  db.transaction(() => {
    for (const r of rows) q.upsert.run({ source, symbol, interval, ...r });
  })();
}

const inFlight = new Map(); // symbol|interval -> { p, from }

/**
 * Make sure candles exist from `fromSec` to now. Returns { warning, added }.
 * onProgress({ symbol, chunk, chunks }) is called per provider chunk.
 *
 * One sync per symbol + interval at a time: a request that a running sync already covers
 * (same or shorter history) shares its result; any other waits for it, then fetches only
 * what is still missing.
 */
export function syncIntraday(symbol, interval, opts = {}) {
  const key = `${symbol}|${interval}`;
  const from = opts.fromSec ?? -Infinity; // no fromSec = the full default history
  const cur = inFlight.get(key);
  if (cur && !opts.force && from >= cur.from) return cur.p;
  const p = (cur ? cur.p.catch(() => {}) : Promise.resolve()).then(() => doSync(symbol, interval, opts));
  const entry = { p, from };
  inFlight.set(key, entry);
  p.catch(() => {}).finally(() => inFlight.get(key) === entry && inFlight.delete(key));
  return p;
}

async function doSync(symbol, interval, { fromSec, force = false, onProgress } = {}) {
  const prov = labProvider();
  const src = prov.id;
  if (!prov.LAB_INTERVALS.includes(interval)) {
    throw new DataError(400, "BAD_INTERVAL", `${prov.name} doesn't provide ${interval} candles`);
  }
  const now = Math.floor(Date.now() / 1000);
  const maxDays = prov.INTERVALS[interval]?.maxDays;
  let from = fromSec ?? now - LAB.backfillYears * 365 * 86400;
  if (maxDays) from = Math.max(from, now - maxDays * 86400);

  const { first, last } = q.bounds.get(src, symbol, interval);
  const sync = q.getSync.get(src, symbol, interval) || { earliest: null, fetched_at: 0 };
  const tasks = [];
  if (last == null) {
    tasks.push({ kind: "older", from, to: now });
  } else {
    if (from < first && (sync.earliest == null || from < sync.earliest)) tasks.push({ kind: "older", from, to: first });
    if (force || now - (sync.fetched_at || 0) > LAB.syncTtlSec) tasks.push({ kind: "newer", from: last, to: now });
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
    const hasCache = q.bounds.get(src, symbol, interval).last != null;
    const code = err instanceof ProviderError ? err.code : "UNKNOWN";
    if (code === "NOT_FOUND" && !hasCache) throw new DataError(404, "NOT_FOUND", `${symbol}: ${err.message}`);
    if (code === "AUTH" || (code === "NOT_CONFIGURED" && !hasCache)) throw new DataError(401, code, err.message);
    if (!hasCache) {
      if (code === "NETWORK") throw new DataError(503, "NETWORK", `No internet and no cached ${interval} data for ${symbol}`);
      if (code === "RATE_LIMIT") throw new DataError(429, "RATE_LIMIT", `${prov.name} is rate limiting requests. Try again in a minute.`);
      throw new DataError(502, "PROVIDER_ERROR", err.message);
    }
    const why = code === "NETWORK" ? "Offline" : code === "RATE_LIMIT" ? "Rate limited" : `Update failed (${err.message})`;
    return { warning: `${why} — showing cached data`, added };
  }
}

export function loadIntraday(symbol, interval, { fromSec = 0, toSec = 4e9 } = {}) {
  return q.load.all(labProvider().id, symbol, interval, fromSec, toSec);
}

// Rough unix-seconds start that covers the last `sessions` trading days (+ margin).
export function sessionsBack(sessions, nowSec = Math.floor(Date.now() / 1000)) {
  return nowSec - Math.ceil(sessions * 1.5 + 7) * 86400;
}

export function cachedBounds(symbol, interval) {
  return q.bounds.get(labProvider().id, symbol, interval);
}

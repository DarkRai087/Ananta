// SQLite setup. One file (server/cache.db) holds the symbol list and every cached candle.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "cache.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS symbols (
    symbol  TEXT PRIMARY KEY,          -- NSE symbol, e.g. RELIANCE (or NIFTY50 for indices)
    name    TEXT NOT NULL,
    series  TEXT,
    isin    TEXT,
    type    TEXT NOT NULL DEFAULT 'EQ' -- 'EQ' or 'INDEX'
  );

  -- time = unix seconds (UTC). For daily candles it is 00:00 UTC of the IST trading date.
  CREATE TABLE IF NOT EXISTS candles (
    symbol   TEXT    NOT NULL,
    interval TEXT    NOT NULL,         -- '1d', '1h', '15m', '5m'
    time     INTEGER NOT NULL,
    open     REAL, high REAL, low REAL, close REAL, volume REAL,
    PRIMARY KEY (symbol, interval, time)
  ) WITHOUT ROWID;

  -- When we last asked the provider for a symbol+interval (avoids hitting it on every load).
  CREATE TABLE IF NOT EXISTS fetch_log (
    symbol     TEXT NOT NULL,
    interval   TEXT NOT NULL,
    fetched_at INTEGER NOT NULL,       -- unix ms
    PRIMARY KEY (symbol, interval)
  );

  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
  );

  -- Progress for the bulk fetch-all script, so it can resume after an interruption.
  CREATE TABLE IF NOT EXISTS bulk_progress (
    symbol     TEXT PRIMARY KEY,
    status     TEXT NOT NULL,          -- 'done' | 'failed'
    message    TEXT,
    updated_at INTEGER NOT NULL
  );
`);

export function getMeta(key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(value));
}

export default db;

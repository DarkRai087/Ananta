// SQLite setup. One file (server/cache.db) holds every candle, list and cached session.
// This file owns the whole schema. To change it, append a migration: old databases run the
// ones they haven't seen (PRAGMA user_version counts them); never edit a migration once shipped.
import Database from "better-sqlite3";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, "cache.db");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

const MIGRATIONS = [
  // 1. The original schema (IF NOT EXISTS: databases from before migrations already have it).
  `CREATE TABLE IF NOT EXISTS symbols (
     symbol TEXT PRIMARY KEY,           -- NSE symbol, e.g. RELIANCE (or NIFTY50 for indices)
     name   TEXT NOT NULL,
     series TEXT,
     isin   TEXT,
     type   TEXT NOT NULL DEFAULT 'EQ'  -- 'EQ' or 'INDEX'
   );
   CREATE TABLE IF NOT EXISTS candles (
     symbol TEXT NOT NULL, interval TEXT NOT NULL, time INTEGER NOT NULL,
     open REAL, high REAL, low REAL, close REAL, volume REAL,
     PRIMARY KEY (symbol, interval, time)
   ) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS fetch_log (
     symbol TEXT NOT NULL, interval TEXT NOT NULL, fetched_at INTEGER NOT NULL,
     PRIMARY KEY (symbol, interval)
   );
   CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
   CREATE TABLE IF NOT EXISTS bulk_progress (
     symbol TEXT PRIMARY KEY, status TEXT NOT NULL, message TEXT, updated_at INTEGER NOT NULL
   );
   CREATE TABLE IF NOT EXISTS lab_candles (
     source TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL, time INTEGER NOT NULL,
     open REAL, high REAL, low REAL, close REAL, volume REAL,
     PRIMARY KEY (source, symbol, interval, time)
   ) WITHOUT ROWID;
   CREATE TABLE IF NOT EXISTS lab_sync (
     source TEXT NOT NULL, symbol TEXT NOT NULL, interval TEXT NOT NULL,
     earliest INTEGER, fetched_at INTEGER,
     PRIMARY KEY (source, symbol, interval)
   );
   CREATE TABLE IF NOT EXISTS holidays (date TEXT PRIMARY KEY, description TEXT, special INTEGER NOT NULL DEFAULT 0);
   CREATE TABLE IF NOT EXISTS universe_members (
     universe TEXT NOT NULL, symbol TEXT NOT NULL, name TEXT, PRIMARY KEY (universe, symbol)
   );
   CREATE TABLE IF NOT EXISTS watchlist (symbol TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS smartapi_instruments (
     symbol TEXT PRIMARY KEY, token TEXT NOT NULL, trading_symbol TEXT, name TEXT, tick_size REAL
   );
   CREATE TABLE IF NOT EXISTS today_snapshots (key TEXT PRIMARY KEY, json TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS rate_stamps (name TEXT NOT NULL, t INTEGER NOT NULL);
   CREATE INDEX IF NOT EXISTS rate_stamps_name_t ON rate_stamps (name, t);`,

  // 2. One candle store. The chart's Yahoo daily / hourly bars move into the lab store as
  // source 'yahoo' (their history was fetched in full, from 1990), then the tables get plain names:
  //   candles     (source, symbol, interval, time) → OHLCV; time = unix s (daily: 00:00 UTC of the IST date)
  //   candle_sync (source, symbol, interval) → earliest fully fetched 'from', last forward sync (unix s)
  `INSERT OR IGNORE INTO lab_candles SELECT 'yahoo', symbol, interval, time, open, high, low, close, volume FROM candles;
   INSERT OR REPLACE INTO lab_sync SELECT 'yahoo', symbol, interval, 631152000, fetched_at / 1000 FROM fetch_log;
   DROP TABLE candles;
   DROP TABLE fetch_log;
   ALTER TABLE lab_candles RENAME TO candles;
   ALTER TABLE lab_sync RENAME TO candle_sync;`,
];

for (let v = db.pragma("user_version", { simple: true }); v < MIGRATIONS.length; v++) {
  db.transaction(() => {
    db.exec(MIGRATIONS[v]);
    db.pragma(`user_version = ${v + 1}`);
  })();
}

// Housekeeping: Today snapshots are only read on their own day.
db.prepare("DELETE FROM today_snapshots WHERE created_at < ?").run(Date.now() - 7 * 86400_000);

export function getMeta(key) {
  return db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
}

export function setMeta(key, value) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)").run(key, String(value));
}

export default db;

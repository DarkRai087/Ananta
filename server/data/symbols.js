// NSE symbol list: downloaded from NSE archives, stored in SQLite, searched for autocomplete.
import db, { getMeta, setMeta } from "../db.js";
import { INDICES as INDEX_CONFIG } from "../config/indices.js";
import { fetchNseCsv } from "./nse.js";

const NSE_EQUITY_CSV = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const REFRESH_DAYS = 7;

export const INDICES = Object.entries(INDEX_CONFIG).map(([symbol, v]) => ({ symbol, name: v.name, type: "INDEX" }));

async function downloadEquityList() {
  const rows = await fetchNseCsv(NSE_EQUITY_CSV);
  if (!rows.length || !("SYMBOL" in rows[0]) || !("NAME OF COMPANY" in rows[0])) throw new Error("Unexpected NSE CSV format");
  return rows.filter((r) => r.SYMBOL).map((r) => ({ symbol: r.SYMBOL, name: r["NAME OF COMPANY"], series: r.SERIES ?? null, isin: r["ISIN NUMBER"] ?? null }));
}

function upsertIndices() {
  const stmt = db.prepare(
    "INSERT OR REPLACE INTO symbols (symbol, name, series, isin, type) VALUES (?, ?, NULL, NULL, 'INDEX')"
  );
  for (const i of INDICES) stmt.run(i.symbol, i.name);
}

// Download the list on first run (or if older than a week). Safe to call on every start.
export async function ensureSymbolList({ force = false } = {}) {
  upsertIndices();
  const count = db.prepare("SELECT COUNT(*) AS n FROM symbols WHERE type = 'EQ'").get().n;
  const loadedAt = Number(getMeta("symbols_loaded_at") || 0);
  const stale = Date.now() - loadedAt > REFRESH_DAYS * 86400_000;
  if (!force && count > 0 && !stale) return count;

  try {
    const rows = await downloadEquityList();
    const insert = db.prepare(
      "INSERT OR REPLACE INTO symbols (symbol, name, series, isin, type) VALUES (?, ?, ?, ?, 'EQ')"
    );
    db.transaction(() => {
      for (const r of rows) insert.run(r.symbol, r.name, r.series, r.isin);
    })();
    setMeta("symbols_loaded_at", Date.now());
    console.log(`[symbols] loaded ${rows.length} NSE equities`);
    return rows.length;
  } catch (err) {
    if (count > 0) {
      console.warn(`[symbols] refresh failed (${err.message}); keeping ${count} cached symbols`);
      return count;
    }
    console.error(`[symbols] could not download NSE equity list: ${err.message}`);
    return 0;
  }
}

export function searchSymbols(q, limit = 20) {
  const query = String(q || "").trim().toUpperCase();
  if (!query) {
    return db.prepare("SELECT symbol, name, type FROM symbols WHERE type = 'INDEX' ORDER BY symbol").all();
  }
  // Rank: exact symbol > symbol prefix > name prefix > symbol/name contains. Indices first on ties.
  return db
    .prepare(
      `SELECT symbol, name, type,
         CASE
           WHEN symbol = @q THEN 0
           WHEN symbol LIKE @prefix ESCAPE '\\' THEN 1
           WHEN UPPER(name) LIKE @prefix ESCAPE '\\' THEN 2
           ELSE 3
         END AS rank
       FROM symbols
       WHERE symbol LIKE @contains ESCAPE '\\' OR UPPER(name) LIKE @contains ESCAPE '\\'
       ORDER BY rank, (type = 'INDEX') DESC, LENGTH(symbol), symbol
       LIMIT @limit`
    )
    .all({
      q: query,
      prefix: escapeLike(query) + "%",
      contains: "%" + escapeLike(query) + "%",
      limit,
    })
    .map(({ rank, ...r }) => r);
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

export function getSymbol(symbol) {
  return db.prepare("SELECT symbol, name, type FROM symbols WHERE symbol = ?").get(symbol) || null;
}

export function allEquitySymbols() {
  return db.prepare("SELECT symbol FROM symbols WHERE type = 'EQ' ORDER BY symbol").all().map((r) => r.symbol);
}

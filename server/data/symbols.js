// NSE symbol list: downloaded from NSE archives, stored in SQLite, searched for autocomplete.
import db, { getMeta, setMeta } from "../db.js";
import { INDICES as INDEX_CONFIG } from "../config/indices.js";

const NSE_EQUITY_CSV = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv";
const REFRESH_DAYS = 7;

export const INDICES = Object.entries(INDEX_CONFIG).map(([symbol, v]) => ({ symbol, name: v.name, type: "INDEX" }));

// Minimal CSV line parser that handles quoted fields with commas.
function parseCsvLine(line) {
  const out = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (c === '"') inQuotes = false;
      else cur += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ",") { out.push(cur.trim()); cur = ""; }
    else cur += c;
  }
  out.push(cur.trim());
  return out;
}

async function downloadEquityList() {
  const res = await fetch(NSE_EQUITY_CSV, {
    headers: {
      // NSE rejects requests without a browser-like User-Agent.
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
      Accept: "text/csv,*/*",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`NSE returned HTTP ${res.status}`);
  const text = await res.text();

  const lines = text.split(/\r?\n/).filter(Boolean);
  const header = parseCsvLine(lines.shift()).map((h) => h.toUpperCase());
  const iSym = header.indexOf("SYMBOL");
  const iName = header.indexOf("NAME OF COMPANY");
  const iSeries = header.indexOf("SERIES");
  const iIsin = header.indexOf("ISIN NUMBER");
  if (iSym < 0 || iName < 0) throw new Error("Unexpected NSE CSV format");

  return lines
    .map(parseCsvLine)
    .filter((f) => f[iSym])
    .map((f) => ({ symbol: f[iSym], name: f[iName], series: f[iSeries] ?? null, isin: f[iIsin] ?? null }));
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

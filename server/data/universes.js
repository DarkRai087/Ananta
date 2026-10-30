// Universes: NIFTY 50 and NIFTY 100 (constituents from NSE, refreshed weekly) and a custom watchlist.
import db, { getMeta, setMeta } from "../db.js";

db.exec(`
  CREATE TABLE IF NOT EXISTS universe_members (
    universe TEXT NOT NULL,
    symbol   TEXT NOT NULL,
    name     TEXT,
    PRIMARY KEY (universe, symbol)
  );
  CREATE TABLE IF NOT EXISTS watchlist (
    symbol   TEXT PRIMARY KEY,
    added_at INTEGER NOT NULL
  );
`);

export const UNIVERSES = {
  NIFTY50: { name: "NIFTY 50", url: "https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv", index: "NIFTY50" },
  NIFTY100: { name: "NIFTY 100", url: "https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv", index: null },
  WATCHLIST: { name: "Watchlist" },
};

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export async function downloadNseList(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/csv,*/*" }, signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const lines = (await res.text()).trim().split(/\r?\n/);
  const header = lines.shift().split(",").map((h) => h.trim().toUpperCase());
  const iSym = header.indexOf("SYMBOL");
  const iName = header.indexOf("COMPANY NAME");
  return lines.map((l) => l.split(",")).filter((f) => f[iSym]).map((f) => ({ symbol: f[iSym].trim(), name: f[iName]?.trim() }));
}

export async function ensureUniverses({ force = false } = {}) {
  for (const [id, u] of Object.entries(UNIVERSES)) {
    if (!u.url) continue;
    const count = db.prepare("SELECT COUNT(*) AS n FROM universe_members WHERE universe = ?").get(id).n;
    const at = Number(getMeta(`universe_${id}_at`) || 0);
    if (!force && count > 0 && Date.now() - at < 7 * 86400_000) continue;
    try {
      const rows = await downloadNseList(u.url);
      const ins = db.prepare("INSERT INTO universe_members (universe, symbol, name) VALUES (?, ?, ?)");
      db.transaction(() => {
        db.prepare("DELETE FROM universe_members WHERE universe = ?").run(id);
        for (const r of rows) ins.run(id, r.symbol, r.name);
      })();
      setMeta(`universe_${id}_at`, Date.now());
      console.log(`[universes] ${u.name}: ${rows.length} symbols`);
    } catch (err) {
      console.warn(`[universes] ${u.name} refresh failed (${err.message})${count ? "; keeping cached list" : ""}`);
    }
  }
}

export function universeSymbols(id) {
  if (id === "WATCHLIST") return getWatchlist();
  return db.prepare("SELECT symbol FROM universe_members WHERE universe = ? ORDER BY symbol").all(id).map((r) => r.symbol);
}

export function listUniverses() {
  return Object.entries(UNIVERSES).map(([id, u]) => ({ id, name: u.name, count: universeSymbols(id).length }));
}

export function isUniverse(target) {
  return Object.prototype.hasOwnProperty.call(UNIVERSES, String(target).toUpperCase());
}

// "RELIANCE" → ["RELIANCE"]; "NIFTY50" (a universe) → its constituents.
export function resolveTarget(target, { includeIndex = false } = {}) {
  const t = String(target || "").trim().toUpperCase();
  if (isUniverse(t)) {
    const syms = universeSymbols(t);
    const idx = UNIVERSES[t].index;
    return includeIndex && idx ? [idx, ...syms] : syms;
  }
  return t ? [t] : [];
}

export function getWatchlist() {
  return db.prepare("SELECT symbol FROM watchlist ORDER BY added_at, symbol").all().map((r) => r.symbol);
}

export function setWatchlist(symbols) {
  const clean = [...new Set((symbols || []).map((s) => String(s).trim().toUpperCase()).filter(Boolean))];
  const ins = db.prepare("INSERT INTO watchlist (symbol, added_at) VALUES (?, ?)");
  db.transaction(() => {
    db.prepare("DELETE FROM watchlist").run();
    clean.forEach((s, k) => ins.run(s, Date.now() + k));
  })();
  return clean;
}

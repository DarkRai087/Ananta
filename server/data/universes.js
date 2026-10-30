// Universes: NIFTY 50 and NIFTY 100 (constituents from NSE, refreshed weekly) and a custom watchlist.
import db, { getMeta, setMeta } from "../db.js";
import { fetchNseCsv } from "./nse.js";

export const UNIVERSES = {
  NIFTY50: { name: "NIFTY 50", url: "https://nsearchives.nseindia.com/content/indices/ind_nifty50list.csv", index: "NIFTY50" },
  NIFTY100: { name: "NIFTY 100", url: "https://nsearchives.nseindia.com/content/indices/ind_nifty100list.csv", index: null },
  WATCHLIST: { name: "Watchlist" },
};

export async function downloadNseList(url) {
  return (await fetchNseCsv(url)).filter((r) => r.SYMBOL).map((r) => ({ symbol: r.SYMBOL, name: r["COMPANY NAME"] }));
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

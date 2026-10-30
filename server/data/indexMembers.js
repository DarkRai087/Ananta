// Which indices a stock belongs to (NSE constituent lists, refreshed weekly, cached in SQLite).
import db, { getMeta, setMeta } from "../db.js";
import { INDICES, MARKET_INDEX, isIndexSymbol } from "../config/indices.js";
import { downloadNseList } from "./universes.js";

const key = (id) => `IDX:${id}`;

export async function ensureIndexMembers({ force = false } = {}) {
  for (const [id, ix] of Object.entries(INDICES)) {
    const count = db.prepare("SELECT COUNT(*) AS n FROM universe_members WHERE universe = ?").get(key(id)).n;
    const at = Number(getMeta(`index_members_${id}_at`) || 0);
    if (!force && count > 0 && Date.now() - at < 7 * 86400_000) continue;
    try {
      const rows = await downloadNseList(ix.members);
      const ins = db.prepare("INSERT OR REPLACE INTO universe_members (universe, symbol, name) VALUES (?, ?, ?)");
      db.transaction(() => {
        db.prepare("DELETE FROM universe_members WHERE universe = ?").run(key(id));
        for (const r of rows) ins.run(key(id), r.symbol, r.name);
      })();
      setMeta(`index_members_${id}_at`, Date.now());
    } catch (err) {
      console.warn(`[indices] ${ix.name} members refresh failed (${err.message})${count ? "; keeping cached list" : ""}`);
    }
  }
}

// Index ids the symbol is a member of, in config order.
export function indicesOf(symbol) {
  const s = String(symbol || "").toUpperCase();
  const rows = db.prepare("SELECT universe FROM universe_members WHERE symbol = ? AND universe LIKE 'IDX:%'").all(s);
  const set = new Set(rows.map((r) => r.universe.slice(4)));
  return Object.keys(INDICES).filter((id) => set.has(id));
}

/**
 * The index a stock is compared with.
 *   choice "sector" → its first sector index, else NIFTY 50.  "market" → NIFTY 50.  Or an index id.
 * An index symbol is compared with NIFTY 50 (NIFTY 50 itself: null — nothing above it).
 */
export function referenceIndex(symbol, choice = "sector") {
  const s = String(symbol || "").toUpperCase();
  if (isIndexSymbol(s)) return s === MARKET_INDEX ? null : MARKET_INDEX;
  if (choice && INDICES[choice]) return choice;
  if (choice === "market") return MARKET_INDEX;
  const sector = indicesOf(s).find((id) => INDICES[id].kind === "sector");
  return sector || MARKET_INDEX;
}

export const indexName = (id) => INDICES[id]?.name ?? id;

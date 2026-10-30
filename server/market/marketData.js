// Loads NIFTY 50 and a stock's sector index from SQLite and attaches them to its sessions
// (market/marketContext.js). Sync the indices first; this never touches the network.
import { MARKET_INDEX, isIndexSymbol } from "../config/indices.js";
import { referenceIndex } from "../data/indexMembers.js";
import { loadIntraday, cachedBounds } from "../data/intraday.js";
import { buildSessions } from "../lab/sessions.js";
import { istEpoch } from "../lab/time.js";
import { attachMarket } from "./marketContext.js";

// The indices a symbol is compared with: NIFTY 50, plus its own sector index if it has one.
export function marketIdsFor(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (isIndexSymbol(s)) return { niftyId: s === MARKET_INDEX ? null : MARKET_INDEX, sectorId: null };
  const sec = referenceIndex(s, "sector");
  return { niftyId: MARKET_INDEX, sectorId: sec && sec !== MARKET_INDEX ? sec : null };
}

// Index sessions per id|interval|from|last cached bar: a backtest or ranking run reuses them, and
// a new live bar (the server runs all day) makes a new key.
const cache = new Map();

function indexSessions(id, interval, from) {
  if (!id) return [];
  let last = 0;
  try {
    last = cachedBounds(id, interval)?.last ?? 0;
  } catch {
    /* no bounds: load anyway */
  }
  const key = `${id}|${interval}|${from}|${last}`;
  if (!cache.has(key)) {
    const fromSec = from ? istEpoch(from) - 10 * 86400 : 0; // a few days early so the first session has its previous close
    cache.set(key, buildSessions(loadIntraday(id, interval, { fromSec })).filter((x) => !x.special));
    if (cache.size > 40) cache.delete(cache.keys().next().value);
  }
  return cache.get(key);
}

export function clearMarketCache() {
  cache.clear();
}

// Loads the indices for `symbol` and attaches them to `sessions`.
export function attachMarketFor(symbol, interval, sessions, { from = null } = {}) {
  const { niftyId, sectorId } = marketIdsFor(symbol);
  const start = from ?? sessions[0]?.date ?? null;
  return attachMarket(sessions, { nifty: indexSessions(niftyId, interval, start), sector: indexSessions(sectorId, interval, start), niftyId, sectorId });
}

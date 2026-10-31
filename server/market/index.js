// Market module: which index a share belongs to, how closely it follows it, and what that
// index is doing right now.
//
//   config/indices.js       the indices (feeds, NSE member lists) + the filter rule
//   data/indexMembers.js    membership, and which index a stock is compared with
//   market/indexLink.js     index direction bar by bar (the "trade with the index" filter)
//   market/relation.js      correlation / beta / same-direction days
//   market/index.js         this file: data loading + the public indexLink()
import { LAB } from "../config/lab.js";
import { INDICES, MARKET_INDEX, isIndexSymbol } from "../config/indices.js";
import { indicesOf, referenceIndex, indexName } from "../data/indexMembers.js";
import { getDailyBars } from "../data/candles.js";
import { syncIntraday, sessionsBack } from "../data/intraday.js";
import { loadSessions } from "../backtest/run.js";
import { istNow, istDate } from "../lab/time.js";
import { dailyRelation, intradayRelation } from "./relation.js";
import { indexState } from "./indexLink.js";
import { lru } from "../lru.js";

const RELATION_SESSIONS = 60;
const cache = lru({ max: 300 }); // relation stats per symbol|index|interval|date (they change once a day)

async function relationFor(symbol, id, interval, now) {
  const key = `${symbol}|${id}|${interval}|${now.date}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const out = { daily: null, intraday: null, errors: [] };
  try {
    const [s, ix] = await Promise.all([getDailyBars(symbol), getDailyBars(id)]);
    out.daily = dailyRelation(s.rows, ix.rows);
  } catch (err) {
    out.errors.push(`daily: ${err.message}`);
  }
  try {
    const from = istDate(sessionsBack(RELATION_SESSIONS + 5, now.t));
    const ss = loadSessions(symbol, interval, { from }).filter((x) => !x.special && x.date < now.date);
    const xs = loadSessions(id, interval, { from }).filter((x) => !x.special && x.date < now.date);
    out.intraday = intradayRelation(ss, xs, RELATION_SESSIONS);
  } catch (err) {
    out.errors.push(`intraday: ${err.message}`);
  }
  cache.set(key, out);
  return out;
}

/**
 * indexLink(symbol) → { symbol, isIndex, member: [{id, name}], sector, compareDefault,
 *   indices: [{ id, name, role, daily, intraday, now }] }
 * role: "sector" (its own sector index) | "market" (NIFTY 50).
 */
export async function indexLink(rawSymbol, { interval = LAB.defaultInterval, nowMs = Date.now() } = {}) {
  const symbol = String(rawSymbol || "").trim().toUpperCase();
  const now = istNow(nowMs);
  const member = indicesOf(symbol);
  const sector = isIndexSymbol(symbol) ? null : referenceIndex(symbol, "sector");
  const ids = [...new Set([sector !== MARKET_INDEX ? sector : null, symbol !== MARKET_INDEX ? MARKET_INDEX : null].filter(Boolean))];

  const indices = [];
  for (const id of ids) {
    try {
      await syncIntraday(id, interval, { fromSec: sessionsBack(RELATION_SESSIONS + 10, now.t) });
    } catch {
      /* keep going with what's cached */
    }
    const rel = await relationFor(symbol, id, interval, now);
    const recent = loadSessions(id, interval, { from: istDate(sessionsBack(5, now.t)) }).filter((x) => !x.special && x.date <= now.date);
    indices.push({ id, name: indexName(id), role: INDICES[id].kind === "sector" ? "sector" : "market", ...rel, now: indexState(recent[recent.length - 1], id) });
  }
  return {
    symbol,
    isIndex: isIndexSymbol(symbol),
    member: member.map((id) => ({ id, name: indexName(id) })),
    sector: sector && sector !== MARKET_INDEX ? { id: sector, name: indexName(sector) } : null,
    indices,
  };
}

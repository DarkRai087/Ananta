// A stock's link to its index: the index's direction bar by bar (for the "trade with the
// index" filter) and its state right now. Direction at a bar uses only index bars that had
// closed by then, so the filter never sees the future.
import { vwap } from "../lab/indicators.js";
import { INDEX_FILTER, INDICES } from "../config/indices.js";

// +1 up, −1 down, 0 mixed, for each bar of one index session.
export function indexDirs(ix, rule = INDEX_FILTER.rule) {
  const cs = ix.candles;
  const vw = vwap(cs);
  const pdc = ix.prev?.close ?? null;
  return cs.map((c, k) => {
    const v = Math.sign(c.close - vw[k]);
    const d = pdc != null ? Math.sign(c.close - pdc) : 0;
    if (rule === "vwap") return v;
    if (rule === "dayChange") return d;
    return v === d ? v : 0;
  });
}

/**
 * Sets s.indexDir (array aligned to s.candles) on every stock session that has an index
 * session the same day: the direction of the latest index bar that STARTED at or before the
 * stock bar (same interval → it closed at the same time). No index data that day → null.
 */
export function attachIndex(sessions, indexSessions, { indexId, rule = INDEX_FILTER.rule } = {}) {
  const byDate = new Map(indexSessions.map((s) => [s.date, s]));
  for (const s of sessions) {
    const ix = byDate.get(s.date);
    s.indexId = indexId;
    if (!ix?.candles.length) {
      s.indexDir = null;
      continue;
    }
    const dirs = indexDirs(ix, rule);
    const out = new Array(s.candles.length).fill(null);
    let j = -1;
    for (let k = 0; k < s.candles.length; k++) {
      while (j + 1 < ix.candles.length && ix.candles[j + 1].time <= s.candles[k].time) j++;
      out[k] = j >= 0 ? dirs[j] : null;
    }
    s.indexDir = out;
  }
  return sessions;
}

// The index right now (its latest bar, forming or not).
export function indexState(ix, indexId, rule = INDEX_FILTER.rule) {
  if (!ix?.candles.length) return null;
  const cs = ix.candles;
  const last = cs[cs.length - 1];
  const vw = vwap(cs)[cs.length - 1];
  const pdc = ix.prev?.close ?? null;
  const dir = indexDirs(ix, rule)[cs.length - 1];
  return {
    id: indexId,
    name: INDICES[indexId]?.name ?? indexId,
    date: ix.date,
    time: last.time,
    price: last.close,
    vwap: vw,
    prevClose: pdc,
    changePct: pdc ? (last.close / pdc - 1) * 100 : null,
    aboveVwap: last.close > vw,
    dir,
    rule,
    allows: dir === 1 ? "long" : dir === -1 ? "short" : "none",
  };
}

// Plain-words reason a side is blocked by the index.
export function blockReason(side, state) {
  if (!state) return null;
  if (side === "long" && state.dir === 1) return null;
  if (side === "short" && state.dir === -1) return null;
  const where = `${state.name} is ${state.dir === 1 ? "up" : state.dir === -1 ? "down" : "mixed"} (${state.aboveVwap ? "above" : "below"} VWAP, ${state.changePct >= 0 ? "+" : ""}${state.changePct?.toFixed(2)}% on the day)`;
  return `${where} — ${side === "long" ? "buys" : "sells"} are off while trading with the index`;
}

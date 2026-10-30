// NIFTY 50 and the stock's sector index, lined up bar by bar with each stock session, for
// strategies that read the market (ctx.market("nifty" | "sector") in lab/sessionData.js).
//
// Stock bar k is matched with the latest index bar that STARTED at or before it. Both use the
// same interval, so that index bar closed when bar k closed: nothing from the future.
// Pure (no database): market/marketData.js loads the index sessions and calls attachMarket.
import { vwap } from "../lab/indicators.js";
import { INDICES, MARKET_INDEX } from "../config/indices.js";

const nameOf = (id) => INDICES[id]?.name ?? id;

export function lineUp(stock, ix, id) {
  if (!ix?.candles.length) return null;
  const map = new Array(stock.candles.length).fill(-1);
  let j = -1;
  for (let k = 0; k < stock.candles.length; k++) {
    while (j + 1 < ix.candles.length && ix.candles[j + 1].time <= stock.candles[k].time) j++;
    map[k] = j;
  }
  return { id, name: nameOf(id), bars: ix.candles, vwap: vwap(ix.candles), prevClose: ix.prev?.close ?? null, map };
}

/**
 * Sets s.market = { nifty, sector } on every session. Either is null when there is no index
 * data that day (or the stock has no sector index: sector stays null rather than repeating NIFTY).
 */
export function attachMarket(sessions, { nifty = [], sector = [], niftyId = MARKET_INDEX, sectorId = null } = {}) {
  const nByDate = new Map(nifty.map((s) => [s.date, s]));
  const sByDate = new Map(sector.map((s) => [s.date, s]));
  for (const s of sessions) {
    s.market = {
      nifty: niftyId ? lineUp(s, nByDate.get(s.date), niftyId) : null,
      sector: sectorId ? lineUp(s, sByDate.get(s.date), sectorId) : null,
    };
  }
  return sessions;
}

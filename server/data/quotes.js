// Live quotes for the VWAP decision report: the stock's bid / ask / depth / circuit limits, and
// the NIFTY 50 advance-decline count. SmartAPI only (Yahoo has no depth). Everything returns
// null when it isn't available, so the report marks it missing instead of guessing.
import { isConfigured } from "./providers/smartapi/auth.js";
import { fetchQuotes } from "./providers/smartapi/quote.js";
import { getToken, tickSize } from "./providers/smartapi/instruments.js";
import { universeSymbols } from "./universes.js";
import { VWAP_REVERSION } from "../config/vwapReversion.js";
import { lru } from "../lru.js";

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const IST = 5.5 * 3600;

// "30-Oct-2026 13:41:09" (IST) → unix seconds.
export function parseFeedTime(s) {
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2})$/.exec(String(s || "").trim());
  if (!m || MONTHS[m[2].toLowerCase()] == null) return null;
  return Date.UTC(+m[3], MONTHS[m[2].toLowerCase()], +m[1], +m[4], +m[5], +m[6]) / 1000 - IST;
}

const sum = (rows) => rows.reduce((s, r) => s + (Number(r.quantity) || 0), 0);

// A FULL quote row → the fields the engine uses. fresh = recent enough to trade on.
export function normalizeQuote(row, nowSec = Date.now() / 1000, maxAgeSec = VWAP_REVERSION.liquidity.quoteMaxAgeSec) {
  if (!row) return null;
  const buy = row.depth?.buy || [];
  const sell = row.depth?.sell || [];
  const bid = buy[0]?.price > 0 ? buy[0].price : null;
  const ask = sell[0]?.price > 0 ? sell[0].price : null;
  const mid = bid && ask ? (bid + ask) / 2 : null;
  const time = parseFeedTime(row.exchFeedTime) ?? parseFeedTime(row.exchTradeTime);
  const ageSec = time != null ? Math.max(0, nowSec - time) : null;
  return {
    symbol: String(row.tradingSymbol || "").replace(/-(EQ|BE)$/, ""),
    ltp: row.ltp ?? null,
    bid,
    ask,
    spreadPct: mid && ask > bid ? ((ask - bid) / mid) * 100 : null,
    bidDepth: sum(buy),
    askDepth: sum(sell),
    depth: { buy: buy.slice(0, 5), sell: sell.slice(0, 5) },
    totBuy: Number(row.totBuyQuan) || 0,
    totSell: Number(row.totSellQuan) || 0,
    upperCircuit: row.upperCircuit > 0 ? row.upperCircuit : null,
    lowerCircuit: row.lowerCircuit > 0 ? row.lowerCircuit : null,
    prevClose: row.close ?? null,
    volume: row.tradeVolume ?? null,
    avgPrice: row.avgPrice ?? null,
    time,
    ageSec,
    fresh: ageSec != null && ageSec <= maxAgeSec && bid != null && ask != null,
  };
}

// One request per key per TTL, shared by everyone asking meanwhile; a failed one isn't kept.
const caches = { 8000: lru({ max: 500, ttlMs: 8_000 }), 30000: lru({ max: 20, ttlMs: 30_000 }) };
function cached(key, ttlMs, fn) {
  const c = caches[ttlMs];
  const p = c.use(key, fn);
  p.catch(() => c.delete(key));
  return p;
}

/** The stock's live FULL quote, normalized. { quote, error } — quote null when unavailable. */
export async function liveQuote(symbol) {
  if (!isConfigured()) return { quote: null, error: "SmartAPI not configured" };
  try {
    return await cached(`q|${symbol}`, 8_000, async () => {
      const rows = await fetchQuotes([await getToken(symbol)], "FULL");
      return { quote: normalizeQuote(rows[0]), error: rows[0] ? null : "no quote returned" };
    });
  } catch (err) {
    return { quote: null, error: err.message };
  }
}

/** NIFTY 50 advances / declines vs the previous close, from one OHLC call. null = unavailable. */
export async function niftyBreadth() {
  if (!isConfigured()) return null;
  const members = universeSymbols("NIFTY50");
  if (!members.length) return null;
  try {
    return await cached("breadth", 30_000, async () => {
      const tokens = [];
      for (const s of members) {
        try {
          tokens.push(await getToken(s));
        } catch {
          /* not in the instrument list: counts against coverage */
        }
      }
      const rows = await fetchQuotes(tokens, "OHLC");
      let advances = 0;
      let declines = 0;
      let unchanged = 0;
      for (const r of rows) {
        if (!(r.ltp > 0) || !(r.close > 0)) continue;
        if (r.ltp > r.close) advances++;
        else if (r.ltp < r.close) declines++;
        else unchanged++;
      }
      const quoted = advances + declines + unchanged;
      return { advances, declines, unchanged, quoted, total: members.length, coverage: quoted / members.length };
    });
  } catch {
    return null;
  }
}

export const instrumentTick = (symbol) => {
  try {
    return tickSize(symbol);
  } catch {
    return null;
  }
};

// India VIX (NSE index token 99926017): { ltp, prevClose, changePct } or null when unavailable.
export const INDIA_VIX_TOKEN = "99926017";
export async function indiaVix() {
  if (!isConfigured()) return null;
  try {
    return await cached("vix", 30_000, async () => {
      const [r] = await fetchQuotes([INDIA_VIX_TOKEN], "OHLC");
      if (!(r?.ltp > 0)) return null;
      return { ltp: r.ltp, prevClose: r.close > 0 ? r.close : null, changePct: r.close > 0 ? (r.ltp / r.close - 1) * 100 : null };
    });
  } catch {
    return null;
  }
}

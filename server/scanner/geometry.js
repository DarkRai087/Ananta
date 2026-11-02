// Pure candle geometry shared by every detector. All functions are causal: a value at bar i
// uses only bars ≤ i. Nothing here reaches into another session.
import { SCANNER as CFG } from "../config/scanner.js";
import { ema, closes } from "../lab/indicators.js";

export const range = (c) => c.high - c.low;
export const body = (c) => Math.abs(c.close - c.open);
export const upperWick = (c) => c.high - Math.max(c.open, c.close);
export const lowerWick = (c) => Math.min(c.open, c.close) - c.low;
export const isBull = (c) => c.close > c.open;
export const isBear = (c) => c.close < c.open;
export const midBody = (c) => (c.open + c.close) / 2;

// A bar has a meaningful range (not a flat / illiquid print).
export const hasRange = (c, minPct = CFG.minRangePct) => c && range(c) > 0 && (range(c) / c.close) * 100 >= minPct;

// Body floored at a fraction of range, so wick-to-body tests are not trivially satisfied by a
// near-zero (doji) body.
export const bodyFloor = (c) => Math.max(body(c), range(c) * CFG.bodyFloorPct);

/**
 * Per-session precompute passed to detectors so the EMA / avgBody arrays are built once.
 *   ema20[k]   = session EMA(close, trend.emaPeriod) at bar k (null until it exists)
 *   avgBody[k] = mean body of the `avgBodyBars` bars before k (bars k−n .. k−1), null if none
 */
export function sessionContext(cs) {
  const ema20 = ema(closes(cs), CFG.trend.emaPeriod);
  const n = CFG.avgBodyBars;
  const avgBody = new Array(cs.length).fill(null);
  for (let k = 0; k < cs.length; k++) {
    const from = Math.max(0, k - n);
    if (k - from <= 0) continue;
    let s = 0;
    for (let j = from; j < k; j++) s += body(cs[j]);
    avgBody[k] = s / (k - from);
  }
  return { ema20, avgBody };
}

// avgBody at bar i, from ctx if given, else computed on the fly (for standalone unit tests).
export function avgBodyAt(cs, i, ctx) {
  if (ctx?.avgBody) return ctx.avgBody[i];
  const from = Math.max(0, i - CFG.avgBodyBars);
  if (i - from <= 0) return null;
  let s = 0;
  for (let j = from; j < i; j++) s += body(cs[j]);
  return s / (i - from);
}

/**
 * Prior-trend direction evaluated AT reference bar r (data ≤ r only): +1 up, −1 down, 0 unknown.
 * Up   = slope of the last `slopeBars` closes > 0 AND (EMA not ready, or close[r] > EMA[r]).
 * Down = mirror. Early in the session (EMA not ready) the slope alone decides.
 */
export function trendAt(cs, r, ctx) {
  const k = CFG.trend;
  if (r < k.slopeBars) return 0;
  const slope = cs[r].close - cs[r - k.slopeBars].close;
  if (slope === 0) return 0;
  const e = ctx?.ema20 ? ctx.ema20[r] : ema(closes(cs), k.emaPeriod)[r];
  const emaReady = e != null && k.requireEmaWhenReady;
  if (slope > 0) return !emaReady || cs[r].close > e ? 1 : 0;
  return !emaReady || cs[r].close < e ? -1 : 0;
}

// Prior trend leading INTO a pattern that spans `span` bars and completes at bar i: the trend of
// the bar just before the pattern's first bar.
export const priorTrend = (cs, i, span, ctx) => trendAt(cs, i - span, ctx);

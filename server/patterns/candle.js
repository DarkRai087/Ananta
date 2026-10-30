// Small pure helpers shared by the candlestick detectors.
import { PATTERNS as CFG } from "../config/patterns.js";

export const range = (c) => c.high - c.low;
export const body = (c) => Math.abs(c.close - c.open);
export const upperWick = (c) => c.high - Math.max(c.open, c.close);
export const lowerWick = (c) => Math.min(c.open, c.close) - c.low;
export const isBull = (c) => c.close > c.open;
export const isBear = (c) => c.close < c.open;

// Bar has a meaningful range (not a flat/illiquid print).
export const hasRange = (c, minPct = CFG.minRangePct) => range(c) > 0 && (range(c) / c.close) * 100 >= minPct;

// Prior trend over the `n` bars before index i (bars i-n .. i-1). Same session only.
export function priorTrend(cs, i, n = CFG.trendBars) {
  if (i - n < 0) return 0;
  const from = cs[i - n].open;
  const to = cs[i - 1].close;
  return to < from ? -1 : to > from ? 1 : 0;
}

export const trendOk = (cs, i, wanted) => !CFG.requireTrend || priorTrend(cs, i) === wanted;

export const hit = (name, direction, index) => ({ name, direction, index });

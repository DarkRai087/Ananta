// Marubozu: a full-bodied bar with (almost) no wicks.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { body, range, hasRange, isBull, hit } from "../candle.js";

export const id = "marubozu";
export const names = ["Bullish Marubozu", "Bearish Marubozu"];

export function detect(cs, i) {
  const c = cs[i];
  if (!c || !hasRange(c, CFG.marubozu.minRangePct)) return null;
  if (body(c) / range(c) < CFG.marubozu.minBodyPct) return null;
  return isBull(c) ? hit("Bullish Marubozu", "long", i) : hit("Bearish Marubozu", "short", i);
}

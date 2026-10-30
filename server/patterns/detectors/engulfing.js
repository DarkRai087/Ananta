// Bullish / Bearish Engulfing: the current body fully covers the previous opposite-colour body.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { body, isBull, isBear, hasRange, trendOk, hit } from "../candle.js";

export const id = "engulfing";
export const names = ["Bullish Engulfing", "Bearish Engulfing"];

export function detect(cs, i) {
  if (i < 1) return null;
  const p = cs[i - 1];
  const c = cs[i];
  if (!hasRange(c) || body(p) === 0) return null;
  const bigEnough = body(c) >= body(p) * CFG.engulfing.minBodyRatio;
  if (!bigEnough) return null;
  // Prior trend is judged on the bars before the 2-bar pattern.
  if (isBear(p) && isBull(c) && c.open <= p.close && c.close >= p.open && trendOk(cs, i - 1, -1)) {
    return hit("Bullish Engulfing", "long", i);
  }
  if (isBull(p) && isBear(c) && c.open >= p.close && c.close <= p.open && trendOk(cs, i - 1, 1)) {
    return hit("Bearish Engulfing", "short", i);
  }
  return null;
}

// Shooting Star: same shape as an inverted hammer, but after a rise (bearish).
import { PATTERNS as CFG } from "../../config/patterns.js";
import { body, range, upperWick, lowerWick, hasRange, trendOk, hit } from "../candle.js";

export const id = "shootingStar";
export const names = ["Shooting Star"];

export function detect(cs, i) {
  const c = cs[i];
  if (!c || !hasRange(c)) return null;
  const r = range(c);
  const b = body(c);
  const k = CFG.shootingStar;
  if (b / r > k.maxBodyPct) return null;
  if (upperWick(c) < k.minUpperWickToBody * Math.max(b, r * 0.02)) return null;
  if (lowerWick(c) / r > k.maxLowerWickPct) return null;
  if (!trendOk(cs, i, 1)) return null;
  return hit("Shooting Star", "short", i);
}

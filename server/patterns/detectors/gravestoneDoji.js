// Gravestone Doji: open ≈ close ≈ low, long upper wick (bearish).
import { PATTERNS as CFG } from "../../config/patterns.js";
import { body, range, upperWick, lowerWick, hasRange, hit } from "../candle.js";

export const id = "gravestoneDoji";
export const names = ["Gravestone Doji"];

export function detect(cs, i) {
  const c = cs[i];
  if (!c || !hasRange(c)) return null;
  const r = range(c);
  const k = CFG.gravestone;
  if (body(c) / r > k.maxBodyPct) return null;
  if (lowerWick(c) / r > k.maxLowerWickPct || upperWick(c) / r < k.minUpperWickPct) return null;
  return hit("Gravestone Doji", "short", i);
}

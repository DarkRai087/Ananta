// Dragonfly Doji: open ≈ close ≈ high, long lower wick (bullish).
import { PATTERNS as CFG } from "../../config/patterns.js";
import { body, range, upperWick, lowerWick, hasRange, hit } from "../candle.js";

export const id = "dragonflyDoji";
export const names = ["Dragonfly Doji"];

export function detect(cs, i) {
  const c = cs[i];
  if (!c || !hasRange(c)) return null;
  const r = range(c);
  const k = CFG.dragonfly;
  if (body(c) / r > k.maxBodyPct) return null;
  if (upperWick(c) / r > k.maxUpperWickPct || lowerWick(c) / r < k.minLowerWickPct) return null;
  return hit("Dragonfly Doji", "long", i);
}

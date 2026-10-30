// Doji: open ≈ close. Gravestone and Dragonfly shapes are excluded (they have their own detectors).
import { PATTERNS as CFG } from "../../config/patterns.js";
import { body, range, upperWick, lowerWick, hasRange, hit } from "../candle.js";

export const id = "doji";
export const names = ["Doji"];

export function detect(cs, i) {
  const c = cs[i];
  if (!c || !hasRange(c)) return null;
  const r = range(c);
  if (body(c) / r > CFG.doji.maxBodyPct) return null;
  const g = CFG.gravestone;
  const d = CFG.dragonfly;
  if (lowerWick(c) / r <= g.maxLowerWickPct && upperWick(c) / r >= g.minUpperWickPct) return null;
  if (upperWick(c) / r <= d.maxUpperWickPct && lowerWick(c) / r >= d.minLowerWickPct) return null;
  return hit("Doji", "neutral", i);
}

// Morning Star (3 bars): long bearish bar, small-bodied bar, bullish bar closing above the
// midpoint of the first body. Needs a prior decline.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { body, range, isBull, isBear, hasRange, trendOk, hit } from "../candle.js";

export const id = "morningStar";
export const names = ["Morning Star"];

export function detect(cs, i) {
  if (i < 2) return null;
  const a = cs[i - 2];
  const b = cs[i - 1];
  const c = cs[i];
  const k = CFG.star;
  if (!hasRange(a) || !isBear(a) || body(a) / range(a) < k.minFirstBodyPct) return null;
  if (body(b) > body(a) * k.maxMiddleBodyRatio) return null;
  if (!isBull(c)) return null;
  if (c.close < a.close + body(a) * k.minPenetration) return null;
  if (!trendOk(cs, i - 2, -1)) return null;
  return hit("Morning Star", "long", i);
}

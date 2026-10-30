// Evening Star (3 bars): long bullish bar, small-bodied bar, bearish bar closing below the
// midpoint of the first body. Needs a prior rise.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { body, range, isBull, isBear, hasRange, trendOk, hit } from "../candle.js";

export const id = "eveningStar";
export const names = ["Evening Star"];

export function detect(cs, i) {
  if (i < 2) return null;
  const a = cs[i - 2];
  const b = cs[i - 1];
  const c = cs[i];
  const k = CFG.star;
  if (!hasRange(a) || !isBull(a) || body(a) / range(a) < k.minFirstBodyPct) return null;
  if (body(b) > body(a) * k.maxMiddleBodyRatio) return null;
  if (!isBear(c)) return null;
  if (c.close > a.close - body(a) * k.minPenetration) return null;
  if (!trendOk(cs, i - 2, 1)) return null;
  return hit("Evening Star", "short", i);
}

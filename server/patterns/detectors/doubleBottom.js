// Intraday Double Bottom: swing low L1, swing high (neckline), swing low L2 ≈ L1, then the
// FIRST close above the neckline. Same-session swing points only.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { pivotsAt } from "../zigzag.js";
import { hit } from "../candle.js";

export const id = "doubleBottom";
export const names = ["Double Bottom"];

export function detect(cs, i) {
  if (i < 1) return null;
  const pv = pivotsAt(cs, i, CFG.zigzagPct);
  let j = pv.length - 1;
  while (j >= 0 && pv[j].type !== "L") j--;
  if (j < 2) return null;
  const l2 = pv[j];
  const neck = pv[j - 1];
  const l1 = pv[j - 2];
  if (neck.type !== "H" || l1.type !== "L") return null;
  const k = CFG.doubleTop;
  if ((Math.abs(l2.price - l1.price) / l1.price) * 100 > k.tolerancePct) return null;
  if (l2.index - l1.index < k.minBarsBetween) return null;
  if (!(cs[i].close > neck.price)) return null;
  for (let m = l2.index + 1; m < i; m++) if (cs[m].close > neck.price) return null;
  return hit("Double Bottom", "long", i);
}

// Intraday Double Top: swing high H1, swing low (neckline), swing high H2 ≈ H1, then the
// FIRST close below the neckline. Uses only this session's confirmed swing points up to i.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { pivotsAt } from "../zigzag.js";
import { hit } from "../candle.js";

export const id = "doubleTop";
export const names = ["Double Top"];

export function detect(cs, i) {
  if (i < 1) return null;
  const pv = pivotsAt(cs, i, CFG.zigzagPct);
  let j = pv.length - 1;
  while (j >= 0 && pv[j].type !== "H") j--;
  if (j < 2) return null;
  const h2 = pv[j];
  const neck = pv[j - 1];
  const h1 = pv[j - 2];
  if (neck.type !== "L" || h1.type !== "H") return null;
  const k = CFG.doubleTop;
  if ((Math.abs(h2.price - h1.price) / h1.price) * 100 > k.tolerancePct) return null;
  if (h2.index - h1.index < k.minBarsBetween) return null;
  if (!(cs[i].close < neck.price)) return null;
  for (let m = h2.index + 1; m < i; m++) if (cs[m].close < neck.price) return null; // not the first break
  return hit("Double Top", "short", i);
}

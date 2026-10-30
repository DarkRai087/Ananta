// Bear Flag: a sharp pole down to a confirmed swing low, a shallow bounce (the flag),
// then the FIRST close below the pole low. Same-session bars only.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { pivotsAt } from "../zigzag.js";
import { hit } from "../candle.js";

export const id = "bearFlag";
export const names = ["Bear Flag"];

export function detect(cs, i) {
  if (i < 3) return null;
  const pv = pivotsAt(cs, i, CFG.zigzagPct);
  let j = pv.length - 1;
  while (j >= 0 && pv[j].type !== "L") j--;
  if (j < 0) return null;
  const bottom = pv[j];
  const k = CFG.flag;

  const start = Math.max(0, bottom.index - k.maxPoleBars);
  if (start === bottom.index) return null;
  let base = start;
  for (let m = start; m < bottom.index; m++) if (cs[m].high > cs[base].high) base = m;
  const pole = cs[base].high - bottom.price;
  if ((pole / cs[base].high) * 100 < k.minPolePct) return null;

  const flagBars = i - 1 - bottom.index;
  if (flagBars < k.minFlagBars || flagBars > k.maxFlagBars) return null;
  let high = -Infinity;
  for (let m = bottom.index + 1; m < i; m++) {
    if (cs[m].high > high) high = cs[m].high;
    if (cs[m].close < bottom.price) return null;
  }
  const retrace = ((high - bottom.price) / pole) * 100;
  if (retrace <= 0 || retrace > k.maxRetracePct) return null;

  if (!(cs[i].close < bottom.price)) return null;
  return hit("Bear Flag", "short", i);
}

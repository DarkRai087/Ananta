// Bull Flag: a sharp pole up to a confirmed swing high, a shallow pullback (the flag),
// then the FIRST close above the pole high. Same-session bars only.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { pivotsAt } from "../zigzag.js";
import { hit } from "../candle.js";

export const id = "bullFlag";
export const names = ["Bull Flag"];

export function detect(cs, i) {
  if (i < 3) return null;
  const pv = pivotsAt(cs, i, CFG.zigzagPct);
  let j = pv.length - 1;
  while (j >= 0 && pv[j].type !== "H") j--;
  if (j < 0) return null;
  const top = pv[j];
  const k = CFG.flag;

  // Pole: lowest low in the bars just before the top.
  const start = Math.max(0, top.index - k.maxPoleBars);
  if (start === top.index) return null;
  let base = start;
  for (let m = start; m < top.index; m++) if (cs[m].low < cs[base].low) base = m;
  const pole = top.price - cs[base].low;
  if ((pole / cs[base].low) * 100 < k.minPolePct) return null;

  // Flag: bars between the top and the breakout bar.
  const flagBars = i - 1 - top.index;
  if (flagBars < k.minFlagBars || flagBars > k.maxFlagBars) return null;
  let low = Infinity;
  for (let m = top.index + 1; m < i; m++) {
    if (cs[m].low < low) low = cs[m].low;
    if (cs[m].close > top.price) return null; // already broke out earlier
  }
  const retrace = ((top.price - low) / pole) * 100;
  if (retrace <= 0 || retrace > k.maxRetracePct) return null;

  if (!(cs[i].close > top.price)) return null;
  return hit("Bull Flag", "long", i);
}

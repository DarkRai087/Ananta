// Intraday Descending Triangle: two swing lows at ~the same level (flat bottom), two falling
// swing highs, then the FIRST close below the flat bottom. Same-session swing points only.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { pivotsAt } from "../zigzag.js";
import { hit } from "../candle.js";

export const id = "descendingTriangle";
export const names = ["Descending Triangle"];

export function detect(cs, i) {
  if (i < 1) return null;
  const pv = pivotsAt(cs, i, CFG.zigzagPct);
  if (pv.length < 4) return null;
  const last4 = pv.slice(-4);
  const highs = last4.filter((p) => p.type === "H");
  const lows = last4.filter((p) => p.type === "L");
  if (highs.length !== 2 || lows.length !== 2) return null;
  const k = CFG.triangle;
  const [ha, hb] = highs;
  const [la, lb] = lows;
  if ((Math.abs(lb.price - la.price) / la.price) * 100 > k.flatTolerancePct) return null;
  if (((ha.price - hb.price) / ha.price) * 100 < k.minSlopePct) return null;
  const support = Math.min(la.price, lb.price);
  if (!(cs[i].close < support)) return null;
  for (let m = last4[0].index; m < i; m++) if (cs[m].close < support) return null;
  return hit("Descending Triangle", "short", i);
}

// Intraday Ascending Triangle: two swing highs at ~the same level (flat top), two rising
// swing lows, then the FIRST close above the flat top. Same-session swing points only.
import { PATTERNS as CFG } from "../../config/patterns.js";
import { pivotsAt } from "../zigzag.js";
import { hit } from "../candle.js";

export const id = "ascendingTriangle";
export const names = ["Ascending Triangle"];

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
  if ((Math.abs(hb.price - ha.price) / ha.price) * 100 > k.flatTolerancePct) return null;
  if (((lb.price - la.price) / la.price) * 100 < k.minSlopePct) return null;
  const resistance = Math.max(ha.price, hb.price);
  if (!(cs[i].close > resistance)) return null;
  for (let m = last4[0].index; m < i; m++) if (cs[m].close > resistance) return null;
  return hit("Ascending Triangle", "long", i);
}

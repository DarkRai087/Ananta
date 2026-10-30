// Inside Bar: the whole bar sits inside the previous bar's range (direction-neutral).
import { PATTERNS as CFG } from "../../config/patterns.js";
import { hasRange, hit } from "../candle.js";

export const id = "insideBar";
export const names = ["Inside Bar"];

export function detect(cs, i) {
  if (i < 1) return null;
  const m = cs[i - 1];
  const c = cs[i];
  if (!hasRange(m, CFG.insideBar.minMotherRangePct)) return null;
  if (c.high < m.high && c.low > m.low) return hit("Inside Bar", "neutral", i);
  return null;
}

// Opening-range breakout: the first bar after the range that CLOSES above the range high.
// Strategy interface: findEntry(bars, params) -> { slot, entry, stop, target } | null
import { slotOf } from "../time.js";

export function findEntry(bars, { orBars = 3, entryDeadline = "14:00", stopRule = "or-mid", targetR, until = "15:15" }) {
  let orHigh = -Infinity;
  let orLow = Infinity;
  for (let k = 0; k < orBars; k++) {
    orHigh = Math.max(orHigh, bars[k].h);
    orLow = Math.min(orLow, bars[k].l);
  }
  // The bar closing exactly at the deadline may enter; at least one bar must remain before `until`.
  const last = Math.min(slotOf(entryDeadline) - 1, slotOf(until) - 2);
  for (let e = orBars; e <= last; e++) {
    if (bars[e].c <= orHigh) continue;
    const entry = bars[e].c;
    const stop = stopRule === "or-low" ? orLow : (orHigh + orLow) / 2;
    return { slot: e, entry, stop, target: entry + targetR * (entry - stop) };
  }
  return null;
}

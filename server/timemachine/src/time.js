// The NSE 5-minute grid: slot k is the bar starting at 09:15 + 5k min (slot 74 = 15:25–15:30).
import { TimeMachineError } from "./errors.js";

export const BARS = 75;
const OPEN = 555; // 09:15 in minutes

export function slotOf(hhmm) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(hhmm);
  const k = m ? (Number(m[1]) * 60 + Number(m[2]) - OPEN) / 5 : NaN;
  if (!Number.isInteger(k)) throw new TimeMachineError("ENTRY_NOT_ON_GRID", `${hhmm} is not on the 5-minute grid (09:15, 09:20, …)`);
  return k;
}

export function slotTime(k) {
  const m = OPEN + 5 * k;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

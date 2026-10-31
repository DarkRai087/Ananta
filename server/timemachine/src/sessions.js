// Which sessions may teach the simulation, and the ratio pool they become.
import { BARS, slotTime } from "./time.js";

const TIMES = Array.from({ length: BARS }, (_, k) => slotTime(k));
const ok = (x) => Number.isFinite(x) && x > 0;

// Bar k: on the grid, sane prices, volume (optional) finite and ≥ 0.
export const validBar = (b, k) =>
  b.t === TIMES[k] && ok(b.o) && ok(b.h) && ok(b.l) && ok(b.c) && b.l <= Math.min(b.o, b.c) && b.h >= Math.max(b.o, b.c) && (b.v == null || (Number.isFinite(b.v) && b.v >= 0));

// Full sessions only (75 valid bars, so no gaps or duplicates), oldest first.
export const validSorted = (sessions) =>
  sessions.filter((s) => s.bars?.length === BARS && s.bars.every(validBar)).sort((a, b) => (a.date > b.date) - (a.date < b.date));

/**
 * Valid sessions strictly before `date` (no lookahead), oldest first; how many of the
 * sessions before `date` were invalid; and pool[k] = every slot-k bar as ratios to its
 * reference: the previous bar's close, or for slot 0 its own open (overnight gaps left out).
 */
export function buildPool(sessions, date) {
  const past = sessions.filter((s) => s.date < date);
  const valid = validSorted(past);
  const pool = TIMES.map(() => []);
  for (const { bars } of valid)
    bars.forEach((b, k) => {
      const ref = k ? bars[k - 1].c : b.o;
      pool[k].push({ ro: b.o / ref, rh: b.h / ref, rl: b.l / ref, rc: b.c / ref });
    });
  return { sessions: valid, excluded: past.length - valid.length, pool };
}

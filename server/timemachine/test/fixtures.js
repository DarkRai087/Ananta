// Fixture generators (spec section 8).
import { mulberry32 } from "../src/rng.js";
import { slotTime } from "../src/time.js";

// First n weekdays from `start` (UTC date math, no holidays).
export function tradingDays(start, n) {
  const days = [];
  for (let t = Date.parse(`${start}T00:00:00Z`); days.length < n; t += 86_400_000) {
    const d = new Date(t);
    const w = d.getUTCDay();
    if (w > 0 && w < 6) days.push(d.toISOString().slice(0, 10));
  }
  return days;
}

const ratios = (ro, rh, rl, rc) => () => ({ ro, rh, rl, rc });
export const FLAT = ratios(1, 1, 1, 1);
export const UP = ratios(1, 1.001, 1, 1.001);
export const DOWN = ratios(1, 1, 0.999, 0.999);
export const BOTH = ratios(1, 1.02, 0.98, 1);
const DROP = ratios(0.98, 0.98, 0.98, 0.98);
export const GAP = (k) => (k ? DROP() : FLAT());
export const MORNING_UP = (k) => (k <= 37 ? UP() : DOWN());

// Every bar = ratioFn(k) applied to its reference: `open` for slot 0, else the previous close.
export const constSessions = (n, start, ratioFn, open = 100) =>
  tradingDays(start, n).map((date) => {
    const bars = [];
    let ref = open;
    for (let k = 0; k < 75; k++) {
      const x = ratioFn(k);
      bars.push({ t: slotTime(k), o: ref * x.ro, h: ref * x.rh, l: ref * x.rl, c: ref * x.rc });
      ref = bars[k].c;
    }
    return { date, bars };
  });

export function randomWalkSessions(n, start, seed) {
  const rand = mulberry32(seed);
  return tradingDays(start, n).map((date) => {
    const bars = [];
    let prevC = 1000;
    for (let k = 0; k < 75; k++) {
      const o = prevC;
      const u1 = rand();
      const u2 = rand();
      const u3 = rand();
      const c = o * (1 + (u1 - 0.5) * 0.004);
      bars.push({ t: slotTime(k), o, h: Math.max(o, c) * (1 + u2 * 0.001), l: Math.min(o, c) * (1 - u3 * 0.001), c });
      prevC = c;
    }
    return { date, bars };
  });
}

// Fixture G: 30 sessions, 2026-09-01 to 2026-10-12. Plan date 2026-10-13.
export const G = randomWalkSessions(30, "2026-09-01", 7);

// ── v2 fixtures (add-on section 9.1) ──
export const withVolume = (sessions, seed) => {
  const rand = mulberry32(seed);
  return sessions.map((s) => ({ date: s.date, bars: s.bars.map((b) => ({ ...b, v: 500 + Math.floor(rand() * 1000) })) }));
};
const morning = (s, e = 12) => ({ date: s.date, bars: s.bars.slice(0, e) });

// H: even days UP with v 2000, odd days DOWN with v 500. Pool = 20 days, today = an UP morning.
const H_ALL = tradingDays("2026-09-01", 21).map((date, i) => ({
  date,
  bars: constSessions(1, date, i % 2 ? DOWN : UP)[0].bars.map((b) => ({ ...b, v: i % 2 ? 500 : 2000 })),
}));
export const H = H_ALL.slice(0, 20);
export const H_TODAY = morning(H_ALL[20]);

// GV: fixture G's prices plus volume, and a 31st day as today. N: a Nifty 50 random walk.
export const GV = withVolume(randomWalkSessions(31, "2026-09-01", 7), 11);
export const GV_TODAY = morning(GV[30]);
export const N = randomWalkSessions(31, "2026-09-01", 8);

// W: 60 days of noise for walk-forward. P: a planted signal (morning volume predicts the afternoon).
export const W = withVolume(randomWalkSessions(60, "2026-06-01", 7), 11);
export const N60 = randomWalkSessions(60, "2026-06-01", 8);

export function plantedSessions(n, start, seed) {
  const rand = mulberry32(seed);
  return tradingDays(start, n).map((date) => {
    const bull = rand() < 0.5;
    const bars = [];
    let prevC = 1000;
    for (let k = 0; k < 75; k++) {
      const o = prevC;
      const u1 = rand();
      const u2 = rand();
      const u3 = rand();
      const drift = k >= 12 ? (bull ? 0.0004 : -0.0004) : 0;
      const c = o * (1 + drift + (u1 - 0.5) * 0.002);
      bars.push({ t: slotTime(k), o, h: Math.max(o, c) * (1 + u2 * 0.0005), l: Math.min(o, c) * (1 - u3 * 0.0005), c, v: k < 12 ? (bull ? 2000 : 500) : 1000 });
      prevC = c;
    }
    return { date, bars, bull };
  });
}
export const P = plantedSessions(80, "2026-06-01", 5);

// Handcrafted candle builders for tests. Times are real IST session times.
import { istEpoch } from "../lab/time.js";

// bars: [[open, high, low, close, volume?], …] starting 09:15 on `date`, every `step` minutes.
export function makeCandles(date, bars, step = 5, start = "09:15") {
  const t0 = istEpoch(date, start);
  return bars.map(([o, h, l, c, v = 1000], k) => ({ time: t0 + k * step * 60, open: o, high: h, low: l, close: c, volume: v }));
}

// A session object as buildSessions() would produce.
export function makeSession(date, bars, prev = null, step = 5) {
  return { date, special: false, label: null, candles: makeCandles(date, bars, step), prev };
}

// Flat filler bars at a price (tiny range so they never look like patterns).
export const flat = (n, p = 100) => Array.from({ length: n }, () => [p, p + 0.01, p - 0.01, p]);

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random-walk sessions (75 × 5m bars) with gaps and volume spikes so every strategy fires.
export function randomSessions(nDays = 40, seed = 7) {
  const rnd = mulberry32(seed);
  const out = [];
  let price = 1000;
  let d = new Date("2025-01-06T00:00:00Z");
  while (out.length < nDays) {
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const date = d.toISOString().slice(0, 10);
      price *= 1 + (rnd() - 0.5) * 0.03; // overnight gap up to ±1.5%
      const drift = (rnd() - 0.5) * 0.002;
      const bars = [];
      for (let k = 0; k < 75; k++) {
        const o = price;
        const c = o * (1 + drift + (rnd() - 0.5) * 0.006);
        const h = Math.max(o, c) * (1 + rnd() * 0.002);
        const l = Math.min(o, c) * (1 - rnd() * 0.002);
        const v = Math.round(1000 + rnd() * 1000) * (rnd() < 0.05 ? 4 : 1);
        bars.push([o, h, l, c, v]);
        price = c;
      }
      out.push({ date, bars });
    }
    d = new Date(d.getTime() + 86400_000);
  }
  return out;
}

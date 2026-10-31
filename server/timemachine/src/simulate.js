// The Monte Carlo engine: replays the rest of the day from the stock's own 5-minute bars.
import { mulberry32 } from "./rng.js";
import { BARS, slotTime } from "./time.js";
import { percentiles } from "./stats.js";

// Slots a bar may be borrowed from: the same time of day ± window, cut at the session edges.
export function candidateSlots(s, window) {
  const out = [];
  for (let k = Math.max(0, s - window); k <= Math.min(BARS - 1, s + window); k++) out.push(k);
  return out;
}

// What one bar does to a long position, checked in this order (stop before target when a bar
// touches both): -2 gap through the stop, -1 stop, 1 target, 0 nothing. history.js uses it too.
export const hit = (o, h, l, stop, target) => (o <= stop ? -2 : o >= target ? 1 : l <= stop ? -1 : h >= target ? 1 : 0);

// First index i with cum[i] > u·total. With every weight 1, cum[i] = i + 1, so this is floor(u·n)
// exactly as in v1; a zero-weight entry is never picked.
export function pickWeighted(cum, u) {
  const x = u * cum[cum.length - 1];
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid] > x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

const EDGES = [-0.01, -0.005, 0, 0.005, 0.01];

// Odds, percentiles and move buckets of the prices at one horizon slot, relative to ref.
function horizonStats(slot, prices, ref) {
  const n = prices.length;
  const buckets = [0, 0, 0, 0, 0, 0];
  let up = 0;
  let down = 0;
  let sum = 0;
  for (const p of prices) {
    if (p > ref) up++;
    else if (p < ref) down++;
    sum += p;
    const r = p / ref - 1;
    let b = 0;
    while (b < EDGES.length && EDGES[b] <= r) b++;
    buckets[b]++;
  }
  const [p5, p25, median, p75, p95] = percentiles(prices, [0.05, 0.25, 0.5, 0.75, 0.95]);
  return { slot, time: slotTime(slot), pUp: up / n, pDown: down / n, pFlat: (n - up - down) / n, mean: sum / n, p5, p25, median, p75, p95, buckets };
}

/**
 * w[j]: weight of pool session j (all 1 = v1). hSlots: horizon slots. Exactly one rand() per bar,
 * and the path always runs to endSlot, so weights change which bar is drawn, never how many draws.
 * Returns mc (trade mode only, else null) and the forecast at each horizon.
 */
export function simulate({ entry, stop, target, startSlot, endSlot }, pool, w, { replays, seed, window }, hSlots) {
  const trade = stop != null;
  const rand = mulberry32(seed);
  const lists = [];
  const cums = [];
  const record = []; // record[j] = horizons whose price is taken right after bar j
  for (let s = startSlot; s < endSlot; s++) {
    const list = [];
    const cum = [];
    let c = 0;
    for (const k of candidateSlots(s, window))
      pool[k].forEach((r, j) => {
        list.push(r);
        cum.push((c += w[j]));
      });
    lists.push(list);
    cums.push(cum);
    record.push(hSlots.flatMap((h, i) => (h === s + 1 ? [i] : [])));
  }
  const risk = entry - stop;
  const targetR = (target - entry) / risk;
  const finals = new Float64Array(replays);
  const prices = hSlots.map(() => new Float64Array(replays));
  const n = { target: 0, stop: 0, neither: 0, green: 0, gapStops: 0 };
  let sumR = 0;
  for (let i = 0; i < replays; i++) {
    let P = entry;
    let out = 0;
    for (let j = 0; j < lists.length; j++) {
      const r = lists[j][pickWeighted(cums[j], rand())];
      if (trade && !out) out = hit(P * r.ro, P * r.rh, P * r.rl, stop, target);
      P *= r.rc;
      for (const h of record[j]) prices[h][i] = P;
    }
    finals[i] = P;
    if (!trade) continue;
    if (out > 0) {
      n.target++;
      n.green++;
      sumR += targetR;
    } else if (out < 0) {
      n.stop++;
      if (out === -2) n.gapStops++;
      sumR -= 1;
    } else {
      n.neither++;
      if (P > entry) n.green++;
      sumR += (P - entry) / risk;
    }
  }
  const [median, p5, p95] = percentiles(finals, [0.5, 0.05, 0.95]);
  return {
    mc: trade ? { replays, seed, window, ...n, avgR: sumR / replays, median, p5, p95 } : null,
    forecast: hSlots.map((slot, k) => horizonStats(slot, prices[k], entry)),
  };
}

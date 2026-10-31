// Analog days: weight each pool session by how much its morning looked like today's.
import { TimeMachineError } from "./errors.js";
import { BARS } from "./time.js";
import { FEATURES } from "./features/index.js";

export const CONDITIONING = {
  enabled: false,
  features: FEATURES.map((f) => f.name),
  featureWeights: {},
  bandwidth: 1,
  minEss: 8,
  eventWeight: 4,
  volScale: false,
};
const RVOL = FEATURES.find((f) => f.name === "rvol");

/**
 * pool: valid pool sessions, oldest first. today: { date, bars } (only bars 0..e−1 are read).
 * all: valid sessions, oldest first, for each session's previous close (gap).
 * Returns w[i] per pool session (uniform = exactly 1, never 1/n), diag { used, ess, bandwidth,
 * fellBack, top }, the used features' raw values, and the volatility scale per session (or null).
 */
export function analogWeights(pool, today, { e, all = pool, index, events, conditioning }) {
  const cfg = { ...CONDITIONING, ...conditioning };
  const prevClose = (date) => {
    let c = null;
    for (const s of all) {
      if (s.date >= date) break;
      c = s.bars[BARS - 1].c;
    }
    return c;
  };
  const row = (s) => ({ date: s.date, bars: s.bars, prevClose: prevClose(s.date) });
  const rows = pool.map(row);
  const now = row(today);
  const ctx = { e, pool: rows, index: index ? new Map(index.map((s) => [s.date, s.bars])) : null };
  const n = rows.length;

  // Features that every row has, standardized on the pool (population sd); a flat one is dropped.
  const used = [];
  const values = { today: {}, pool: rows.map(() => ({})) };
  const d2 = new Array(n).fill(0);
  for (const name of cfg.features) {
    const f = FEATURES.find((x) => x.name === name);
    if (!f) throw new TimeMachineError("INVALID_OPTIONS", `Unknown feature "${name}"; known: ${CONDITIONING.features.join(", ")}`);
    if (!f.available([...rows, now], ctx)) continue;
    const xs = rows.map((r) => f.value(r, ctx));
    const xt = f.value(now, ctx);
    if (![...xs, xt].every(Number.isFinite)) continue;
    const mean = xs.reduce((a, x) => a + x, 0) / n;
    const sd = Math.sqrt(xs.reduce((a, x) => a + (x - mean) ** 2, 0) / n);
    if (sd < 1e-12) continue;
    used.push(name);
    const zt = (xt - mean) / sd;
    const fw = cfg.featureWeights[name] ?? 1;
    values.today[name] = xt;
    xs.forEach((x, i) => {
      values.pool[i][name] = x;
      d2[i] += fw * (zt - (x - mean) / sd) ** 2;
    });
  }
  const tag = (date) => [...(events?.[date] ?? [])].sort().join("|");
  const todayTag = tag(today.date);
  rows.forEach((r, i) => (d2[i] += tag(r.date) !== todayTag ? cfg.eventWeight : 0));

  // Widen the bandwidth until enough days carry weight; after 10 widenings, fall back to uniform.
  let h = cfg.bandwidth;
  let w;
  let ess;
  let fellBack = false;
  for (let it = 0; ; it++) {
    w = d2.map((d) => Math.exp(-d / (2 * h * h)));
    const sum = w.reduce((a, x) => a + x, 0);
    ess = (sum * sum) / w.reduce((a, x) => a + x * x, 0);
    if (ess >= cfg.minEss) break;
    if (it === 10) {
      w = w.map(() => 1);
      fellBack = true;
      ess = n;
      break;
    }
    h *= 1.5;
  }
  const top = rows
    .map((r, i) => ({ date: r.date, w: w[i] }))
    .sort((a, b) => b.w - a.w || (a.date > b.date) - (a.date < b.date))
    .slice(0, 5);

  // Volatility scale: today's rvol over the session's, kept within 0.5–2 (1 when the session's is 0).
  const rt = RVOL.value(now, ctx);
  const scale = cfg.volScale
    ? rows.map((r) => {
        const ri = RVOL.value(r, ctx);
        return ri === 0 ? 1 : Math.min(2, Math.max(0.5, rt / ri));
      })
    : null;
  return { w, diag: { used, ess, bandwidth: h, fellBack, top }, values, scale };
}

// Historical outcome stats for the detected patterns — the "momentum %". For every PAST
// occurrence of a pattern on THIS stock + timeframe (over the lookback window), it enters at the
// OPEN of the next bar and measures, for N = 3 / 6 / 12 bars:
//   • hit rate   — did price reach +X before −X in the pattern's direction, within N bars?
//   • avg return, MFE, MAE — direction-adjusted % move over the window
// All forward windows are cut off at 15:15 IST (no overnight carry) and never read past the bar.
// A same-direction random-bar baseline on the same stock gives the edge = hit rate − baseline.
// Everything is seeded PER SESSION (seed ⊕ date), so stats up to day D never change when later
// days are added — the look-ahead invariant.
import { SCANNER as CFG } from "../config/scanner.js";
import { istMinute, FWD_CAP_MIN } from "../lab/time.js";
import { atr as atrSeries } from "../lab/indicators.js";
import { sessionContext } from "./geometry.js";
import { detectAll } from "./detectors.js";
import { levelContext, tagBar } from "./levels.js";

const Z = { 0.95: 1.959963985, 0.9: 1.6448536269, 0.99: 2.5758293035 };

// Last index whose bar closes at or before 15:15.
export function forwardCapIndex(cs, intervalMin) {
  let cap = -1;
  for (let k = 0; k < cs.length; k++) {
    if (istMinute(cs[k].time) + intervalMin <= FWD_CAP_MIN) cap = k;
    else break;
  }
  return cap;
}

// Barrier fraction X (as a fraction of the entry price) for a signal at bar i.
function barrierX(cs, i, atr) {
  const b = CFG.stats.barrier;
  if (b.mode === "atr") {
    const a = atr ? atr[i] : null;
    return a ? (b.atrMult * a) / cs[i].close : null;
  }
  return b.pct / 100;
}

// First-touch outcome over bars [e, end]: "win" (+X first), "loss" (−X first), "none" (neither).
// Neutral patterns have no opposing barrier → always null (reported via avg move instead).
function outcome(cs, e, end, entry, direction, x) {
  if (direction === "neutral" || x == null) return null;
  const tie = CFG.stats.barrier.tieBreak;
  const up = entry * (1 + x);
  const down = entry * (1 - x);
  for (let k = e; k <= end; k++) {
    const hi = cs[k].high;
    const lo = cs[k].low;
    const t = direction === "long" ? hi >= up : lo <= down; // target
    const s = direction === "long" ? lo <= down : hi >= up; // stop
    if (t && s) return tie === "adverse" ? "loss" : "win";
    if (t) return "win";
    if (s) return "loss";
  }
  return "none";
}

// Direction-adjusted % move from entry to the window's last close, plus MFE / MAE (positive
// magnitudes: favourable and adverse excursion) over the window.
function excursion(cs, e, end, entry, direction) {
  let mfe = 0;
  let mae = 0;
  for (let k = e; k <= end; k++) {
    const up = ((cs[k].high - entry) / entry) * 100;
    const dn = ((entry - cs[k].low) / entry) * 100;
    const fav = direction === "short" ? dn : direction === "neutral" ? Math.max(up, dn) : up;
    const adv = direction === "short" ? up : direction === "neutral" ? Math.min(up, dn) : dn;
    if (fav > mfe) mfe = fav;
    if (adv > mae) mae = adv;
  }
  let ret = ((cs[end].close - entry) / entry) * 100;
  if (direction === "short") ret = -ret;
  else if (direction === "neutral") ret = Math.abs(ret);
  return { ret, mfe, mae };
}

class Acc {
  constructor() {
    this.win = 0;
    this.loss = 0;
    this.none = 0;
    this.n = 0;
    this.retSum = 0;
    this.mfeSum = 0;
    this.maeSum = 0;
  }
  add(o, ex) {
    this.n++;
    if (o === "win") this.win++;
    else if (o === "loss") this.loss++;
    else if (o === "none") this.none++;
    this.retSum += ex.ret;
    this.mfeSum += ex.mfe;
    this.maeSum += ex.mae;
  }
}

const hashStr = (s) => [...String(s)].reduce((h, c) => (Math.imul(h, 31) + c.charCodeAt(0)) >>> 0, 7);
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function wilson(wins, n, conf) {
  if (!n) return null;
  const z = Z[conf] ?? Z[0.95];
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, center - half), Math.min(1, center + half)];
}

const newGroupH = (horizons) => Object.fromEntries(horizons.map((N) => [N, { overall: new Acc(), atLevel: new Acc(), notLevel: new Acc(), highVol: new Acc(), lowVol: new Acc() }]));

/**
 * sessions: one stock + timeframe, from buildSessions (oldest first, inside the lookback window).
 * Returns { byName: Map(name -> group), baseline: { long, short } } where a group carries, per
 * horizon, the overall + context-split accumulators and the detection's direction / id.
 */
export function collect(sessions, intervalMin) {
  const cfg = CFG.stats;
  const horizons = cfg.horizons;
  const groups = new Map();
  const baseline = { long: newGroupH(horizons), short: newGroupH(horizons) };
  const needAtr = cfg.barrier.mode === "atr";

  const group = (h) => {
    let g = groups.get(h.name);
    if (!g) groups.set(h.name, (g = { name: h.name, id: h.id, direction: h.direction, h: newGroupH(horizons), occurrences: 0 }));
    return g;
  };

  for (const s of sessions) {
    if (s.special) continue;
    const cs = s.candles;
    const cap = forwardCapIndex(cs, intervalMin);
    if (cap < 1) continue;
    const ctx = sessionContext(cs);
    const lc = levelContext(s, intervalMin);
    const atr = needAtr ? atrSeries(cs, cfg.barrier.atrPeriod) : null;

    for (const h of detectAll(cs, ctx)) {
      const e = h.index + 1; // enter at the open of the NEXT bar
      if (e > cap) continue; // the entry bar must still close by 15:15
      const entry = cs[e].open;
      const x = barrierX(cs, h.index, atr);
      const tag = tagBar(cs, h.index, lc);
      const g = group(h);
      g.occurrences++;
      for (const N of horizons) {
        const end = Math.min(e + N - 1, cap);
        const o = outcome(cs, e, end, entry, h.direction, x);
        const ex = excursion(cs, e, end, entry, h.direction);
        const cell = g.h[N];
        cell.overall.add(o, ex);
        (tag.atLevel ? cell.atLevel : cell.notLevel).add(o, ex);
        (tag.highVolume ? cell.highVol : cell.lowVol).add(o, ex);
      }
    }

    // Same-direction random-bar baseline (seeded per session → look-ahead safe).
    const rnd = mulberry32(cfg.seed ^ hashStr(s.date));
    for (const dir of ["long", "short"]) {
      for (let k = 0; k < cfg.baselineSamplesPerSession; k++) {
        const i = Math.floor(rnd() * cap); // signal bar in [0, cap)
        const e = i + 1;
        if (e > cap) continue;
        const entry = cs[e].open;
        const x = barrierX(cs, i, atr);
        for (const N of horizons) {
          const end = Math.min(e + N - 1, cap);
          baseline[dir][N].overall.add(outcome(cs, e, end, entry, dir, x), excursion(cs, e, end, entry, dir));
        }
      }
    }
  }
  return { byName: groups, baseline };
}

// One accumulator → a reported block (null hit rate for neutral / insufficient).
function block(acc, baseAcc, direction, minCount, conf) {
  const n = acc.n;
  const neutral = direction === "neutral";
  const hitRate = neutral || !n ? null : acc.win / n;
  const base = neutral || !baseAcc || !baseAcc.n ? null : baseAcc.win / baseAcc.n;
  const edge = hitRate != null && base != null ? hitRate - base : null;
  return {
    n,
    sufficient: n >= minCount,
    hitRate: n >= minCount ? hitRate : null,
    wilson: n >= minCount && !neutral ? wilson(acc.win, n, conf) : null,
    baseline: n >= minCount ? base : null,
    edge: n >= minCount ? edge : null,
    avgReturn: n ? acc.retSum / n : null,
    avgMfe: n ? acc.mfeSum / n : null,
    avgMae: n ? acc.maeSum / n : null,
    wins: acc.win,
    losses: acc.loss,
    neither: acc.none,
  };
}

/** Summarise one group across horizons and context splits against its direction's baseline. */
export function summarize(group, baseline) {
  const cfg = CFG.stats;
  const byHorizon = {};
  for (const N of cfg.horizons) {
    const base = baseline[group.direction]?.[N]?.overall ?? null;
    const cell = group.h[N];
    byHorizon[N] = {
      overall: block(cell.overall, base, group.direction, cfg.minCount, cfg.confidence),
      atLevel: block(cell.atLevel, base, group.direction, cfg.minCount, cfg.confidence),
      notLevel: block(cell.notLevel, base, group.direction, cfg.minCount, cfg.confidence),
      highVol: block(cell.highVol, base, group.direction, cfg.minCount, cfg.confidence),
      lowVol: block(cell.lowVol, base, group.direction, cfg.minCount, cfg.confidence),
    };
  }
  return { name: group.name, id: group.id, direction: group.direction, occurrences: group.occurrences, primaryHorizon: cfg.primaryHorizon, horizons: byHorizon };
}

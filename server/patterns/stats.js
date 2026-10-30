// Same-session pattern statistics.
// For each hit at bar i: forward return from close[i] to close[i+N], capped at the last bar
// that closes by 15:15 THE SAME DAY. Compared with a baseline of random bars from the same
// sessions (seeded, so runs are repeatable), measured the same way and in the same direction.
import { LAB } from "../config/lab.js";
import { istMinute, FWD_CAP_MIN, timeBucket, TIME_BUCKETS } from "../lab/time.js";
import { detectSession } from "./index.js";

// Last index whose bar closes at or before 15:15.
export function forwardCapIndex(candles, intervalMin) {
  let cap = -1;
  for (let k = 0; k < candles.length; k++) {
    if (istMinute(candles[k].time) + intervalMin <= FWD_CAP_MIN) cap = k;
    else break;
  }
  return cap;
}

// Signed % return; null if bar i is at/after the cap.
export function forwardReturn(candles, i, n, cap, direction) {
  if (i >= cap) return null;
  const j = Math.min(i + n, cap);
  const r = ((candles[j].close - candles[i].close) / candles[i].close) * 100;
  if (direction === "short") return -r;
  if (direction === "neutral") return Math.abs(r);
  return r;
}

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

class Acc {
  constructor() {
    this.n = 0;
    this.sum = 0;
    this.sq = 0;
    this.wins = 0;
  }
  add(r) {
    this.n++;
    this.sum += r;
    this.sq += r * r;
    if (r > 0) this.wins++;
  }
  get mean() {
    return this.n ? this.sum / this.n : null;
  }
  get variance() {
    return this.n > 1 ? (this.sq - (this.sum * this.sum) / this.n) / (this.n - 1) : null;
  }
}

function welchT(a, b) {
  if (a.n < 2 || b.n < 2) return null;
  const se = Math.sqrt(a.variance / a.n + b.variance / b.n);
  return se > 0 ? (a.mean - b.mean) / se : null;
}

function summarize(hitAcc, baseAcc, neutral, minCount) {
  const t = welchT(hitAcc, baseAcc);
  const avg = hitAcc.mean;
  const base = baseAcc.mean;
  const winRate = neutral || !hitAcc.n ? null : (hitAcc.wins / hitAcc.n) * 100;
  const baseWin = neutral || !baseAcc.n ? null : (baseAcc.wins / baseAcc.n) * 100;
  let label;
  // "edge" = beats the baseline on average move AND win rate, with Welch t ≥ 2 (≈95%);
  // "weak edge" = beats it with t ≥ 1; anything else is indistinguishable from random bars.
  if (hitAcc.n < minCount) label = "not enough data";
  else if (avg > base && (neutral || winRate > baseWin) && t != null && t >= 1) label = t >= 2 ? "edge" : "weak edge";
  else label = "no edge";
  return { count: hitAcc.n, avgMove: avg, winRate, baseAvgMove: base, baseWinRate: baseWin, t, label };
}

/**
 * sessionsBySymbol: [{ symbol, sessions }] ; returns per-pattern-name stats.
 * opts: { intervalMin, patternIds, horizons, onProgress }
 */
export function patternStats(sessionsBySymbol, opts) {
  const cfg = LAB.patternStats;
  const horizons = opts.horizons?.length ? opts.horizons : cfg.horizons;
  const rand = mulberry32(cfg.seed);
  const groups = new Map(); // name -> group
  const total = sessionsBySymbol.reduce((s, x) => s + x.sessions.length, 0);
  let done = 0;

  const group = (name, direction) => {
    if (!groups.has(name)) {
      const g = { name, direction, hits: 0, capped: 0, h: {}, buckets: {} };
      for (const n of horizons) g.h[n] = { hit: new Acc(), base: new Acc() };
      for (const b of TIME_BUCKETS) {
        g.buckets[b.id] = { count: 0, h: {} };
        for (const n of horizons) g.buckets[b.id].h[n] = { hit: new Acc(), base: new Acc() };
      }
      groups.set(name, g);
    }
    return groups.get(name);
  };

  for (const { sessions } of sessionsBySymbol) {
    for (const s of sessions) {
      done++;
      if (s.special) continue;
      const cs = s.candles;
      const cap = forwardCapIndex(cs, opts.intervalMin);
      if (cap < 1) continue;
      const hits = detectSession(cs, opts.patternIds);
      for (const h of hits) {
        if (h.index >= cap) continue; // no forward window left before 15:15
        const g = group(h.name, h.direction);
        g.hits++;
        const bucket = timeBucket(istMinute(cs[h.index].time));
        if (bucket) g.buckets[bucket].count++;
        for (const n of horizons) {
          if (h.index + n > cap) g.capped++;
          const r = forwardReturn(cs, h.index, n, cap, h.direction);
          g.h[n].hit.add(r);
          if (bucket) g.buckets[bucket].h[n].hit.add(r);
          for (let k = 0; k < cfg.baselineSamplesPerHit; k++) {
            const j = Math.floor(rand() * cap); // random bar of the same session, before the cap
            const br = forwardReturn(cs, j, n, cap, h.direction);
            g.h[n].base.add(br);
            if (bucket) g.buckets[bucket].h[n].base.add(br);
          }
        }
      }
      if (opts.onProgress && done % 25 === 0) opts.onProgress(done, total);
    }
  }

  const out = [];
  for (const g of groups.values()) {
    const neutral = g.direction === "neutral";
    const byHorizon = {};
    for (const n of horizons) byHorizon[n] = summarize(g.h[n].hit, g.h[n].base, neutral, cfg.minCount);
    const buckets = {};
    for (const b of TIME_BUCKETS) {
      buckets[b.id] = { count: g.buckets[b.id].count, h: {} };
      for (const n of horizons) {
        buckets[b.id].h[n] = summarize(g.buckets[b.id].h[n].hit, g.buckets[b.id].h[n].base, neutral, cfg.minCount);
      }
    }
    const primary = byHorizon[cfg.primaryHorizon] ?? byHorizon[horizons[0]];
    out.push({
      name: g.name,
      direction: g.direction,
      count: g.hits,
      cappedPct: g.hits ? (g.capped / (g.hits * horizons.length)) * 100 : 0,
      horizons: byHorizon,
      buckets,
      label: primary.label,
    });
  }
  out.sort((a, b) => b.count - a.count);
  return { horizons, primaryHorizon: cfg.primaryHorizon, patterns: out, measure: "% move from signal close, direction-adjusted; neutral patterns use |move|" };
}

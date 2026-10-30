// Scoring a model's past calls. A call is right when the price moved the way it said.
//
// Baseline = the hit rate of always calling the more common direction, every day of the test
// (in a rising market "always bullish" scores well without any skill). A model only "has an
// edge" when its hit rate on the days it made a call beats that baseline by `significanceZ`
// standard errors. Overlapping multi-day windows aren't independent, so the sample size is
// divided by the horizon.
import { PREDICTION } from "../config/prediction.js";
import { mean } from "./features.js";

// +1 bullish, −1 bearish, 0 neutral.
export function callOf(score, band = PREDICTION.neutralBand) {
  if (score == null || !Number.isFinite(score)) return null;
  return score > band ? 1 : score < -band ? -1 : 0;
}

export const CALL_NAME = { 1: "bullish", "-1": "bearish", 0: "neutral" };

/**
 * samples: [{ call: 1 | -1 | 0, fwd }] — fwd = forward return (fraction).
 * returns { samples, calls, coverage, hitRate, baseline, edge, z, avgBullPct, avgBearPct, bullCalls, bearCalls, verdict }
 *   verdict: "edge" | "no-edge" | "worse" | "insufficient"
 */
export function summarize(samples, { horizon = 1, minCalls, z: zNeed = PREDICTION.significanceZ } = {}) {
  const moved = samples.filter((s) => s.fwd !== 0);
  const calls = moved.filter((s) => s.call);
  const n = calls.length;
  const out = { samples: samples.length, calls: n, coverage: samples.length ? n / samples.length : null };
  if (!n) return { ...out, hitRate: null, baseline: null, edge: null, z: null, avgBullPct: null, avgBearPct: null, bullCalls: 0, bearCalls: 0, verdict: "insufficient" };
  const hits = calls.filter((s) => Math.sign(s.fwd) === s.call).length;
  const up = moved.filter((s) => s.fwd > 0).length / moved.length;
  const baseline = Math.max(up, 1 - up);
  const hitRate = hits / n;
  const nEff = n / horizon;
  const se = Math.sqrt((baseline * (1 - baseline)) / nEff);
  const z = se > 0 ? (hitRate - baseline) / se : 0;
  const bull = calls.filter((s) => s.call > 0);
  const bear = calls.filter((s) => s.call < 0);
  const verdict = n < minCalls ? "insufficient" : z >= zNeed ? "edge" : hitRate < baseline ? "worse" : "no-edge";
  return {
    ...out,
    hitRate,
    baseline,
    edge: hitRate - baseline,
    z,
    avgBullPct: bull.length ? mean(bull.map((s) => s.fwd)) * 100 : null,
    avgBearPct: bear.length ? mean(bear.map((s) => s.fwd)) * 100 : null,
    bullCalls: bull.length,
    bearCalls: bear.length,
    verdict,
  };
}

// Weighted average of member scores (members with no score are left out).
export function ensembleScore(scores, weights) {
  let s = 0;
  let w = 0;
  for (const [id, sc] of Object.entries(scores)) {
    const wt = weights[id] ?? 0;
    if (sc == null || !wt) continue;
    s += wt * sc;
    w += wt;
  }
  return w ? s / w : null;
}

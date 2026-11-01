import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px } from "./planKit.js";
import { roundTick, tickFor } from "../decision/util.js";
import { hhmmToMin, OPEN_MIN } from "../lab/time.js";
import { rvolFromProfile } from "./volumeBreakoutV2.js";
import { circuitRoom } from "./gapAndGoV2.js";
import { cprRegime } from "../plans/arbiter.js";
import { supertrend as stCalc } from "../lab/indicators.js";
import { GAP } from "../config/gap.js";

// Supertrend Trend v2 — a staged CHECKLIST pipeline. Every candidate passes stages 1→6 in order;
// a failed MANDATORY check stops it at that stage, SCORED checks add to a 0–100 setup score, and the
// signal fires only when all mandatory pass and score ≥ threshold. `evaluate(ctx,p)` returns the full
// checklist so the UI and the Phase-3 funnel can show/▣ count what each check filtered. v1 stays as
// `supertrend`. Closed candles only; the engine fills next-bar-open with costs/slippage/sizing.
//
// shortcut: Supertrend is session-bound (no cross-session seeding in this framework); warm-up is
//   `warmupMult × period` bars within the session (3× is the spec ideal but pushes entries past noon).
//   Higher-timeframe Supertrend is the session's 5m bars aggregated to 15m (no separate 15m feed).
//   Eligibility/band lists come from config/gap.js (empty → check skipped). True T1-partial-then-trail
//   needs engine partials; v2 rides the Supertrend line (exit on flip) with a 1.5R option + time stop.

const SCORE_WEIGHTS = { cprRegime: 15, atrPct: 10, pullback: 20, rvol: 20, nifty: 20, sector: 15 };

const atrAt = (ctx, ago = 0) => ctx.ind("atr", [ctx.params.period], ago);

// Higher-timeframe (15m) Supertrend direction applicable at each 5m bar (last COMPLETED 15m bar).
// Memoised per session; each element depends only on bars ≤ it, so it is causal / truncation-safe.
function htfDirByBar(ctx, p) {
  return ctx.sd.memo(`htf|${p.htfMin}|${p.period}|${p.mult}`, () => {
    const cs = ctx.sd.candles, mins = ctx.sd.minutes, n = cs.length;
    const buckets = []; // { bars:[...], endK }
    let cur = null, curIdx = -1;
    for (let k = 0; k < n; k++) {
      const bi = Math.floor((mins[k] - OPEN_MIN) / p.htfMin);
      if (bi !== curIdx) { cur = { open: cs[k].open, high: cs[k].high, low: cs[k].low, close: cs[k].close, endK: k }; buckets.push(cur); curIdx = bi; }
      else { cur.high = Math.max(cur.high, cs[k].high); cur.low = Math.min(cur.low, cs[k].low); cur.close = cs[k].close; cur.endK = k; }
    }
    const stf = stCalc(buckets, p.period, p.mult);
    const out = new Array(n).fill(null);
    // For 5m bar k, use the dir of the last 15m bucket whose end index < k's bucket start (fully closed).
    let b = 0;
    for (let k = 0; k < n; k++) {
      while (b + 1 < buckets.length && buckets[b + 1].endK <= k) b++;
      // the bucket ending exactly at k is still "the current, just-closed" one — use the one before it
      const useB = buckets[b].endK <= k ? b : b - 1;
      out[k] = useB >= 0 ? stf.dir[useB] : null;
    }
    return out;
  });
}

// Count distinct pullbacks so far in the current trend (bars that came within pullbackAtr×ATR of the
// line, grouped into touches). Returns the current touch number (1 = first pullback).
function pullbackNumber(ctx, p, sinceK, side) {
  let touches = 0, inTouch = false;
  for (let k = sinceK; k <= ctx.i; k++) {
    const st = ctx.ind("supertrend", [p.period, p.mult], ctx.i - k);
    const a = atrAt(ctx, ctx.i - k);
    if (st?.value == null || a == null) { inTouch = false; continue; }
    const bar = ctx.bar(k);
    const near = side === "long" ? bar.low <= st.value + p.pullbackAtr * a : bar.high >= st.value - p.pullbackAtr * a;
    if (near && !inTouch) { touches++; inTouch = true; }
    else if (!near) inTouch = false;
  }
  return Math.max(1, touches);
}

// First bar index of the current trend (dir unchanged back to here).
function trendStart(ctx, p, dir) {
  let k = ctx.i;
  for (; k > 0; k--) { const s = ctx.ind("supertrend", [p.period, p.mult], ctx.i - (k - 1)); if (s?.dir !== dir) break; }
  return k;
}

/**
 * The full checklist. Returns { status: "READY" | "REJECTED", stage, score, checks[], signal }.
 * Pure w.r.t. ctx (reads bars ≤ i only). onBar and the Phase-3 funnel both call this.
 */
export function evaluate(ctx, p) {
  const checks = [];
  let score = 0;
  const add = (name, stage, type, passed, value, threshold) => { checks.push({ name, stage, type, passed, value, threshold }); return passed; };
  const mand = (name, stage, passed, value, threshold) => add(name, stage, "MANDATORY", passed, value, threshold);
  const scored = (name, stage, pts, got, value, threshold) => { if (got) score += pts; return add(name, stage, "SCORED", got, value, threshold); };
  const reject = (stage) => ({ status: "REJECTED", stage, score, checks, signal: null });

  const st = ctx.ind("supertrend", [p.period, p.mult]);
  const prev = ctx.ind("supertrend", [p.period, p.mult], 1);
  const atr = atrAt(ctx);

  // ── STAGE 1 — DATA & CALC INTEGRITY ──
  if (!mand("st-calc", "1.1", st?.dir != null && prev?.dir != null && atr != null, st?.value ?? null, "computed")) return reject("1.1");
  const warmBars = Math.ceil(p.warmupMult * p.period);
  if (!mand("warm-up", "1.2", ctx.i >= warmBars, ctx.i, warmBars)) return reject("1.2");
  let contiguous = true;
  for (let k = Math.max(1, ctx.i - 3); k <= ctx.i; k++) if (ctx.minute(k) - ctx.minute(k - 1) !== ctx.intervalMin) contiguous = false;
  if (!mand("closed+contiguous", "1.3", contiguous, "no-gaps", "contiguous")) return reject("1.3");
  if (!mand("eligible", "1.4", !(p.useEligibility && GAP.exclude.has(ctx.symbol)), ctx.symbol, "EQ/MIS")) return reject("1.4");

  const dir = st.dir; // current Supertrend direction
  const side = dir === 1 ? "long" : "short";

  // ── STAGE 2 — REGIME ──
  const adx = ctx.ind("adx", [14])?.adx ?? null;
  let atrAvg = 0, cnt = 0;
  for (let k = 0; k < 20; k++) { const a = atrAt(ctx, k); if (a != null) { atrAvg += a; cnt++; } }
  atrAvg = cnt ? atrAvg / cnt : null;
  const regimeOk = (adx != null && adx >= p.adxMin) || (atrAvg != null && atr > atrAvg);
  if (!mand("trend-regime", "2.1", !p.useRegime || regimeOk, adx == null ? `ATR>avg:${atr > atrAvg}` : `ADX ${adx.toFixed(0)}`, `ADX≥${p.adxMin} or ATR>avg`)) return reject("2.1");
  const htf = htfDirByBar(ctx, p)[ctx.i];
  if (!mand("htf-align", "2.2", !p.useHtf || htf == null || htf === dir, htf, dir)) return reject("2.2");
  const reg = cprRegime(ctx.pivots?.cprWidthPct, ctx.ref.daily || []);
  scored("cpr-regime", "2.3", SCORE_WEIGHTS.cprRegime, reg.tag !== "WIDE", reg.tag, "NARROW/NORMAL");
  scored("atr-percentile", "2.4", SCORE_WEIGHTS.atrPct, atrAvg != null && atr >= atrAvg * 0.9, atrAvg ? (atr / atrAvg).toFixed(2) : null, "not bottom 20%");

  // ── STAGE 3 — SETUP & TRIGGER ──
  const c = ctx.bar(), prevBar = ctx.bar(ctx.i - 1);
  const tStart = trendStart(ctx, p, dir);
  const trendAge = ctx.i - tStart + 1;
  const flippedNow = prev.dir !== dir;
  const nearLine = side === "long" ? c.low <= st.value + p.pullbackAtr * atr : c.high >= st.value - p.pullbackAtr * atr;
  const nearVwap = (() => { const v = ctx.ind("vwap"); return v != null && (side === "long" ? c.low <= v + p.pullbackAtr * atr : c.high >= v - p.pullbackAtr * atr); })();
  const resumes = side === "long" ? c.close > prevBar.high : c.close < prevBar.low;
  const confirmFlip = flippedNow ? false : prev.dir === dir && (ctx.ind("supertrend", [p.period, p.mult], 2)?.dir !== dir); // flip was the previous bar, this bar confirms
  let mode = null;
  const wantA = p.entryMode === "A" || p.entryMode === "both";
  const wantB = p.entryMode === "B" || p.entryMode === "both";
  if (wantA && trendAge >= p.trendMinBars && (nearLine || nearVwap) && resumes) mode = "A";
  if (!mode && wantB && confirmFlip && (side === "long" ? c.close > prevBar.close : c.close < prevBar.close)) mode = "B";
  if (!mand("entry-mode", "3.1", mode != null, mode ?? "none", p.entryMode)) return reject("3.1");
  const distAtr = Math.abs(c.close - st.value) / atr;
  if (!mand("distance-to-line", "3.2", distAtr <= p.maxDistAtr, distAtr.toFixed(2), `≤${p.maxDistAtr}`)) return reject("3.2");
  const m = ctx.minute();
  if (!mand("time-window", "3.3", m >= hhmmToMin(p.entryStart) && m < hhmmToMin(p.lateFlipCutoff), ctx.minute(), `${p.entryStart}-${p.lateFlipCutoff}`)) return reject("3.3");
  const pbNum = mode === "A" ? pullbackNumber(ctx, p, tStart, side) : 1;
  scored("pullback-number", "3.4", pbNum === 1 ? SCORE_WEIGHTS.pullback : pbNum === 2 ? SCORE_WEIGHTS.pullback / 2 : 0, pbNum <= 2, pbNum, "1st/2nd");

  // ── STAGE 4 — CONFIRMATION ──
  const vwap = ctx.ind("vwap");
  if (!mand("vwap-side", "4.1", !p.useVwap || vwap == null || (side === "long" ? c.close > vwap : c.close < vwap), vwap == null ? "n/a" : (side === "long" ? "above" : "below"), "correct side")) return reject("4.1");
  const rvol = rvolFromProfile(ctx.ref.profile, ctx.minute(), c.volume || 0, p.rvolDays).rvol;
  scored("trigger-rvol", "4.2", SCORE_WEIGHTS.rvol, rvol != null && rvol >= p.rvolMin, rvol == null ? null : rvol.toFixed(1), `≥${p.rvolMin}`);
  const nif = ctx.market("nifty");
  const nifAgrees = nif && nif.vwap != null ? (side === "long" ? nif.close > nif.vwap : nif.close < nif.vwap) : null;
  scored("nifty-agrees", "4.3", SCORE_WEIGHTS.nifty, nifAgrees === true, nifAgrees, "agrees");
  const sec = ctx.market("sector");
  const secAgrees = sec && sec.vwap != null ? (side === "long" ? sec.close > sec.vwap : sec.close < sec.vwap) : null;
  scored("sector-agrees", "4.4", SCORE_WEIGHTS.sector, secAgrees === true, secAgrees, "agrees");

  // ── STAGE 5 — RISK & PLAN ──
  const tk = tickFor(c.close);
  let stop = side === "long" ? st.value - p.stopBufAtr * atr : st.value + p.stopBufAtr * atr;
  if (side === "long" && c.close - stop < p.minStopAtr * atr) stop = c.close - p.minStopAtr * atr;
  if (side === "short" && stop - c.close < p.minStopAtr * atr) stop = c.close + p.minStopAtr * atr;
  stop = roundTick(stop, tk, side === "long" ? "down" : "up");
  const risk = Math.abs(c.close - stop);
  if (!mand("stop-valid", "5.1", risk > 0 && (side === "long" ? stop < c.close : stop > c.close), stop, "line∓0.1ATR")) return reject("5.1");
  const t1 = side === "long" ? c.close + p.t1R * risk : c.close - p.t1R * risk;
  const rewardAfterCosts = Math.abs(t1 - c.close) - (c.close * p.costCushionPct) / 100;
  if (!mand("R-after-costs", "5.3", rewardAfterCosts / risk >= p.minRR, (rewardAfterCosts / risk).toFixed(2), `≥${p.minRR}`)) return reject("5.3");
  const room = circuitRoom(c.close, GAP.bandPct[ctx.symbol], atr, side);
  if (!mand("circuit-room", "5.4", !p.useCircuit || room == null || room >= p.circuitAtr, room == null ? "no band" : room.toFixed(1), `≥${p.circuitAtr}`)) return reject("5.4");

  // ── STAGE 6 — FINAL ──
  if (!mand("score-threshold", "6.1", score >= p.minScore, score, `≥${p.minScore}`)) return reject("6.1");
  const target = p.targetMode === "t1" ? roundTick(t1, tk, side === "long" ? "down" : "up") : null; // null = ride the line (exit on flip)
  return {
    status: "READY", stage: "6.4", score, checks,
    signal: { side, stop, target, mode, pbNum, reason: `ST-v2 ${mode} ${side} score=${score}/100 dist=${distAtr.toFixed(1)}ATR ADX=${adx == null ? "–" : adx.toFixed(0)} RVOL=${rvol == null ? "–" : rvol.toFixed(1)} reg=${reg.tag} pb#${pbNum}` },
  };
}

export default defineStrategy({
  id: "supertrendV2",
  levels: ["supertrend", "vwap"],
  name: "Supertrend Trend v2",
  description:
    "Staged checklist pipeline on the Supertrend: Stage 1 calc/warm-up/eligibility, Stage 2 ADX/ATR + 15m-Supertrend regime, Stage 3 Mode A pullback / Mode B flip with a distance-to-line cap and time window, Stage 4 VWAP + RVOL + NIFTY/sector confirmation, Stage 5 line stop + R-after-costs + circuit room + time stop, Stage 6 score ≥ threshold. Rides the line (exit on flip) or a 1.5R target. Every check toggleable.",
  defaultInterval: "5m",
  needsMarket: true,
  params: {
    targetR: 0, // ride the Supertrend line (exit on flip); targetMode "t1" switches to a 1.5R exit
    period: 10, mult: 3, htfMin: 15, exitOnFlip: true,
    // stage 1
    warmupMult: 2, useEligibility: true,
    // stage 2
    useRegime: true, adxMin: 20, useHtf: true,
    // stage 3
    entryMode: "A", trendMinBars: 3, pullbackAtr: 0.5, maxDistAtr: 2.0, lateFlipCutoff: "14:30",
    // stage 4
    useVwap: true, rvolMin: 1.3, rvolDays: 20,
    // stage 5
    stopBufAtr: 0.1, minStopAtr: 0.5, t1R: 1.5, targetMode: "flip", useRR: true, minRR: 1.2, costCushionPct: 0.12,
    useCircuit: true, circuitAtr: 2.0, timeStopBars: 8, timeStopMinR: 0.5, maxReentries: 1, forceFlat: "15:12",
    // stage 6
    minScore: 60,
    entryStart: "09:30", entryEnd: "14:00",
  },
  spec: [
    { key: "period", label: "ATR period", type: "number", step: 1 },
    { key: "mult", label: "Multiplier", type: "number", step: 0.1 },
    { key: "htfMin", label: "Higher timeframe (min)", type: "number", step: 5 },
    { key: "warmupMult", label: "Warm-up (× period bars)", type: "number", step: 0.5 },
    { key: "useRegime", label: "2.1 ADX / ATR regime", type: "bool" },
    { key: "adxMin", label: "Min ADX", type: "number", step: 1 },
    { key: "useHtf", label: "2.2 Higher-TF Supertrend align", type: "bool" },
    { key: "entryMode", label: "Entry mode", type: "select", options: ["A", "B", "both"] },
    { key: "trendMinBars", label: "Mode A: trend ≥ N bars", type: "number", step: 1 },
    { key: "pullbackAtr", label: "Pullback within (× ATR)", type: "number", step: 0.1 },
    { key: "maxDistAtr", label: "3.2 Max distance to line (× ATR)", type: "number", step: 0.1 },
    { key: "lateFlipCutoff", label: "Ignore flips after", type: "time" },
    { key: "useVwap", label: "4.1 VWAP side", type: "bool" },
    { key: "rvolMin", label: "Trigger RVOL ≥", type: "number", step: 0.1 },
    { key: "stopBufAtr", label: "Stop beyond line (× ATR)", type: "number", step: 0.05 },
    { key: "minStopAtr", label: "Min stop (× ATR)", type: "number", step: 0.1 },
    { key: "t1R", label: "T1 (R)", type: "number", step: 0.1 },
    { key: "targetMode", label: "Exit", type: "select", options: ["flip", "t1"] },
    { key: "useRR", label: "5.3 R-after-costs check", type: "bool" },
    { key: "minRR", label: "Min reward:risk", type: "number", step: 0.1 },
    { key: "useCircuit", label: "5.4 Circuit room", type: "bool" },
    { key: "circuitAtr", label: "Min circuit room (× ATR)", type: "number", step: 0.1 },
    { key: "timeStopBars", label: "Time stop after N bars", type: "number", step: 1 },
    { key: "maxReentries", label: "Max re-entries per trend", type: "number", step: 1 },
    { key: "forceFlat", label: "Force flat by", type: "time" },
    { key: "minScore", label: "6.1 Min setup score", type: "number", step: 5 },
  ],
  testParams: { entryMode: "B", warmupMult: 1, useRegime: false, useHtf: false, useVwap: false, useCircuit: false, useRR: false, useEligibility: false, minScore: 0, maxDistAtr: 99 },
  warmup: (p) => Math.ceil(p.warmupMult * p.period) + 1,
  onBar(ctx) {
    const p = ctx.params;
    const atr = atrAt(ctx);

    if (ctx.position) {
      const pos = ctx.position;
      if (ctx.state.heldIndex !== pos.entryIndex) { ctx.state.heldIndex = pos.entryIndex; ctx.state.entryRisk = Math.abs(pos.entry - pos.stop); }
      if (ctx.minute() >= hhmmToMin(p.forceFlat)) return { exit: true, reason: `Force flat ${p.forceFlat}` };
      const st = ctx.ind("supertrend", [p.period, p.mult]);
      if (p.exitOnFlip && st?.dir != null && st.dir !== (pos.side === "long" ? 1 : -1)) return { exit: true, reason: "Supertrend flipped" };
      if (p.timeStopBars > 0 && ctx.state.entryRisk > 0) {
        const held = ctx.i - pos.entryIndex;
        const favR = (pos.side === "long" ? ctx.bar().close - pos.entry : pos.entry - ctx.bar().close) / ctx.state.entryRisk;
        if (held >= p.timeStopBars && favR < p.timeStopMinR) return { exit: true, reason: `No ${p.timeStopMinR}R in ${p.timeStopBars} bars` };
      }
      return null;
    }
    if (ctx.i < 1 || atr == null) return null;

    // Re-entry cap per trend (reset when the Supertrend direction changes).
    const st = ctx.ind("supertrend", [p.period, p.mult]);
    if (st?.dir != null) {
      if (ctx.state.trendDir !== st.dir) { ctx.state.trendDir = st.dir; ctx.state.attempts = 0; }
      if (ctx.state.attempts > p.maxReentries) return null;
    }

    const res = evaluate(ctx, p);
    if (res.status !== "READY") return null;
    ctx.state.attempts = (ctx.state.attempts || 0) + 1;
    return res.signal;
  },
  plan(ctx) {
    const p = ctx.params;
    const st = ctx.ind("supertrend", [p.period, p.mult]);
    if (!st || st.dir == null) return waiting(`Supertrend needs ${Math.ceil(p.warmupMult * p.period) + 1} bars (restarts each session).`);
    const res = evaluate(ctx, p);
    const side = st.dir === 1 ? "long" : "short";
    const a = atrAt(ctx) ?? 0;
    if (res.status === "READY") {
      const s = res.signal;
      return watch([{ side: s.side, trigger: ctx.bar().close, when: `${s.mode === "A" ? "pullback resume" : "flip confirm"} — checklist READY (score ${res.score})`, stop: s.stop, target: s.target, approx: true }], `Supertrend ${side}, score ${res.score}/100, ${s.mode === "A" ? "Mode A pullback" : "Mode B flip"}`);
    }
    const failed = res.checks.find((c) => c.type === "MANDATORY" && !c.passed);
    return off(`Supertrend ${side} — checklist REJECTED at ${res.stage}${failed ? ` (${failed.name}: ${failed.value} vs ${failed.threshold})` : ""}, score ${res.score}/100. Line ${px(st.value)}.`);
  },
});

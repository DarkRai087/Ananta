import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px, orEnd, hasBars } from "./planKit.js";
import { roundTick, tickFor } from "../decision/util.js";
import { hhmmToMin, OPEN_MIN } from "../lab/time.js";
import { rvolFromProfile } from "./volumeBreakoutV2.js";
import { gapMetrics, classifyGap, sizeBucket, relativeGap, circuitRoom, gapFailed, openingRvol } from "./gapAndGoV2.js";
import { classifyGapDay, CLASSIFIER_DEFAULTS } from "./gapClassifier.js";
import { GAP } from "../config/gap.js";

// Gap Fill / Fade v2. Reuses the gap_go_v2 gap module (official-close proxy, gapATR, FULL/PARTIAL,
// relative gap, circuit room) and the shared GO/FADE classifier for mutual exclusion with Gap and Go.
// Fades only a noise gap (small relative gap, no catalyst, quiet open) that FAILS — trigger A (OR
// break), B (VWAP loss after a lower high), or C (rejection at a level) — targeting T1 (50% fill)
// then the full fill, with a no-widen post-open-high stop, time stop and one attempt/day. v1 stays as
// `gapFade`. Signals on closed bars only; the engine fills at the next open with costs/slippage/sizing.
//
// shortcut: official-close gap, ex-date/catalyst/band/eligibility and relative-gap beta are the same
//   proxies/limits as gap_go_v2 (see config/gap.js and CHANGES g). True T1-partial-then-trail needs
//   engine partials (one-exit engine) — v2 takes T1 (or T2) as a single bankable exit, configurable.

const atrOf = (ctx) => ctx.ind("atr", [ctx.params.atrPeriod]) ?? null;

// Did a lower high form post-open before bar i? (the peak is not in the last two bars.)
function lowerHighFormed(ctx, from, side) {
  let peakK = from, peak = side === "short" ? -Infinity : Infinity;
  for (let k = from; k <= ctx.i; k++) {
    const v = side === "short" ? ctx.bar(k).high : ctx.bar(k).low;
    if (side === "short" ? v > peak : v < peak) { peak = v; peakK = k; }
  }
  return ctx.i - peakK >= 2; // the extreme is at least two bars old → price has rolled over
}

// Trigger C: a rejection candle at an overhead (short) / underfoot (long) level in the first hour.
function levelRejection(ctx, side, atr, p) {
  if (ctx.minute() >= OPEN_MIN + 60) return null;
  const c = ctx.bar();
  const range = c.high - c.low;
  if (range <= 0) return null;
  const loc = (c.close - c.low) / range;
  const pv = ctx.pivots;
  const wk = ctx.ref.daily.length >= 5 ? (side === "short" ? Math.max(...ctx.ref.daily.slice(-5).map((d) => d.high)) : Math.min(...ctx.ref.daily.slice(-5).map((d) => d.low))) : null;
  const levels = side === "short" ? [ctx.ref.pdh, pv?.r1, pv?.r2, ctx.ref.pdVwap, wk] : [ctx.ref.pdl, pv?.s1, pv?.s2, ctx.ref.pdVwap, wk];
  const z = p.zoneAtr * atr;
  for (const L of levels) {
    if (L == null) continue;
    if (side === "short" && c.high >= L - z && c.high <= L + p.throughAtr * atr && c.close < L && loc <= 0.4) return L;
    if (side === "long" && c.low <= L + z && c.low >= L - p.throughAtr * atr && c.close > L && loc >= 0.6) return L;
  }
  return null;
}

// Post-open-high + 0.15 ATR stop for a short (mirror for long), min-ATR, rounded away from price.
function fadeStop(ctx, side, c, atr, p) {
  const tk = tickFor(c.close);
  let stop;
  if (side === "short") {
    let hi = -Infinity;
    for (let k = 0; k <= ctx.i; k++) hi = Math.max(hi, ctx.bar(k).high);
    stop = hi + p.stopBufAtr * atr;
    if (stop - c.close < p.minStopAtr * atr) stop = c.close + p.minStopAtr * atr;
    return roundTick(stop, tk, "up");
  }
  let lo = Infinity;
  for (let k = 0; k <= ctx.i; k++) lo = Math.min(lo, ctx.bar(k).low);
  stop = lo - p.stopBufAtr * atr;
  if (c.close - stop < p.minStopAtr * atr) stop = c.close - p.minStopAtr * atr;
  return roundTick(stop, tk, "down");
}

// T1 = 50% gap fill; T2 = full fill (prev close) or prev-day VWAP, whichever price reaches first.
function targets(open, pdc, pdVwap, side) {
  const half = (open + pdc) / 2;
  const cands = [pdc, pdVwap].filter((x) => x != null && (side === "short" ? x < open : x > open));
  const t2 = cands.length ? (side === "short" ? Math.max(...cands) : Math.min(...cands)) : pdc; // nearest = hit first
  return { t1: half, t2 };
}

export default defineStrategy({
  id: "gapFadeV2",
  levels: ["orHigh", "orLow", "pdc", "pdh", "pdl", "vwap"],
  name: "Gap Fill / Fade v2",
  description:
    "Fades a NOISE gap (small relative gap, no catalyst, quiet open) that fails back — trigger A (OR break), B (VWAP loss after a lower high) or C (rejection at PDH/weekly/CPR R/prev-VWAP). Reuses the gap_go_v2 module and the shared GO/FADE classifier (mutually exclusive with Gap and Go). T1 50%-fill / T2 full-fill target with R check, no-widen post-open-high stop, time stop, one attempt/day, adverse-circuit and NIFTY-fade gates. Each filter toggleable.",
  defaultInterval: "5m",
  needsMarket: true,
  params: {
    targetR: 0, // use the T1/T2 fill target
    // §1/2 gap + eligibility
    gapPct: 0.5, useExDate: true, smallAtr: 0.3, extremeAtr: 2.5, exhaustionMode: false,
    useEligibility: true, useDisabledCombos: true,
    // §3 noise vs news
    useRelativeGap: true, relSmallMax: 0.4, beta: 1.0, fullRelMax: 0.3, useCatalystBlock: true,
    // §13 classifier
    useClassifier: true,
    // §4 triggers
    orMinutes: 15, triggerMode: "any", zoneAtr: 0.15, throughAtr: 1.0,
    // §7 volume (fade wants a QUIET open, reversal participation on the trigger)
    useOpenRvol: true, openRvolMax: 2.0, rvolBars: 3, rvolDays: 20, useTriggerRvol: true, triggerRvolMin: 1.2,
    // §6 circuit (adverse direction)
    useCircuit: true, circuitAtr: 2.0,
    // §8 market context
    useMarket: true,
    // §5 targets / R check
    targetMode: "t1", useRR: true, minRR: 1.2, costCushionPct: 0.12,
    // §9 overhead score
    useOverhead: true, overheadAtr: 0.5,
    // §10 exits / sizing
    stopBufAtr: 0.15, minStopAtr: 0.5, timeStopBars: 8, timeStopMinR: 0.5, forceFlat: "15:12",
    minScore: 0,
    entryStart: "09:25", entryEnd: "11:00",
  },
  spec: [
    { key: "gapPct", label: "Min gap %", type: "number", step: 0.1 },
    { key: "useExDate", label: "Skip ex-date gaps", type: "bool" },
    { key: "smallAtr", label: "Skip gap < (× ATR)", type: "number", step: 0.1 },
    { key: "extremeAtr", label: "Skip gap > (× ATR)", type: "number", step: 0.1 },
    { key: "exhaustionMode", label: "Allow EXTREME (exhaustion)", type: "bool" },
    { key: "useRelativeGap", label: "Filter: small relative gap (noise)", type: "bool" },
    { key: "relSmallMax", label: "Max |relative gap| %", type: "number", step: 0.05 },
    { key: "beta", label: "Beta (× NIFTY gap)", type: "number", step: 0.1 },
    { key: "fullRelMax", label: "FULL-gap max |relative gap| %", type: "number", step: 0.05 },
    { key: "useCatalystBlock", label: "Filter: no fade on catalyst", type: "bool" },
    { key: "useClassifier", label: "Filter: GO/FADE classifier = FADE", type: "bool" },
    { key: "orMinutes", label: "Opening-range minutes", type: "select", options: [5, 15, 30] },
    { key: "triggerMode", label: "Failure trigger", type: "select", options: ["any", "A", "B", "C"] },
    { key: "useOpenRvol", label: "Filter: quiet open (RVOL ≤)", type: "bool" },
    { key: "openRvolMax", label: "Max opening RVOL", type: "number", step: 0.1 },
    { key: "useTriggerRvol", label: "Filter: trigger-bar RVOL", type: "bool" },
    { key: "triggerRvolMin", label: "Min trigger RVOL", type: "number", step: 0.1 },
    { key: "useCircuit", label: "Filter: adverse circuit room", type: "bool" },
    { key: "circuitAtr", label: "Min adverse room (× ATR)", type: "number", step: 0.1 },
    { key: "useMarket", label: "Filter: NIFTY confirms the fade", type: "bool" },
    { key: "targetMode", label: "Target", type: "select", options: ["t1", "t2"] },
    { key: "useRR", label: "Filter: distance to T1 ≥ R", type: "bool" },
    { key: "minRR", label: "Min reward:risk (after costs)", type: "number", step: 0.1 },
    { key: "useOverhead", label: "Score: gap into resistance", type: "bool" },
    { key: "stopBufAtr", label: "Stop beyond post-open extreme (× ATR)", type: "number", step: 0.05 },
    { key: "minStopAtr", label: "Min stop distance (× ATR)", type: "number", step: 0.1 },
    { key: "timeStopBars", label: "Time stop after N bars", type: "number", step: 1 },
    { key: "timeStopMinR", label: "Time stop needs ≥ R", type: "number", step: 0.1 },
    { key: "forceFlat", label: "Force flat by", type: "time" },
    { key: "minScore", label: "Min setup score (0 = off)", type: "number", step: 5 },
  ],
  testParams: { useExDate: false, useRelativeGap: false, useCatalystBlock: false, useClassifier: false, useOpenRvol: false, useTriggerRvol: false, useCircuit: false, useMarket: false, useRR: false, useEligibility: false, useDisabledCombos: false, triggerMode: "A", gapPct: 0, smallAtr: 0 },
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const atr = atrOf(ctx);

    if (ctx.position) {
      const pos = ctx.position;
      if (ctx.state.heldIndex !== pos.entryIndex) { ctx.state.heldIndex = pos.entryIndex; ctx.state.entryRisk = Math.abs(pos.entry - pos.stop); }
      if (ctx.minute() >= hhmmToMin(p.forceFlat)) return { exit: true, reason: `Force flat ${p.forceFlat}` };
      if (p.timeStopBars > 0 && ctx.state.entryRisk > 0) {
        const held = ctx.i - pos.entryIndex;
        const favR = (pos.side === "long" ? ctx.bar().close - pos.entry : pos.entry - ctx.bar().close) / ctx.state.entryRisk;
        if (held >= p.timeStopBars && favR < p.timeStopMinR) return { exit: true, reason: `T1 not reached in ${p.timeStopBars} bars` };
      }
      return null;
    }

    const { open, pdc, pdh, pdl, atrDaily, pdVwap } = ctx.ref;
    if (open == null || pdc == null || ctx.i < 1 || atr == null || atr <= 0) return null;
    if (ctx.tradesToday >= 1) return null; // one fade attempt per stock per day, no re-entry after a stop
    if (p.useEligibility && GAP.exclude.has(ctx.symbol)) return null;
    if (p.useExDate && (GAP.exDates[ctx.symbol] || []).includes(ctx.date)) return null;

    const gtype = classifyGap(open, pdc, pdh, pdl);
    if (!gtype) return null;
    const gapUp = gtype.endsWith("UP");
    const side = gapUp ? "short" : "long"; // fade = opposite the gap
    if (side === "long" ? !p.allowLong : !p.allowShort) return null;
    const { gapPct, gapAtr } = gapMetrics(open, pdc, atrDaily);
    if (gapPct == null || Math.abs(gapPct) < p.gapPct) return null;
    const absAtr = Math.abs(gapAtr);
    if (absAtr < p.smallAtr) return null; // no room to fill
    if (absAtr > p.extremeAtr && !p.exhaustionMode) return null;
    const bucket = sizeBucket(absAtr, { smallAtr: p.smallAtr, sweetMaxAtr: 1.0, largeMaxAtr: p.extremeAtr });
    if (p.useDisabledCombos && GAP.disabledCombos.has(`${ctx.symbol}|${bucket}`)) return null;

    const catalyst = (GAP.catalysts[ctx.symbol] || []).includes(ctx.date);
    if (p.useCatalystBlock && catalyst) return null; // never fade a catalyst gap

    const m = ctx.market("nifty");
    const niftyGap = m && m.prevClose ? ((m.dayOpen - m.prevClose) / m.prevClose) * 100 : null;
    const relGap = niftyGap != null ? relativeGap(gapPct, niftyGap, p.beta) : null;
    if (p.useRelativeGap && relGap != null) {
      if (Math.abs(relGap) > p.relSmallMax) return null; // too idiosyncratic = news, not a fade
      if (gtype.startsWith("FULL") && Math.abs(relGap) > p.fullRelMax) return null; // FULL only on a small relative gap
    }

    const support = gtype.startsWith("FULL") ? (gapUp ? pdh : pdl) : pdc;
    const failed = gapFailed(ctx.bars(), support, gapUp ? "long" : "short", ctx.i);
    const openRvol = openingRvol(ctx, p.rvolBars, p.rvolDays);
    if (p.useClassifier) {
      const cls = classifyGapDay({ open, prevClose: pdc, pdh, pdl, gapAtr, relGap, catalyst, openRvol, niftyGap, failed }, CLASSIFIER_DEFAULTS);
      if (cls.label !== "FADE") return null;
    }

    if (p.useOpenRvol && openRvol != null && openRvol > p.openRvolMax) return null; // a fade wants a quiet open
    if (p.useMarket && m && m.vwap != null) {
      // Fade a gap-up only if NIFTY is weak (below its VWAP); mirror for a gap-down fade.
      if (gapUp ? !(m.close < m.vwap) : !(m.close > m.vwap)) return null;
    }
    if (p.useCircuit) {
      const room = circuitRoom(open, GAP.bandPct[ctx.symbol], atr, gapUp ? "long" : "short"); // adverse = toward the gap
      if (room != null && room < p.circuitAtr) return null;
    }

    const or = ctx.openingRange(p.orMinutes);
    if (!or || ctx.i <= or.completeIndex) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);
    const vwap = ctx.ind("vwap");

    // Failure triggers (closed candles). A: OR break. B: VWAP loss after a lower high. C: level rejection.
    let trig = null;
    const wantA = p.triggerMode === "any" || p.triggerMode === "A";
    const wantB = p.triggerMode === "any" || p.triggerMode === "B";
    const wantC = p.triggerMode === "any" || p.triggerMode === "C";
    if (wantA && (side === "short" ? c.close < or.low && prev.close >= or.low : c.close > or.high && prev.close <= or.high)) trig = "A";
    if (!trig && wantB && vwap != null && (side === "short" ? c.close < vwap : c.close > vwap) && lowerHighFormed(ctx, or.completeIndex, side)) trig = "B";
    if (!trig && wantC && levelRejection(ctx, side, atr, p)) trig = "C";
    if (!trig) return null;

    if (p.useTriggerRvol) {
      const rv = rvolFromProfile(ctx.ref.profile, ctx.minute(), c.volume || 0, p.rvolDays).rvol;
      if (rv != null && rv < p.triggerRvolMin) return null; // need reversal participation on the trigger bar
    }

    const stop = fadeStop(ctx, side, c, atr, p);
    if (stop == null || (side === "short" ? stop <= c.close : stop >= c.close)) return null;
    const { t1, t2 } = targets(open, pdc, pdVwap, side);
    const entry = c.close;
    const tk = tickFor(entry);
    const target = roundTick(p.targetMode === "t2" ? t2 : t1, tk, side === "short" ? "up" : "down");
    if (side === "short" ? !(target < entry) : !(target > entry)) return null;
    if (p.useRR) {
      const risk = Math.abs(entry - stop);
      const reward = Math.abs(t1 - entry) - (entry * p.costCushionPct) / 100;
      if (!(risk > 0) || reward / risk < p.minRR) return null;
    }

    const { score, notes } = scoreOf({ ctx, p, side, gtype, bucket, gapAtr, gapPct, relGap, trig, atr, open });
    if (score < p.minScore) return null;
    return {
      side,
      stop,
      target,
      reason: `FADE ${gtype} ${bucket} trig:${trig} gap=${gapPct.toFixed(2)}%/${absAtr.toFixed(1)}ATR rel=${relGap == null ? "–" : relGap.toFixed(2)} T1=${px(t1)} T2=${px(t2)} score=${score}/100${notes.length ? ` [${notes.join(",")}]` : ""}`,
    };
  },
  plan(ctx) {
    const p = ctx.params;
    const { open, pdc, pdh, pdl, atrDaily } = ctx.ref;
    if (pdc == null) return off("No previous session.");
    const atr = atrOf(ctx);
    if (!hasBars(ctx) || open == null) return waiting(`Needs the 09:15 open: a gap ≥ ${p.gapPct}% that then fails back (fade to the fill).`);
    const gtype = classifyGap(open, pdc, pdh, pdl);
    if (!gtype) return off("Flat open — no gap to fade.");
    const { gapPct, gapAtr } = gapMetrics(open, pdc, atrDaily);
    if (Math.abs(gapPct) < p.gapPct) return off(`Gap ${gapPct.toFixed(2)}% < ${p.gapPct}%.`);
    if (atr && Math.abs(gapAtr) < p.smallAtr) return off(`Gap ${gapPct.toFixed(2)}% (${(gapAtr ?? 0).toFixed(1)}×ATR) — too small to fade.`);
    const gapUp = gtype.endsWith("UP");
    const side = gapUp ? "short" : "long";
    const or = ctx.openingRange(p.orMinutes);
    const { t1, t2 } = targets(open, pdc, ctx.ref.pdVwap, side);
    if (!or) return waiting(`${gtype} gap ${gapPct.toFixed(2)}%. Opening range forms until ${orEnd(ctx, p.orMinutes)}; fade needs it to fail (trigger ${p.triggerMode}).`);
    return watch(
      [{ side, trigger: side === "short" ? or.low : or.high, when: `${tf(ctx)} close ${side === "short" ? "below OR low" : "above OR high"} (gap failing, trigger ${p.triggerMode})`, stop: side === "short" ? or.high : or.low, target: roundTick(p.targetMode === "t2" ? t2 : t1, tickFor(open), side === "short" ? "up" : "down"), cross: true, approx: true }],
      `${gtype} gap ${gapPct.toFixed(2)}% (${(gapAtr ?? 0).toFixed(1)}×ATR). Fade to T1 ${px(t1)} / T2 ${px(t2)}; no-widen stop, time stop ${p.timeStopBars} bars, one attempt/day.`
    );
  },
});

// Setup score 0–100: base + size bucket, small relative gap, quiet open, trigger, overhead resistance.
export function scoreOf({ ctx, p, side, gtype, bucket, gapAtr, gapPct, relGap, trig, atr, open }) {
  let s = 40;
  const notes = [];
  if (gtype.startsWith("PARTIAL") && Math.abs(gapAtr) >= 0.3 && Math.abs(gapAtr) <= 1.0) { s += 15; notes.push("preferred"); } else if (bucket === "SWEET") { s += 5; }
  if (relGap != null && Math.abs(relGap) <= p.relSmallMax) { s += 10; notes.push("noise"); }
  const openRvol = openingRvol(ctx, p.rvolBars, p.rvolDays);
  if (openRvol != null && openRvol <= p.openRvolMax) { s += 10; notes.push("quiet"); }
  if (trig === "C") { s += 5; notes.push("level-reject"); } else if (trig === "B") { s += 3; }
  // Overhead: gap opened into resistance (short) / support (long) scores; clean air penalises.
  if (p.useOverhead && atr > 0) {
    const daily = ctx.ref.daily;
    const wkHi = daily.length >= 5 ? Math.max(...daily.slice(-5).map((d) => d.high)) : null;
    const wkLo = daily.length >= 5 ? Math.min(...daily.slice(-5).map((d) => d.low)) : null;
    const near = (x) => x != null && Math.abs(open - x) <= p.overheadAtr * atr;
    const pv = ctx.pivots;
    const into = side === "short" ? [ctx.ref.pdh, wkHi, pv?.r1, pv?.r2, ctx.ref.pdVwap] : [ctx.ref.pdl, wkLo, pv?.s1, pv?.s2, ctx.ref.pdVwap];
    if (into.some(near)) { s += 10; notes.push("into-resistance"); }
    const cleanAir = side === "short" ? (wkHi != null && open > wkHi) : (wkLo != null && open < wkLo);
    if (cleanAir) { s -= 10; notes.push("clean-air"); }
  }
  return { score: Math.max(0, Math.min(100, s)), notes };
}

import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px, orEnd, hasBars } from "./planKit.js";
import { roundTick, tickFor } from "../decision/util.js";
import { hhmmToMin, OPEN_MIN } from "../lab/time.js";
import { rvolFromProfile } from "./volumeBreakoutV2.js";
import { classifyGapDay, CLASSIFIER_DEFAULTS } from "./gapClassifier.js";
import { GAP } from "../config/gap.js";

// Gap and Go v2. Classifies the gap (FULL/PARTIAL, size bucket), measures it in ATR and relative to
// NIFTY, requires a real "go" (VWAP side + ORB or first-pullback on closed candles), gates on opening
// RVOL / circuit room / gap-failure / NIFTF context / eligibility, then trails with a 1R breakeven,
// swing trail, time stop and force-flat. Every filter toggleable. v1 stays as `gapAndGo`. Signals on
// closed bars only; the shared engine fills at the next bar's open and applies costs, slippage, sizing.
//
// shortcut: official-close gap uses prev.close (last trade), not the UNUT last-30-min VWAP (not in the
//   feed). Relative-gap beta defaults to 1 (a true 60d beta needs a daily-returns feed). Ex-date /
//   catalyst / price-band / eligibility come from config/gap.js (empty by default → the check is
//   skipped). 52-week overhead and pre-open imbalance are out (no free feed). See CHANGES g).

const atrOf = (ctx) => ctx.ind("atr", [ctx.params.atrPeriod]) ?? null;

export const gapMetrics = (open, prevClose, atrDaily) => ({
  gapPct: prevClose ? ((open - prevClose) / prevClose) * 100 : null,
  gapAtr: atrDaily > 0 ? (open - prevClose) / atrDaily : null,
});

// FULL = gapped clean past the prior day's extreme; PARTIAL = gapped but still inside it.
export function classifyGap(open, prevClose, pdh, pdl) {
  if (open == null || prevClose == null) return null;
  if (open > prevClose) return pdh != null && open > pdh ? "FULL_UP" : "PARTIAL_UP";
  if (open < prevClose) return pdl != null && open < pdl ? "FULL_DOWN" : "PARTIAL_DOWN";
  return null;
}

export function sizeBucket(absGapAtr, p) {
  if (absGapAtr == null) return "SMALL";
  if (absGapAtr < p.smallAtr) return "SMALL";
  if (absGapAtr <= p.sweetMaxAtr) return "SWEET";
  if (absGapAtr <= p.largeMaxAtr) return "LARGE";
  return "EXTREME";
}

// Stock gap minus its market-driven part (beta × NIFTY gap). Measures idiosyncratic strength.
export const relativeGap = (gapPct, niftyGapPct, beta) => gapPct - beta * (niftyGapPct ?? 0);

// ATR of room between the open and its circuit band; null when no band is configured (→ no check).
export function circuitRoom(open, bandPct, atr, side) {
  if (!(bandPct > 0) || !(atr > 0) || open == null) return null;
  const limit = side === "long" ? open * (1 + bandPct / 100) : open * (1 - bandPct / 100);
  return Math.abs(limit - open) / atr;
}

// Did the gap fail by trading back through its support (PARTIAL: prevClose; FULL: PDH/PDL) by bar i? Pure.
export function gapFailed(candles, support, side, upto) {
  if (support == null) return false;
  for (let k = 0; k <= upto; k++) {
    if (side === "long" ? candles[k].low < support : candles[k].high > support) return true;
  }
  return false;
}

// Opening RVOL: average same-slot RVOL of the first `bars` bars (vs the last `days` sessions). null if
// the profile history is too thin → the caller degrades to pass.
export function openingRvol(ctx, bars, days) {
  const xs = [];
  for (let k = 0; k < bars && k <= ctx.i; k++) {
    const r = rvolFromProfile(ctx.ref.profile, ctx.minute(k), ctx.bar(k).volume || 0, days).rvol;
    if (r != null) xs.push(r);
  }
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
}

// Stop for a "go": tighter of the OR extreme, VWAP ∓ 0.1 ATR, and gap support; floored to min-ATR,
// rounded away from price.
function gapStop(side, c, or, vwap, support, atr, p) {
  const tk = tickFor(c.close);
  const cands = [or && (side === "long" ? or.low : or.high), vwap != null ? (side === "long" ? vwap - 0.1 * atr : vwap + 0.1 * atr) : null, support].filter((x) => x != null);
  if (!cands.length) return null;
  // tighter = closer to price = the max (long) / min (short) of the candidates below/above the close
  let stop = side === "long" ? Math.max(...cands.filter((x) => x < c.close)) : Math.min(...cands.filter((x) => x > c.close));
  if (!Number.isFinite(stop)) return null;
  if (side === "long" && c.close - stop < p.minStopAtr * atr) stop = c.close - p.minStopAtr * atr;
  if (side === "short" && stop - c.close < p.minStopAtr * atr) stop = c.close + p.minStopAtr * atr;
  return roundTick(stop, tk, side === "long" ? "down" : "up");
}

export default defineStrategy({
  id: "gapAndGoV2",
  levels: ["orHigh", "orLow", "pdc", "pdh", "pdl", "vwap"],
  name: "Gap and Go v2",
  description:
    "Classifies the opening gap (FULL/PARTIAL, ATR size bucket), measures it relative to NIFTY, then needs a confirmed 'go': price holding above prevClose/PDH, above VWAP, and either an opening-range breakout or a first-pullback rejection, with opening RVOL ≥ 2, NIFTY context and gap-failure / circuit / ex-date / eligibility gates. 1R breakeven + swing trail, time stop, force-flat. Each filter toggleable.",
  defaultInterval: "5m",
  needsMarket: true, // NIFTY gap + VWAP context; passes when the index isn't attached
  params: {
    // exits via trail + time stop, not a fixed R target (spec §8: partial-at-1R proxy = 1R breakeven)
    targetR: 0, breakevenR: 1, trailType: "swing", trailSwingBars: 3,
    // §1 gap
    gapPct: 0.5, useExDate: true,
    // §2 classification
    smallAtr: 0.5, sweetMaxAtr: 1.5, largeMaxAtr: 2.5, skipExtreme: true, skipSmall: true,
    useRelativeGap: true, relGapMin: 0.25, beta: 1.0,
    useCircuit: true, circuitAtr: 1.5,
    // §3 "go"
    orMinutes: 15, entryMode: "orb", useVwapSide: true, useFailRule: true,
    pullbackZoneAtr: 0.15,
    // §4 opening RVOL
    useRvol: true, rvolBars: 3, rvolMult: 2.0, rvolDays: 20,
    // §6 overhead, §5 catalyst
    useOverhead: true, overheadAtr: 0.5, useCatalyst: true,
    // §7 market context
    useMarket: true,
    // §13 shared GO/FADE classifier (mutual exclusion with Gap Fill/Fade)
    useClassifier: true,
    // §8 exits / sizing
    minStopAtr: 0.5, timeStopBars: 6, timeStopMinR: 0.5, forceFlat: "15:12",
    // §9 eligibility, §11 per-stock auto-disable
    useEligibility: true, useDisabledCombos: true,
    // score
    minScore: 0,
    entryStart: "09:20", entryEnd: "10:30",
  },
  spec: [
    { key: "gapPct", label: "Min gap %", type: "number", step: 0.1 },
    { key: "useExDate", label: "Skip ex-date gaps", type: "bool" },
    { key: "smallAtr", label: "SMALL gap < (× ATR)", type: "number", step: 0.1 },
    { key: "sweetMaxAtr", label: "SWEET gap ≤ (× ATR)", type: "number", step: 0.1 },
    { key: "largeMaxAtr", label: "LARGE gap ≤ (× ATR)", type: "number", step: 0.1 },
    { key: "skipExtreme", label: "Skip EXTREME gaps", type: "bool" },
    { key: "skipSmall", label: "Skip SMALL gaps", type: "bool" },
    { key: "useRelativeGap", label: "Filter: relative gap vs NIFTY", type: "bool" },
    { key: "relGapMin", label: "Min relative gap %", type: "number", step: 0.05 },
    { key: "beta", label: "Beta (× NIFTY gap)", type: "number", step: 0.1 },
    { key: "useCircuit", label: "Filter: room to circuit band", type: "bool" },
    { key: "circuitAtr", label: "Min room to band (× ATR)", type: "number", step: 0.1 },
    { key: "orMinutes", label: "Opening-range minutes", type: "select", options: [5, 15, 30] },
    { key: "entryMode", label: "Entry mode", type: "select", options: ["orb", "pullback", "both"] },
    { key: "useVwapSide", label: "Filter: price on VWAP side", type: "bool" },
    { key: "useFailRule", label: "Filter: gap-failure (back through support)", type: "bool" },
    { key: "pullbackZoneAtr", label: "Pullback zone (× ATR)", type: "number", step: 0.05 },
    { key: "useRvol", label: "Filter: opening RVOL", type: "bool" },
    { key: "rvolBars", label: "Opening RVOL bars", type: "number", step: 1 },
    { key: "rvolMult", label: "Min opening RVOL", type: "number", step: 0.1 },
    { key: "useOverhead", label: "Score: overhead levels", type: "bool" },
    { key: "overheadAtr", label: "Overhead penalty within (× ATR)", type: "number", step: 0.1 },
    { key: "useCatalyst", label: "Score: catalyst day", type: "bool" },
    { key: "useMarket", label: "Filter: NIFTY gap + VWAP", type: "bool" },
    { key: "useClassifier", label: "Filter: GO/FADE classifier = GO", type: "bool" },
    { key: "minStopAtr", label: "Min stop distance (× ATR)", type: "number", step: 0.1 },
    { key: "timeStopBars", label: "Time stop after N bars", type: "number", step: 1 },
    { key: "timeStopMinR", label: "Time stop needs ≥ R", type: "number", step: 0.1 },
    { key: "forceFlat", label: "Force flat by", type: "time" },
    { key: "useEligibility", label: "Filter: EQ/MIS eligibility", type: "bool" },
    { key: "useDisabledCombos", label: "Filter: disabled stock×bucket", type: "bool" },
    { key: "minScore", label: "Min setup score (0 = off)", type: "number", step: 5 },
  ],
  // Loosened only so the random-data lookahead/leak test exercises the entry path.
  testParams: { useExDate: false, skipSmall: false, skipExtreme: false, useRelativeGap: false, useCircuit: false, useVwapSide: false, useFailRule: false, useRvol: false, useMarket: false, useEligibility: false, useDisabledCombos: false, useClassifier: false, gapPct: 0 },
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
        if (held >= p.timeStopBars && favR < p.timeStopMinR) return { exit: true, reason: `No ${p.timeStopMinR}R in ${p.timeStopBars} bars` };
      }
      return null;
    }

    const { open, pdc, pdh, pdl, atrDaily } = ctx.ref;
    if (open == null || pdc == null || ctx.i < 1 || atr == null || atr <= 0) return null;
    if (p.useEligibility && GAP.exclude.has(ctx.symbol)) return null;
    if (p.useExDate && (GAP.exDates[ctx.symbol] || []).includes(ctx.date)) return null;

    const gtype = classifyGap(open, pdc, pdh, pdl);
    if (!gtype) return null;
    const side = gtype.endsWith("UP") ? "long" : "short";
    if (side === "long" ? !p.allowLong : !p.allowShort) return null;
    const { gapPct, gapAtr } = gapMetrics(open, pdc, atrDaily);
    if (gapPct == null || Math.abs(gapPct) < p.gapPct) return null;

    const bucket = sizeBucket(Math.abs(gapAtr), p);
    if ((bucket === "SMALL" && p.skipSmall) || (bucket === "EXTREME" && p.skipExtreme)) return null;
    if (p.useDisabledCombos && GAP.disabledCombos.has(`${ctx.symbol}|${bucket}`)) return null;

    const c = ctx.bar();
    const support = gtype.startsWith("FULL") ? (side === "long" ? pdh : pdl) : pdc;
    const failed = gapFailed(ctx.bars(), support, side, ctx.i);
    if (p.useFailRule && failed) { ctx.state.failed = true; return null; }

    const m = ctx.market("nifty");
    const niftyGap = m && m.prevClose ? ((m.dayOpen - m.prevClose) / m.prevClose) * 100 : null;
    // Shared GO/FADE classifier: Gap and Go trades only a GO stock-day (mutual exclusion with the fade).
    if (p.useClassifier) {
      const relGap = niftyGap != null ? relativeGap(gapPct, niftyGap, p.beta) : null;
      const cls = classifyGapDay({ open, prevClose: pdc, pdh, pdl, gapAtr, relGap, catalyst: (GAP.catalysts[ctx.symbol] || []).includes(ctx.date), openRvol: openingRvol(ctx, p.rvolBars, p.rvolDays), niftyGap, failed }, CLASSIFIER_DEFAULTS);
      if (cls.label !== "GO") return null;
    }
    if (p.useRelativeGap && niftyGap != null) {
      const rel = relativeGap(gapPct, niftyGap, p.beta);
      if (side === "long" ? rel < p.relGapMin : rel > -p.relGapMin) return null;
    }
    if (p.useMarket && m && m.vwap != null) {
      if (niftyGap != null && (side === "long" ? niftyGap < 0 : niftyGap > 0)) return null; // NIFTY gapped the other way
      if (side === "long" ? !(m.close > m.vwap) : !(m.close < m.vwap)) return null;
    }
    if (p.useCircuit) {
      const room = circuitRoom(open, GAP.bandPct[ctx.symbol], atr, side);
      if (room != null && room < p.circuitAtr) return null;
    }

    const vwap = ctx.ind("vwap");
    if (p.useVwapSide && vwap != null && (side === "long" ? !(c.close > vwap) : !(c.close < vwap))) return null;

    if (p.useRvol) {
      const rv = openingRvol(ctx, p.rvolBars, p.rvolDays);
      if (rv != null && rv < p.rvolMult) return null;
    }

    const or = ctx.openingRange(p.orMinutes);
    if (!or || ctx.i <= or.completeIndex) return null;

    // "Go" trigger: ORB (fresh close beyond the OR edge) and/or a first-pullback rejection.
    const prev = ctx.bar(ctx.i - 1);
    let mode = null;
    if (p.entryMode !== "pullback") {
      const brk = side === "long" ? c.close > or.high && prev.close <= or.high : c.close < or.low && prev.close >= or.low;
      if (brk) mode = "ORB";
    }
    if (!mode && p.entryMode !== "orb") {
      // Pullback to VWAP/open that holds with a rejection candle, then entry.
      const ref = vwap != null ? vwap : open;
      const z = p.pullbackZoneAtr * atr;
      const range = c.high - c.low;
      const loc = range > 0 ? (c.close - c.low) / range : 0.5;
      if (side === "long" && c.low <= ref + z && c.close > ref && c.close > c.open && loc >= 0.6) mode = "PULLBACK";
      if (side === "short" && c.high >= ref - z && c.close < ref && c.close < c.open && loc <= 0.4) mode = "PULLBACK";
    }
    if (!mode) return null;

    const stop = gapStop(side, c, or, vwap, support, atr, p);
    if (stop == null || (side === "long" ? stop >= c.close : stop <= c.close)) return null;

    const { score, notes } = scoreOf({ ctx, p, side, gtype, bucket, gapAtr, gapPct, niftyGap, mode, atr, open, vwap });
    if (score < p.minScore) return null;
    return {
      side,
      stop,
      reason: `${gtype} ${bucket} ${mode} gap=${gapPct.toFixed(2)}%/${(gapAtr ?? 0).toFixed(1)}ATR rel=${niftyGap == null ? "–" : relativeGap(gapPct, niftyGap, p.beta).toFixed(2)} score=${score}/100${notes.length ? ` [${notes.join(",")}]` : ""}`,
    };
  },
  plan(ctx) {
    const p = ctx.params;
    const { open, pdc, pdh, pdl, atrDaily } = ctx.ref;
    if (pdc == null) return off("No previous session.");
    const atr = atrOf(ctx);
    if (!hasBars(ctx) || open == null) return waiting(`Needs the 09:15 open: gap ≥ ${p.gapPct}% to arm. SWEET bucket = ${p.smallAtr}–${p.sweetMaxAtr}×ATR.`);
    const gtype = classifyGap(open, pdc, pdh, pdl);
    if (!gtype) return off("Flat open — no gap.");
    const { gapPct, gapAtr } = gapMetrics(open, pdc, atrDaily);
    if (Math.abs(gapPct) < p.gapPct) return off(`Gap ${gapPct.toFixed(2)}% < ${p.gapPct}%.`);
    const bucket = atr ? sizeBucket(Math.abs(gapAtr), p) : "?";
    if (bucket === "SMALL" && p.skipSmall) return off(`Gap ${gapPct.toFixed(2)}% (SMALL, ${(gapAtr ?? 0).toFixed(1)}×ATR) — too small.`);
    if (bucket === "EXTREME" && p.skipExtreme) return off(`Gap ${gapPct.toFixed(2)}% (EXTREME, ${(gapAtr ?? 0).toFixed(1)}×ATR) — skipped.`);
    const side = gtype.endsWith("UP") ? "long" : "short";
    const or = ctx.openingRange(p.orMinutes);
    if (!or) return waiting(`${gtype} ${bucket} gap ${gapPct.toFixed(2)}%. Opening range forms until ${orEnd(ctx, p.orMinutes)}; need VWAP side${p.useRvol ? ` + RVOL ≥ ${p.rvolMult}×` : ""}.`);
    const trig = side === "long" ? or.high : or.low;
    return watch(
      [{ side, trigger: trig, when: `${tf(ctx)} close ${side === "long" ? "above OR high" : "below OR low"} (${p.entryMode}), on the VWAP side`, stop: side === "long" ? or.low : or.high, cross: true, approx: true }],
      `${gtype} ${bucket} gap ${gapPct.toFixed(2)}% (${(gapAtr ?? 0).toFixed(1)}×ATR). Trailed exit (1R breakeven + swing), time stop ${p.timeStopMinR}R/${p.timeStopBars} bars.`
    );
  },
});

// Setup score 0–100: base + size bucket, relative gap, RVOL, market context, overhead, catalyst, mode.
export function scoreOf({ ctx, p, side, gtype, bucket, gapAtr, gapPct, niftyGap, mode, atr, open, vwap }) {
  let s = 40;
  const notes = [];
  if (bucket === "SWEET") { s += 15; notes.push("sweet"); } else if (bucket === "LARGE") { s += 5; }
  if (gtype.startsWith("FULL")) { s += 5; notes.push("full"); }
  if (p.useRelativeGap && niftyGap != null) { const rel = relativeGap(gapPct, niftyGap, p.beta); if (Math.abs(rel) >= 2 * p.relGapMin) { s += 10; notes.push("rel+"); } }
  const rv = openingRvol(ctx, p.rvolBars, p.rvolDays);
  if (rv != null && rv >= p.rvolMult) { s += 10; notes.push(`rvol${rv.toFixed(1)}`); }
  const mkt = ctx.market("nifty");
  if (p.useMarket && mkt && mkt.vwap != null && (side === "long" ? mkt.close > mkt.vwap : mkt.close < mkt.vwap)) { s += 5; notes.push("mkt"); }
  if (mode === "PULLBACK") { s += 5; notes.push("pullback"); }
  // Overhead: clear sky above a long (open beyond multi-day/weekly high) scores; a level just overhead penalises.
  if (p.useOverhead && atr > 0) {
    const daily = ctx.ref.daily;
    const hi = (n) => (daily.length >= n ? Math.max(...daily.slice(-n).map((d) => d.high)) : null);
    const lo = (n) => (daily.length >= n ? Math.min(...daily.slice(-n).map((d) => d.low)) : null);
    const clear = side === "long" ? hi(20) : lo(20);
    if (clear != null && (side === "long" ? open > clear : open < clear)) { s += 10; notes.push("clear-sky"); }
    const over = side === "long" ? [ctx.ref.pdh, hi(5), hi(20)] : [ctx.ref.pdl, lo(5), lo(20)];
    if (over.some((x) => x != null && (side === "long" ? x > open && x - open <= p.overheadAtr * atr : x < open && open - x <= p.overheadAtr * atr))) { s -= 10; notes.push("overhead"); }
  }
  if (p.useCatalyst && (GAP.catalysts[ctx.symbol] || []).includes(ctx.date)) { s += 10; notes.push("catalyst"); }
  return { score: Math.max(0, Math.min(100, s)), notes };
}

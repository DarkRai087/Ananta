// VWAP Pullback — trend-day continuation off session VWAP.
//
// Hypothesis: institutional VWAP execution algos accumulate near VWAP, so on a trend day a
// pullback to VWAP acts as support (longs) / resistance (shorts). We only trade WITH a
// confirmed VWAP trend, buy the dip that touches VWAP on drying volume, and enter on the
// reclaim bar. Longs described; shorts are the mirror. See vwapPullback.md for the full spec.
//
// Everything is read through ctx (bars/indicators ≤ i), so there is no lookahead: the signal
// at bar i is identical whether or not later bars exist (lookahead + session-leak tests).
import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px } from "./planKit.js";
import { tickFor, roundTick } from "../decision/util.js";

const warmupBars = (p) => Math.max(p.slopeBars, p.holdBars, p.atrPeriod) + 1;

// VWAP value `ago` bars back (index i − ago).
const vwapAt = (ctx, ago) => ctx.ind("vwap", [], ago);

// Consecutive bars ending at endIdx whose close is on `side` of their own VWAP.
function runOnSide(ctx, endIdx, side) {
  let n = 0;
  for (let k = endIdx; k >= 0; k--) {
    const b = ctx.bar(k);
    const v = vwapAt(ctx, ctx.i - k);
    const on = side === "long" ? b.close > v : b.close < v;
    if (on) n++;
    else break;
  }
  return n;
}

// Times price's close changed sides of VWAP over bars 0..i today.
function vwapCrossings(ctx, i) {
  let crosses = 0;
  let prev = 0;
  for (let k = 0; k <= i; k++) {
    const d = ctx.bar(k).close - vwapAt(ctx, ctx.i - k);
    const s = d > 0 ? 1 : d < 0 ? -1 : 0;
    if (s !== 0) {
      if (prev !== 0 && s !== prev) crosses++;
      prev = s;
    }
  }
  return crosses;
}

// Mean volume over bars [from..to] (inclusive), or null if the range is empty.
function avgVol(ctx, from, to) {
  if (to < from) return null;
  let s = 0;
  for (let k = from; k <= to; k++) s += ctx.bar(k).volume || 0;
  return s / (to - from + 1);
}

// Lowest low / highest high over bars [from..to].
function extremeBetween(ctx, from, to, long) {
  let x = long ? Infinity : -Infinity;
  for (let k = from; k <= to; k++) {
    const b = ctx.bar(k);
    x = long ? Math.min(x, b.low) : Math.max(x, b.high);
  }
  return x;
}

// Index proxy: NIFTY 50 (volume-less, so its "VWAP" is the equal-weight typical-price line) must
// be above/below its own line for the trade's side. No index data that day → don't block.
function marketAligned(ctx, side) {
  const m = ctx.market?.("nifty");
  if (!m) return true;
  const line = m.vwap != null ? m.vwap : m.dayOpen;
  if (line == null) return true;
  return side === "long" ? m.close > line : m.close < line;
}

// The full signal test for one side at the trigger bar. Returns a signal or null.
function signalFor(ctx, side, p, atr, v, c, prev) {
  const long = side === "long";
  const i = ctx.i;

  // 1) Entry trigger: a bar closes beyond the previous bar's extreme and back through VWAP.
  const trig = long
    ? c.close > prev.high && c.close > v && c.close > c.open
    : c.close < prev.low && c.close < v && c.close < c.open;
  if (!trig) return null;

  // 2) Trend-day filter: VWAP sloping, price holding one side, VWAP not whipsawing.
  const vThen = vwapAt(ctx, p.slopeBars);
  if (!(vThen > 0)) return null;
  const slopePct = ((v - vThen) / vThen) * 100;
  if (long ? slopePct < p.minVwapSlopePct : slopePct > -p.minVwapSlopePct) return null;
  if (runOnSide(ctx, i - 1, side) < p.holdBars) return null;
  if (vwapCrossings(ctx, i) > p.maxVwapCrossings) return null;

  // 3) Pullback: a recent bar's low (long) came within touchAtrMult×ATR of VWAP without its
  //    close dipping more than dipAtrMult×ATR past VWAP.
  let touch = -1;
  for (let k = i; k >= Math.max(0, i - p.pullbackWindow); k--) {
    const b = ctx.bar(k);
    const vk = vwapAt(ctx, i - k);
    const near = long
      ? b.low <= vk + p.touchAtrMult * atr && b.close >= vk - p.dipAtrMult * atr
      : b.high >= vk - p.touchAtrMult * atr && b.close <= vk + p.dipAtrMult * atr;
    if (near) {
      touch = k;
      break;
    }
  }
  if (touch < 0) return null;

  // 4) Volume dry-up on the pullback leg vs the impulse leg before it. Skipped when the reclaim
  //    is the touch bar itself (no distinct pullback bars) or there is no volume (indices).
  const pbVol = avgVol(ctx, touch, i - 1);
  const impVol = avgVol(ctx, Math.max(0, touch - p.holdBars), touch - 1);
  if (pbVol != null && impVol != null && impVol > 0 && !(pbVol < p.volDryMult * impVol)) return null;

  // 5) Market alignment.
  if (p.requireMarket && !marketAligned(ctx, side)) return null;

  // 6) Stop: min(pullback swing low, VWAP − stopAtrMult×ATR), rounded away from price to the
  //    NSE tick. Rejected if too tight for the spread or wider than maxStopAtrMult×ATR.
  const swing = extremeBetween(ctx, touch, i, long);
  const raw = long ? Math.min(swing, v - p.stopAtrMult * atr) : Math.max(swing, v + p.stopAtrMult * atr);
  const stop = roundTick(raw, tickFor(c.close), long ? "down" : "up");
  if (!(stop > 0) || (long ? stop >= c.close : stop <= c.close)) return null;
  const dist = Math.abs(c.close - stop);
  if (dist < (p.minStopPct / 100) * c.close) return null;
  if (dist > p.maxStopAtrMult * atr) return null;

  const sig = {
    side,
    stop,
    reason: long ? "Pullback to rising VWAP held, reclaim bar" : "Pullback to falling VWAP rejected, break-down bar",
  };
  // Optional VWAP ±σ-band target (the engine uses sig.target only when targetR = 0).
  if (p.targetMode === "band") {
    const b = ctx.ind("vwapBands", [p.bandMult]);
    const t = long ? b?.upper : b?.lower;
    if (t != null && (long ? t > c.close : t < c.close)) sig.target = t;
  }
  return sig;
}

export default defineStrategy({
  id: "vwapPullback",
  levels: ["vwap"],
  name: "VWAP Pullback",
  description:
    "On a VWAP trend day (VWAP sloping, price holding one side, few crossings), buy a low-volume dip that touches VWAP and closes back above it on the reclaim bar (short: mirror). Stop below the pullback / VWAP−0.25·ATR, target 2R.",
  needsMarket: true,
  params: {
    slopeBars: 6, // VWAP slope lookback
    minVwapSlopePct: 0.05, // min |VWAP slope| over slopeBars, %
    holdBars: 6, // consecutive closes on the trend side before the pullback
    maxVwapCrossings: 2, // skip the day once VWAP has been crossed more than this
    pullbackWindow: 3, // how many recent bars back to look for the VWAP touch
    touchAtrMult: 0.1, // low within this ×ATR of VWAP counts as a touch
    dipAtrMult: 0.25, // ...and the close may dip at most this ×ATR past VWAP
    volDryMult: 0.8, // pullback avg volume must be below this × impulse avg volume
    maxGapPct: 2, // skip the stock today if |opening gap| exceeds this
    stopAtrMult: 0.25, // stop candidate = VWAP ∓ this ×ATR
    minStopPct: 0.15, // reject if the stop is closer than this % of price (too tight)
    maxStopAtrMult: 1.2, // reject if the stop is wider than this ×ATR
    requireMarket: true, // require NIFTY 50 aligned with the trade side
    exitOnVwapLoss: false, // exit on 2 consecutive closes back through VWAP
    targetMode: "R", // "R" = use Target (R); "band" = VWAP ±σ band (set Target (R) to 0 to use)
    bandMult: 2, // σ multiple for the band target
    entryStart: "09:45",
    entryEnd: "14:30",
  },
  spec: [
    { key: "slopeBars", label: "VWAP slope lookback (bars)", type: "number", step: 1 },
    { key: "minVwapSlopePct", label: "Min VWAP slope %", type: "number", step: 0.01 },
    { key: "holdBars", label: "Closes held on trend side", type: "number", step: 1 },
    { key: "maxVwapCrossings", label: "Max VWAP crossings/day", type: "number", step: 1 },
    { key: "pullbackWindow", label: "Pullback window (bars)", type: "number", step: 1 },
    { key: "touchAtrMult", label: "Touch tolerance (×ATR)", type: "number", step: 0.05 },
    { key: "dipAtrMult", label: "Max dip past VWAP (×ATR)", type: "number", step: 0.05 },
    { key: "volDryMult", label: "Pullback/impulse volume ratio", type: "number", step: 0.05 },
    { key: "maxGapPct", label: "Max opening gap %", type: "number", step: 0.25 },
    { key: "stopAtrMult", label: "Stop offset (×ATR)", type: "number", step: 0.05 },
    { key: "minStopPct", label: "Min stop distance %", type: "number", step: 0.05 },
    { key: "maxStopAtrMult", label: "Max stop distance (×ATR)", type: "number", step: 0.1 },
    { key: "requireMarket", label: "Require NIFTY aligned", type: "bool" },
    { key: "exitOnVwapLoss", label: "Exit on 2 closes back thru VWAP", type: "bool" },
    { key: "targetMode", label: "Target", type: "select", options: ["R", "band"] },
    { key: "bandMult", label: "Band σ multiple", type: "number", step: 0.5 },
  ],
  // Lookahead test: loosen the gates so the entry path still fires on random data (no index).
  testParams: {
    minVwapSlopePct: 0,
    holdBars: 1,
    maxVwapCrossings: 999,
    pullbackWindow: 10,
    touchAtrMult: 999,
    dipAtrMult: 999,
    volDryMult: 999,
    maxGapPct: 0,
    minStopPct: 0,
    maxStopAtrMult: 999,
    requireMarket: false,
  },
  warmup: (p) => warmupBars(p),
  onBar(ctx) {
    const p = ctx.params;
    const i = ctx.i;
    if (i < warmupBars(p)) return null;

    const atr = ctx.ind("atr", [p.atrPeriod]);
    if (!(atr > 0)) return null;
    const v = ctx.ind("vwap");
    const c = ctx.bar();
    const prev = ctx.bar(i - 1);

    // Gap filter (known from the open). maxGapPct = 0 turns it off.
    if (p.maxGapPct > 0 && ctx.ref.gapPct != null && Math.abs(ctx.ref.gapPct) > p.maxGapPct) return null;

    // Manage an open position: optional exit on two consecutive closes back through VWAP.
    if (ctx.position) {
      if (p.exitOnVwapLoss) {
        const long = ctx.position.side === "long";
        const vPrev = vwapAt(ctx, 1);
        const back = long ? c.close < v && prev.close < vPrev : c.close > v && prev.close > vPrev;
        if (back) return { exit: true, reason: "Two closes back through VWAP" };
      }
      return null;
    }

    return signalFor(ctx, "long", p, atr, v, c, prev) || signalFor(ctx, "short", p, atr, v, c, prev);
  },
  plan(ctx) {
    const p = ctx.params;
    const i = ctx.i;
    const warm = warmupBars(p);
    if (i < warm) return waiting(`Needs ${warm} bars of VWAP/ATR history first.`);

    if (p.maxGapPct > 0 && ctx.ref.gapPct != null && Math.abs(ctx.ref.gapPct) > p.maxGapPct)
      return off(`Opening gap ${ctx.ref.gapPct.toFixed(2)}% exceeds ${p.maxGapPct}% — skipping today.`);

    const atr = ctx.ind("atr", [p.atrPeriod]);
    const v = ctx.ind("vwap");
    const vThen = vwapAt(ctx, p.slopeBars);
    const slopePct = vThen > 0 ? ((v - vThen) / vThen) * 100 : 0;
    const crosses = vwapCrossings(ctx, i);
    const setups = [];

    if (slopePct >= p.minVwapSlopePct && runOnSide(ctx, i, "long") >= p.holdBars && crosses <= p.maxVwapCrossings && (!p.requireMarket || marketAligned(ctx, "long"))) {
      setups.push({
        side: "long",
        trigger: v,
        when: `dips to VWAP (≈ ${px(v)}) then a green ${tf(ctx)} candle closes above the prior high and back above VWAP`,
        stop: v - p.stopAtrMult * atr,
        approx: true,
      });
    }
    if (slopePct <= -p.minVwapSlopePct && runOnSide(ctx, i, "short") >= p.holdBars && crosses <= p.maxVwapCrossings && (!p.requireMarket || marketAligned(ctx, "short"))) {
      setups.push({
        side: "short",
        trigger: v,
        when: `rises to VWAP (≈ ${px(v)}) then a red ${tf(ctx)} candle closes below the prior low and back below VWAP`,
        stop: v + p.stopAtrMult * atr,
        approx: true,
      });
    }

    if (setups.length)
      return watch(setups, `VWAP ${px(v)} sloping ${slopePct >= 0 ? "up" : "down"} ${Math.abs(slopePct).toFixed(2)}%, ${crosses} crossing${crosses === 1 ? "" : "s"} today — waiting for a pullback.`);
    return off(`No clean VWAP trend (VWAP ${px(v)}, slope ${slopePct.toFixed(2)}%, ${crosses} crossings): needs slope ≥ ${p.minVwapSlopePct}% and ${p.holdBars} closes on one side.`);
  },
});

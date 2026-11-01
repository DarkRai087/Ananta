import { defineStrategy } from "./common.js";
import { watch, off, waiting, tf, px, refPrice } from "./planKit.js";
import { roundTick, tickFor } from "../decision/util.js";
import { hhmmToMin } from "../lab/time.js";
import { rvolFromProfile } from "./volumeBreakoutV2.js";

// CPR / Pivot Reversal v2. Fixes the v1 audit: fades only when the CPR-width regime says the day is
// likely range-bound (WIDE), confirms a real rejection on CLOSED candles inside a ±k·ATR zone, tags
// each trade Setup A (CPR bounce in the daily bias) or B (exhaustion fade at R2/R3/S2/S3) with
// stricter gates on B, counts touches, scores time-of-day, checks volume / extension / NIFTY context,
// and takes the next level toward the pivot (or VWAP) with a min-ATR stop, pre-trade R check and time
// stop. Every filter toggleable; all on by default. v1 stays as `cprReversal`. Signals on closed bars
// only; the shared engine fills at the next bar's open and applies costs, slippage and sizing.
//
// shortcut: width regime uses the ~20 daily bars in ctx.ref.daily, not 60 (LAB.historyDays). Widen
//   when historyDays grows. Deferred to a later pass: cross-strategy regime arbiter, RSI divergence,
//   weekly CPR, previous-day VWAP as a level, 1R partial (engine has no partials). NIFTY context uses
//   the single aligned index bar (VWAP side + distance), not a 60-min VWAP-cross count.

const atrOf = (ctx) => ctx.ind("atr", [ctx.params.atrPeriod]) ?? null;

// CPR (pivot / BC / TC) and its width% from one day's H/L/C — pure, so a bar's regime is self-contained.
export function cprOf({ high: H, low: L, close: C }) {
  const P = (H + L + C) / 3;
  const bc0 = (H + L) / 2;
  const tc0 = 2 * P - bc0;
  return { pivot: P, bc: Math.min(bc0, tc0), tc: Math.max(bc0, tc0), widthPct: (Math.abs(tc0 - bc0) / P) * 100 };
}

// Regime from today's CPR width vs the distribution of recent daily widths (percentile rank).
// WIDE (> widePct) → range day, fade; NARROW (< narrowPct) → trend day, stand down.
export function regimeOf(todayWidth, dailyBars, p) {
  const widths = dailyBars.map((d) => cprOf(d).widthPct).filter((w) => Number.isFinite(w));
  if (widths.length < p.regimeMinDays || !Number.isFinite(todayWidth)) return { tag: "NORMAL", pct: null, n: widths.length };
  const rank = widths.filter((w) => w <= todayWidth).length / widths.length;
  const tag = rank >= p.widePct ? "WIDE" : rank <= p.narrowPct ? "NARROW" : "NORMAL";
  return { tag, pct: rank, n: widths.length };
}

// Closed-candle rejection of level L on `side` inside a ±zoneAtr·ATR zone. Long = support bounce
// (tagged the zone from above, closed back above it); short = resistance rejection. Pure.
export function rejection(bar, prevBar, L, atr, side, p) {
  const zone = p.zoneAtr * atr;
  const range = bar.high - bar.low;
  if (range <= 0 || atr <= 0) return null;
  const body = Math.abs(bar.close - bar.open);
  const loc = (bar.close - bar.low) / range; // 1 = closed at the high
  if (side === "long") {
    if (!(bar.low <= L + zone)) return null; // tagged the zone
    if (!(bar.low >= L - p.throughAtr * atr)) return null; // didn't slice clean through (a breakdown)
    if (!(bar.close > L + zone)) return null; // closed back outside, above the zone
    if (p.useCandleQuality) {
      if (loc < 0.6) return null; // close in the top 40% of range
      const wick = Math.min(bar.open, bar.close) - bar.low;
      if (p.rejectWick && wick < body) return null; // rejection wick ≥ body
    }
    if (p.reclaim && prevBar && !(prevBar.close < L)) return null; // optional: price was below before reclaiming
    return { loc, wickRatio: body > 0 ? (Math.min(bar.open, bar.close) - bar.low) / body : Infinity };
  }
  if (!(bar.high >= L - zone)) return null;
  if (!(bar.high <= L + p.throughAtr * atr)) return null;
  if (!(bar.close < L - zone)) return null;
  if (p.useCandleQuality) {
    if (loc > 0.4) return null;
    const wick = bar.high - Math.max(bar.open, bar.close);
    if (p.rejectWick && wick < body) return null;
  }
  if (p.reclaim && prevBar && !(prevBar.close > L)) return null;
  return { loc, wickRatio: body > 0 ? (bar.high - Math.max(bar.open, bar.close)) / body : Infinity };
}

// How many times before `upto` price tagged L's zone from the rejection side (for the 1st/2nd-touch rule).
export function touchCount(candles, L, atr, upto, side, p) {
  const zone = p.zoneAtr * atr;
  let n = 0;
  for (let k = 1; k <= upto; k++) {
    const b = candles[k];
    if (side === "long" ? b.low <= L + zone && b.low >= L - p.throughAtr * atr : b.high >= L - zone && b.high <= L + p.throughAtr * atr) n++;
  }
  return n;
}

// Reward:risk after a round-trip cost cushion. true = worth taking.
export function passRR(entry, stop, target, p) {
  const risk = Math.abs(entry - stop);
  if (!(risk > 0) || target == null) return false;
  const reward = Math.abs(target - entry) - (entry * p.costCushionPct) / 100;
  return reward / risk >= p.minRR;
}

// Classic-pivot levels, labelled and typed A (CPR / inner) or B (outer, exhaustion fade).
const LEVELS = [
  ["S3", "s3", "B"], ["S2", "s2", "B"], ["S1", "s1", "A"], ["BC", "bc", "A"], ["P", "pivot", "A"],
  ["TC", "tc", "A"], ["R1", "r1", "A"], ["R2", "r2", "B"], ["R3", "r3", "B"],
];

// Daily bias: open location vs CPR + two-day CPR relationship (higher / lower value).
function biasOf(ctx, pv) {
  let b = 0;
  const open = ctx.ref.open;
  if (open != null) b += open > pv.tc ? 1 : open < pv.bc ? -1 : 0;
  const daily = ctx.ref.daily;
  if (daily.length >= 2) {
    const yCpr = cprOf(daily[daily.length - 2]); // the CPR that governed the previous day
    b += pv.pivot > yCpr.tc ? 1 : pv.pivot < yCpr.bc ? -1 : 0;
  }
  return b > 0 ? "up" : b < 0 ? "down" : "neutral";
}

// Next level toward the pivot (or VWAP / pivot, per targetMode) beyond `entry` in the trade direction.
function targetFor(ctx, side, entry, pv, p) {
  const long = side === "long";
  if (p.targetMode === "vwap") {
    const v = ctx.ind("vwap");
    if (v != null && (long ? v > entry : v < entry)) return v;
  }
  if (p.targetMode === "pivot" && (long ? pv.pivot > entry : pv.pivot < entry)) return pv.pivot;
  const prices = LEVELS.map(([, k]) => pv[k]).filter((x) => x != null);
  const beyond = prices.filter((x) => (long ? x > entry : x < entry));
  if (!beyond.length) return null;
  return long ? Math.min(...beyond) : Math.max(...beyond);
}

// Extension (Setup B gate): VWAP distance in ATR, and ADR used (|close − open| ÷ daily ATR).
function extension(ctx, atr) {
  const v = ctx.ind("vwap");
  const vwapAtr = v != null && atr > 0 ? Math.abs(ctx.bar().close - v) / atr : null;
  const adr = ctx.ref.atrDaily > 0 && ctx.ref.open != null ? Math.abs(ctx.bar().close - ctx.ref.open) / ctx.ref.atrDaily : null;
  return { vwapAtr, adr };
}

// NIFTY context gate for fades: don't fade into a strongly trending index (close far on the wrong side
// of its VWAP). Degrades to pass when the index isn't attached. shortcut: single aligned bar, not a
// 60-min VWAP-cross count.
function marketOk(ctx, side, p) {
  if (!p.useMarket) return true;
  const m = ctx.market("nifty");
  if (!m || m.vwap == null) return true;
  const dist = (m.close - m.vwap) / m.vwap;
  if (side === "long" && dist < -p.marketBand) return false; // falling market — don't fade long
  if (side === "short" && dist > p.marketBand) return false;
  return true;
}

// Weekly CPR from the last 5 daily bars (week high / low / close) — a confluence reference only.
export function weeklyCpr(dailyBars) {
  const wk = dailyBars.slice(-5);
  if (wk.length < 5) return null;
  return cprOf({ high: Math.max(...wk.map((d) => d.high)), low: Math.min(...wk.map((d) => d.low)), close: wk[wk.length - 1].close });
}

// RSI(14) divergence at the level (score boost only, never a trigger): price made a fresh extreme
// over the last `bars` while RSI did not. Causal — reads bars ≤ i. Returns true/false.
export function rsiDivergence(ctx, side, bars) {
  const rsiNow = ctx.ind("rsi", [14]);
  if (rsiNow == null) return false;
  const c = ctx.bar();
  let ext = side === "long" ? Infinity : -Infinity;
  let extRsi = null;
  for (let a = 1; a <= bars; a++) {
    const b = ctx.bar(ctx.i - a);
    if (!b) break;
    const px = side === "long" ? b.low : b.high;
    if (side === "long" ? px < ext : px > ext) { ext = px; extRsi = ctx.ind("rsi", [14], a); }
  }
  if (extRsi == null) return false;
  return side === "long" ? c.low < ext && rsiNow > extRsi : c.high > ext && rsiNow < extRsi; // lower low / higher RSI (and mirror)
}

export default defineStrategy({
  id: "cprReversalV2",
  levels: ["tc", "pivot", "bc", "r1", "s1"],
  name: "CPR / Pivot Reversal v2",
  description:
    "Fades pivot levels only on WIDE-CPR (range-likely) days, on a confirmed closed-candle rejection inside a ±ATR zone. Tags Setup A (CPR/inner bounce in the daily bias) or B (exhaustion fade at R2/R3/S2/S3, stricter: extension + volume + NIFTY context). 1st/2nd touch only, time-of-day scored, next-level/VWAP target, min-ATR stop, pre-trade R check, time stop. Each filter toggleable.",
  defaultInterval: "5m",
  needsMarket: true, // NIFTY context gate for fades; passes when the index isn't attached
  params: {
    targetR: 0, // use the next-level / VWAP target; set > 0 for an R target instead
    // §1 zones
    zoneAtr: 0.15, throughAtr: 1.0,
    // §2 regime
    useRegime: true, regimeMode: "strict", widePct: 0.6, narrowPct: 0.3, regimeMinDays: 10,
    // §3 rejection quality
    useCandleQuality: true, rejectWick: true, reclaim: false,
    // §4 bias / setups
    useBias: true, allowB: true,
    // §5 volume
    useVolume: true, rejRvolMult: 1.3, throughRvolCancel: 2.0, rvolDays: 20,
    // §6 extension (Setup B)
    useExtension: true, bVwapAtr: 1.5, bAdrUsed: 0.7,
    // §7 touch + time
    maxTouch: 2, preferredFrom: "11:00", preferredTo: "14:00",
    // §8 market context
    useMarket: true, marketBand: 0.004,
    // §9 exits / sizing
    targetMode: "level", stopBufAtr: 0.1, minStopAtr: 0.5, useRR: true, minRR: 1.3, costCushionPct: 0.12,
    timeStopBars: 5, timeStopMinR: 0.5, forceFlat: "15:12",
    // §10 score / confluence (boosts only, never triggers)
    minScore: 0, useWeekly: true, useCamarilla: true, useRsiDiv: true, rsiDivBars: 10,
    entryStart: "09:30", entryEnd: "14:30",
  },
  spec: [
    { key: "zoneAtr", label: "Zone half-width (× ATR)", type: "number", step: 0.05 },
    { key: "throughAtr", label: "Max slice-through (× ATR)", type: "number", step: 0.1 },
    { key: "useRegime", label: "Filter: CPR-width regime", type: "bool" },
    { key: "regimeMode", label: "Narrow-day handling", type: "select", options: ["strict", "biasOnly", "off"] },
    { key: "widePct", label: "WIDE ≥ width percentile", type: "number", step: 0.05 },
    { key: "narrowPct", label: "NARROW ≤ width percentile", type: "number", step: 0.05 },
    { key: "useCandleQuality", label: "Filter: rejection candle quality", type: "bool" },
    { key: "rejectWick", label: "Require wick ≥ body", type: "bool" },
    { key: "reclaim", label: "Require prior bar beyond level", type: "bool" },
    { key: "useBias", label: "Filter: trade A in the daily bias", type: "bool" },
    { key: "allowB", label: "Allow Setup B (exhaustion fade)", type: "bool" },
    { key: "useVolume", label: "Filter: approach + rejection volume", type: "bool" },
    { key: "rejRvolMult", label: "Min rejection RVOL", type: "number", step: 0.1 },
    { key: "throughRvolCancel", label: "Cancel level if closed through at RVOL ≥", type: "number", step: 0.1 },
    { key: "useExtension", label: "Filter: Setup B needs extension", type: "bool" },
    { key: "bVwapAtr", label: "B: VWAP distance ≥ (× ATR)", type: "number", step: 0.1 },
    { key: "bAdrUsed", label: "B: ADR used ≥", type: "number", step: 0.05 },
    { key: "maxTouch", label: "Trade only touch ≤ N", type: "number", step: 1 },
    { key: "preferredFrom", label: "Score-boost window from", type: "time" },
    { key: "preferredTo", label: "Score-boost window to", type: "time" },
    { key: "useMarket", label: "Filter: NIFTY context for fades", type: "bool" },
    { key: "marketBand", label: "Max NIFTY distance from VWAP", type: "number", step: 0.001 },
    { key: "targetMode", label: "Target", type: "select", options: ["level", "pivot", "vwap"] },
    { key: "stopBufAtr", label: "Stop beyond wick (× ATR)", type: "number", step: 0.05 },
    { key: "minStopAtr", label: "Min stop distance (× ATR)", type: "number", step: 0.1 },
    { key: "useRR", label: "Filter: pre-trade R check", type: "bool" },
    { key: "minRR", label: "Min reward:risk (after costs)", type: "number", step: 0.1 },
    { key: "timeStopBars", label: "Time stop after N bars", type: "number", step: 1 },
    { key: "timeStopMinR", label: "Time stop needs ≥ R", type: "number", step: 0.1 },
    { key: "forceFlat", label: "Force flat by", type: "time" },
    { key: "minScore", label: "Min setup score (0 = off)", type: "number", step: 5 },
    { key: "useWeekly", label: "Confluence: weekly CPR", type: "bool" },
    { key: "useCamarilla", label: "Confluence: Camarilla H3/H4/L3/L4", type: "bool" },
    { key: "useRsiDiv", label: "Score boost: RSI(14) divergence", type: "bool" },
    { key: "rsiDivBars", label: "RSI divergence lookback (bars)", type: "number", step: 1 },
  ],
  // Loosened only so the random-data lookahead/leak test exercises the entry path.
  testParams: { useRegime: false, useCandleQuality: false, useBias: false, useVolume: false, useExtension: false, useMarket: false, useRR: false, maxTouch: 99, zoneAtr: 0.5 },
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const pv = ctx.pivots;
    const atr = atrOf(ctx);

    // In a position: time stop, then force-flat near the close.
    if (ctx.position) {
      const pos = ctx.position;
      if (ctx.state.heldIndex !== pos.entryIndex) {
        ctx.state.heldIndex = pos.entryIndex;
        ctx.state.entryRisk = Math.abs(pos.entry - pos.stop);
      }
      if (ctx.minute() >= hhmmToMin(p.forceFlat)) return { exit: true, reason: `Force flat ${p.forceFlat}` };
      if (p.timeStopBars > 0 && ctx.state.entryRisk > 0) {
        const held = ctx.i - pos.entryIndex;
        const favR = (pos.side === "long" ? ctx.bar().close - pos.entry : pos.entry - ctx.bar().close) / ctx.state.entryRisk;
        if (held >= p.timeStopBars && favR < p.timeStopMinR) return { exit: true, reason: `No ${p.timeStopMinR}R in ${p.timeStopBars} bars` };
      }
      return null;
    }

    if (!pv || ctx.i < 1 || atr == null || atr <= 0) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);

    // Cancel-on-through: a bar that closes clean through a level's zone on strong volume kills fades
    // of that level for the rest of the day.
    const cancelled = (ctx.state.cancelled ??= new Set());
    if (p.useVolume) {
      const rv = rvolFromProfile(ctx.ref.profile, ctx.minute(), c.volume || 0, p.rvolDays).rvol;
      if (rv != null && rv >= p.throughRvolCancel) {
        for (const [name, key] of LEVELS) {
          const L = pv[key];
          if (L != null && (c.close > L + p.zoneAtr * atr || c.close < L - p.zoneAtr * atr) && Math.abs(c.open - L) <= p.throughAtr * atr) cancelled.add(name);
        }
      }
    }

    // Regime.
    const reg = p.useRegime ? regimeOf(pv.cprWidthPct, ctx.ref.daily, p) : { tag: "WIDE", pct: null, n: 0 };
    if (p.useRegime && reg.tag === "NARROW" && p.regimeMode === "strict") return null;

    const bias = biasOf(ctx, pv);
    const candles = ctx.bars();
    const ext = extension(ctx, atr);

    for (const side of ["long", "short"]) {
      if (side === "long" ? !p.allowLong : !p.allowShort) continue;
      for (const [name, key, type] of LEVELS) {
        const L = pv[key];
        if (L == null || cancelled.has(name)) continue;
        if (type === "B" && !p.allowB) continue;
        const rej = rejection(c, prev, L, atr, side, p);
        if (!rej) continue;

        // Regime "biasOnly" on a narrow day: only Setup A in the bias direction survives.
        if (p.useRegime && reg.tag === "NARROW" && p.regimeMode === "biasOnly" && !(type === "A" && bias === (side === "long" ? "up" : "down"))) continue;
        // Setup A trades with the daily bias; a neutral bias allows either side.
        if (p.useBias && type === "A" && bias !== "neutral" && bias !== (side === "long" ? "up" : "down")) continue;
        // Setup B is the against-the-move fade: needs extension and (if on) NIFTY context.
        if (type === "B") {
          if (p.useExtension && !((ext.vwapAtr != null && ext.vwapAtr >= p.bVwapAtr) || (ext.adr != null && ext.adr >= p.bAdrUsed))) continue;
          if (!marketOk(ctx, side, p)) continue;
        }
        // Touch count: this rejection is touch (#prior + 1).
        const touch = touchCount(candles, L, atr, ctx.i - 1, side, p) + 1;
        if (touch > p.maxTouch) continue;
        // Volume: declining approach + rejection RVOL.
        if (p.useVolume) {
          const rvolNow = rvolFromProfile(ctx.ref.profile, ctx.minute(), c.volume || 0, p.rvolDays).rvol;
          if (rvolNow == null || rvolNow < p.rejRvolMult) continue;
          // Approach volume should be fading into the level: the bar just before the rejection is
          // quieter than the one three bars back (net decline, not a strict monotonic run).
          if (ctx.i >= 3) {
            const near = rvolFromProfile(ctx.ref.profile, ctx.minute(1), ctx.bar(ctx.i - 1).volume || 0, p.rvolDays).rvol;
            const far = rvolFromProfile(ctx.ref.profile, ctx.minute(3), ctx.bar(ctx.i - 3).volume || 0, p.rvolDays).rvol;
            if (near != null && far != null && near > far) continue;
          }
        }

        // Stop beyond the rejection wick, floored to a min-ATR distance; round away from price.
        const tk = tickFor(c.close);
        let stop = side === "long" ? Math.min(c.low, L) - p.stopBufAtr * atr : Math.max(c.high, L) + p.stopBufAtr * atr;
        if (side === "long" && c.close - stop < p.minStopAtr * atr) stop = c.close - p.minStopAtr * atr;
        if (side === "short" && stop - c.close < p.minStopAtr * atr) stop = c.close + p.minStopAtr * atr;
        stop = roundTick(stop, tk, side === "long" ? "down" : "up");
        if (side === "long" ? stop >= c.close : stop <= c.close) continue;

        const entry = c.close; // proxy; the engine fills at the next open
        let target = targetFor(ctx, side, entry, pv, p);
        if (target != null) target = roundTick(target, tk, side === "long" ? "down" : "up");
        if (p.useRR && !passRR(entry, stop, target, p)) continue;

        const { score, notes } = scoreOf({ type, touch, rej, reg, ext, bias, side, ctx, p, L, atr });
        if (score < p.minScore) continue;
        const rv = rvolFromProfile(ctx.ref.profile, ctx.minute(), c.volume || 0, p.rvolDays).rvol;
        return {
          side,
          stop,
          target,
          reason: `${type} ${name} ${reg.tag}${reg.pct != null ? `(${(reg.pct * 100) | 0}pct)` : ""} bias:${bias} touch${touch} ${side === "long" ? "bounce" : "fade"} RVOL=${rv == null ? "–" : rv.toFixed(1)} VWAPd=${ext.vwapAtr == null ? "–" : ext.vwapAtr.toFixed(1)}ATR score=${score}/100${notes.length ? ` [${notes.join(",")}]` : ""}`,
        };
      }
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const pv = ctx.pivots;
    if (!pv) return off("No previous session.");
    const atr = atrOf(ctx);
    if (atr == null) return waiting("Warming up (ATR).");
    const reg = p.useRegime ? regimeOf(pv.cprWidthPct, ctx.ref.daily, p) : { tag: "WIDE", pct: null };
    if (p.useRegime && reg.tag === "NARROW" && p.regimeMode === "strict") return off(`NARROW CPR (${pv.cprWidthPct.toFixed(2)}%) — trend day likely, fades disabled.`);
    const bias = biasOf(ctx, pv);
    const price = refPrice(ctx);
    const z = p.zoneAtr * atr;
    const setups = [];
    const sup = LEVELS.filter(([, k]) => pv[k] < price).sort((a, b) => pv[b[1]] - pv[a[1]])[0];
    const res = LEVELS.filter(([, k]) => pv[k] > price).sort((a, b) => pv[a[1]] - pv[b[1]])[0];
    if (sup && p.allowLong) setups.push({ side: "long", trigger: pv[sup[1]], when: `dips into ${sup[0]} ±${px(z)}, closes back above on a rejection`, stop: roundTick(pv[sup[1]] - z - p.stopBufAtr * atr, tickFor(price), "down"), approx: true });
    if (res && p.allowShort) setups.push({ side: "short", trigger: pv[res[1]], when: `rises into ${res[0]} ±${px(z)}, closes back below on a rejection`, stop: roundTick(pv[res[1]] + z + p.stopBufAtr * atr, tickFor(price), "up"), approx: true });
    if (!setups.length) return off("Price is beyond R3 / S3 — no level to trade against.");
    return watch(setups, `${reg.tag} CPR (${pv.cprWidthPct.toFixed(2)}%), bias ${bias}. R2 ${px(pv.r2)} · R1 ${px(pv.r1)} · CPR ${px(pv.bc)}–${px(pv.tc)} · S1 ${px(pv.s1)} · S2 ${px(pv.s2)}`);
  },
});

// Setup score 0–100: base + rejection quality, regime, touch, time-of-day, bias/extension,
// confluence (PDH/PDL, VWAP, prev-day VWAP, weekly pivot/CPR, OR edge, Camarilla, round number),
// and an RSI-divergence boost. Returns { score, notes[] }.
export function scoreOf({ type, touch, rej, reg, ext, bias, side, ctx, p, L, atr }) {
  let s = 40;
  const notes = [];
  if (rej) { const q = (rej.wickRatio >= 1 ? 10 : 0) + (rej.loc >= 0.75 || rej.loc <= 0.25 ? 5 : 0); if (q) { s += q; notes.push("reject"); } }
  if (reg.tag === "WIDE") { s += 10; notes.push("wide"); }
  if (touch === 1) { s += 10; notes.push("t1"); } else if (touch === 2) { s += 5; }
  const m = ctx.minute();
  if (m >= hhmmToMin(p.preferredFrom) && m < hhmmToMin(p.preferredTo)) { s += 10; notes.push("prime-time"); }
  if (type === "A" && (bias === "neutral" || bias === (side === "long" ? "up" : "down"))) { s += 5; notes.push("bias"); }
  if (type === "B" && ((ext.vwapAtr ?? 0) >= p.bVwapAtr || (ext.adr ?? 0) >= p.bAdrUsed)) { s += 5; notes.push("extended"); }
  // Confluence: the level sits within 0.2 ATR of another reference.
  const near = (x) => x != null && Math.abs(L - x) <= 0.2 * atr;
  const step = L < 1000 ? 10 : 50;
  const wk = p.useWeekly ? weeklyCpr(ctx.ref.daily) : null;
  const cam = p.useCamarilla ? ctx.pivots : null;
  const or = ctx.openingRange(15);
  const conf =
    (near(ctx.ref.pdh) || near(ctx.ref.pdl) ? ["PDHL"] : [])
      .concat(near(ctx.ind("vwap")) ? ["VWAP"] : [], near(ctx.ref.pdVwap) ? ["pdVWAP"] : [], near(Math.round(L / step) * step) ? ["round"] : [],
        wk && (near(wk.pivot) || near(wk.tc) || near(wk.bc)) ? ["weekly"] : [],
        cam && (near(cam.h3) || near(cam.h4) || near(cam.l3) || near(cam.l4)) ? ["cam"] : [],
        or && (near(or.high) || near(or.low)) ? ["OR"] : []);
  if (conf.length) { s += Math.min(15, 10 + (conf.length - 1) * 2); notes.push(`conf:${conf.join("+")}`); }
  if (p.useRsiDiv && rsiDivergence(ctx, side, p.rsiDivBars)) { s += 5; notes.push("rsiDiv"); }
  return { score: Math.max(0, Math.min(100, s)), notes };
}

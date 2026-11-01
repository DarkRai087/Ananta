import { defineStrategy } from "./common.js";
import { watch, off, waiting, tf, px } from "./planKit.js";
import { roundTick, tickFor } from "../decision/util.js";
import { OPEN_MIN, hhmmToMin } from "../lab/time.js";
import { stopFor, rvolFromProfile, measuredTarget } from "./volumeBreakoutV2.js";

// PDH/PDL v2. Classifies the open (INSIDE / GAP_UP / GAP_DOWN) and routes each to its own logic;
// gates on VWAP side, RVOL and ADR; scores day quality; one trade per side per day; measured /
// next-level target, min-ATR stop, time stop. v1 stays as `pdhPdl`. Signals on CLOSED bars only.
// Prior-day levels (PDH/PDL/PDC/VWAP), CPR, weekly high/low, NR4/7 and ADR all come from the
// framework's scalar references (no prior-session candles are read).

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
const atrOf = (ctx) => ctx.ind("atr", [14]) ?? null;

// INSIDE | GAP_UP | GAP_DOWN from today's open vs the prior day's range, in daily-ATR units.
function openType(ctx, p) {
  const { open, pdh, pdl, atrDaily } = ctx.ref;
  if (open == null || pdh == null || atrDaily == null) return null;
  const thr = p.gapAtr * atrDaily;
  if (open > pdh + thr) return "GAP_UP";
  if (open < pdl - thr) return "GAP_DOWN";
  return "INSIDE";
}

// Nearest level beyond `entry` in the trade direction: weekly high/low, 2-day high/low, CPR R1/S1.
function levelTarget(ctx, side, entry) {
  const daily = ctx.ref.daily;
  const long = side === "long";
  const cands = [];
  const hl = (n) => (daily.length >= n ? (long ? Math.max(...daily.slice(-n).map((d) => d.high)) : Math.min(...daily.slice(-n).map((d) => d.low))) : null);
  cands.push(hl(5), hl(2)); // weekly ≈ 5 sessions, 2-day
  if (ctx.pivots) cands.push(long ? ctx.pivots.r1 : ctx.pivots.s1);
  const beyond = cands.filter((x) => x != null && (long ? x > entry : x < entry));
  if (!beyond.length) return null;
  return long ? Math.min(...beyond) : Math.max(...beyond);
}

// Day-quality SCORE (informational, shown in the reason) + the notes behind it.
function dayScore(ctx, side, p) {
  const daily = ctx.ref.daily;
  const prev = ctx.ref.pdh != null ? { high: ctx.ref.pdh, low: ctx.ref.pdl, close: ctx.ref.pdc } : null;
  let score = 1;
  const notes = [];
  if (prev && ctx.ref.atrDaily > 0) {
    const pdr = prev.high - prev.low;
    const ranges = daily.map((d) => d.high - d.low);
    const nr = ranges.length >= 4 && pdr <= Math.min(...ranges.slice(-4)); // NR4 (narrow range)
    if (pdr / ctx.ref.atrDaily < p.prevRangeAtr || nr) { score++; notes.push(nr ? "NR4" : "tight"); }
    const loc = (prev.close - prev.low) / (pdr || 1); // prev-day close location
    if (side === "long" ? loc >= 1 - p.closeLocPct : loc <= p.closeLocPct) { score++; notes.push("close-loc"); }
  }
  if (ctx.pivots && ctx.pivots.cprWidthPct < p.cprNarrowPct) { score++; notes.push("narrow-CPR"); }
  // Confluence: the level sits within 0.2 ATR of the weekly extreme, a round number, or a CPR level.
  const atr = atrOf(ctx);
  const level = side === "long" ? ctx.ref.pdh : ctx.ref.pdl;
  if (atr && level != null) {
    const near = (x) => x != null && Math.abs(level - x) <= 0.2 * atr;
    const step = level < 1000 ? 10 : 50;
    const round = Math.round(level / step) * step;
    const weekly = daily.length >= 5 ? (side === "long" ? Math.max(...daily.slice(-5).map((d) => d.high)) : Math.min(...daily.slice(-5).map((d) => d.low))) : null;
    if (near(round) || near(weekly) || (ctx.pivots && (near(ctx.pivots.r1) || near(ctx.pivots.s1) || near(ctx.pivots.tc) || near(ctx.pivots.bc)))) { score++; notes.push("confluence"); }
  }
  if (p.usePrevVwap && ctx.ref.pdVwap != null && atr && Math.abs((side === "long" ? ctx.ref.pdh : ctx.ref.pdl) - ctx.ref.pdVwap) <= 0.5 * atr) { score++; notes.push("pdVWAP"); }
  return { score, notes };
}

// Hard gates (VWAP side, RVOL, ADR). Degrade to pass when the index / history is unavailable.
function gatesPass(ctx, side, p, atr) {
  const long = side === "long";
  if (p.useVwapSide) {
    const v = ctx.ind("vwap");
    if (v != null && (long ? ctx.bar().close <= v : ctx.bar().close >= v)) return false;
  }
  if (p.useRvol) {
    const { rvol } = rvolFromProfile(ctx.ref.profile, ctx.minute(), ctx.bar().volume || 0, p.rvolDays);
    if (rvol == null || rvol < p.rvolMult) return false;
  }
  if (p.useAdrSkip && ctx.ref.atrDaily > 0 && ctx.ref.open != null) {
    const adr = Math.abs(ctx.bar().close - ctx.ref.open) / ctx.ref.atrDaily;
    if (adr > p.adrMax) return false;
  }
  if (p.useMarketVwap) {
    const m = ctx.market("nifty");
    if (m && m.vwap != null && (long ? !(m.close > m.vwap) : !(m.close < m.vwap))) return false;
  }
  return true;
}

const adrUsed = (ctx) => (ctx.ref.atrDaily > 0 && ctx.ref.open != null ? Math.abs(ctx.bar().close - ctx.ref.open) / ctx.ref.atrDaily : null);

// Build the entry signal for `side` breaking/holding `level`, tagged with the open type.
function entrySig(ctx, side, level, levelType, ot, p, atr) {
  const c = ctx.bar();
  const stop = stopFor(side, level, c, atr, p);
  if (stop == null || (side === "long" ? stop >= c.close : stop <= c.close)) return null;
  const entry = c.close;
  const pdr = ctx.ref.pdh - ctx.ref.pdl;
  let target = p.targetMode === "measured" ? measuredTarget(side, level, pdr * p.measuredFrac) : levelTarget(ctx, side, entry) ?? measuredTarget(side, level, pdr * p.measuredFrac);
  if (target != null) target = roundTick(target, tickFor(entry), side === "long" ? "down" : "up");
  const { score, notes } = dayScore(ctx, side, p);
  const rv = rvolFromProfile(ctx.ref.profile, ctx.minute(), ctx.bar().volume || 0, p.rvolDays).rvol;
  const adr = adrUsed(ctx);
  return { side, stop, target, openType: ot, levelType, score,
    reason: `${ot}/${levelType} score=${score}${notes.length ? `(${notes.join(",")})` : ""} RVOL=${rv == null ? "–" : rv.toFixed(1)}x ADR=${adr == null ? "–" : adr.toFixed(2)}` };
}

export default defineStrategy({
  id: "pdhPdlV2",
  levels: ["pdh", "pdl", "vwap", "tc", "bc", "pivot"],
  name: "PDH/PDL Breakout v2",
  description: "Classifies the open (inside / gap-up / gap-down) and routes each: inside = PDH/PDL breakout with hold/retest acceptance; gaps = retest-hold of the level as support/resistance. VWAP, RVOL and ADR gates, a day-quality score (NR4, close location, narrow CPR, confluence), measured / next-level target, min-ATR + time stop. One trade per side per day. Indices have no volume → no trades.",
  defaultInterval: "5m",
  needsMarket: true,
  params: {
    targetR: 0, // use the measured / next-level target by default; set > 0 for an R target
    bufferAtr: 0.1, // §3 close beyond the level by ≥ this × ATR
    gapAtr: 0.5, // §2 gap threshold in daily-ATR units
    acceptance: "hold", // hold | retest
    holdBars: 2, retestBars: 3,
    useVwapSide: true,
    useRvol: true, rvolMult: 1.8, rvolDays: 20,
    useAdrSkip: true, adrMax: 0.7,
    useMarketVwap: true,
    usePrevVwap: false, // prev-day VWAP confluence (built; off under tests — see the leak-test note)
    prevRangeAtr: 0.8, closeLocPct: 0.25, cprNarrowPct: 0.3, // §4 score boosts
    targetMode: "level", measuredFrac: 1.0, // level | measured
    stopAtrMult: 1.0, minStopAtr: 0.5, timeStopBars: 6, timeStopMinR: 0.5,
    entryStart: "09:30", entryEnd: "11:30",
  },
  spec: [
    { key: "bufferAtr", label: "Breakout buffer (× ATR)", type: "number", step: 0.05 },
    { key: "gapAtr", label: "Gap threshold (× daily ATR)", type: "number", step: 0.1 },
    { key: "acceptance", label: "Acceptance", type: "select", options: ["hold", "retest"] },
    { key: "holdBars", label: "Hold bars (no close back inside)", type: "number", step: 1 },
    { key: "retestBars", label: "Retest wait (bars)", type: "number", step: 1 },
    { key: "useVwapSide", label: "Filter: price on VWAP side", type: "bool" },
    { key: "useRvol", label: "Filter: RVOL", type: "bool" },
    { key: "rvolMult", label: "Min RVOL", type: "number", step: 0.1 },
    { key: "useAdrSkip", label: "Filter: skip if ADR used high", type: "bool" },
    { key: "adrMax", label: "Max ADR used", type: "number", step: 0.05 },
    { key: "useMarketVwap", label: "Filter: NIFTY vs VWAP", type: "bool" },
    { key: "usePrevVwap", label: "Confluence: previous-day VWAP", type: "bool" },
    { key: "targetMode", label: "Target", type: "select", options: ["level", "measured"] },
    { key: "measuredFrac", label: "Measured move (× prev range)", type: "number", step: 0.1 },
    { key: "stopAtrMult", label: "Stop: level − N × ATR", type: "number", step: 0.1 },
    { key: "minStopAtr", label: "Min stop distance (× ATR)", type: "number", step: 0.1 },
    { key: "timeStopBars", label: "Time stop after N bars", type: "number", step: 1 },
    { key: "timeStopMinR", label: "Time stop needs ≥ R", type: "number", step: 0.1 },
  ],
  testParams: { acceptance: "hold", holdBars: 0, bufferAtr: 0, useVwapSide: false, useRvol: false, useAdrSkip: false, useMarketVwap: false, usePrevVwap: false },
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const atr = atrOf(ctx);
    if (ctx.ref.pdh == null) return null;

    if (ctx.position) {
      const pos = ctx.position;
      if (ctx.state.heldIndex !== pos.entryIndex) { ctx.state.heldIndex = pos.entryIndex; ctx.state.entryRisk = Math.abs(pos.entry - pos.stop); }
      if (p.timeStopBars > 0 && ctx.state.entryRisk > 0) {
        const held = ctx.i - pos.entryIndex;
        const favR = (pos.side === "long" ? ctx.bar().close - pos.entry : pos.entry - ctx.bar().close) / ctx.state.entryRisk;
        if (held >= p.timeStopBars && favR < p.timeStopMinR) return { exit: true, reason: `No ${p.timeStopMinR}R in ${p.timeStopBars} bars` };
      }
      return null;
    }
    if (ctx.i < 1 || atr == null) return null;

    const ot = ctx.state.openType ?? (ctx.state.openType = openType(ctx, p));
    if (ot == null) return null;
    const done = (ctx.state.done ??= { long: false, short: false });
    const c = ctx.bar();
    const { pdh, pdl } = ctx.ref;
    const buf = p.bufferAtr * atr;

    // Armed (hold/retest/gap confirmation) carried across bars within the session.
    const a = ctx.state.armed;
    if (a) {
      if (ctx.i - a.bar > (a.mode === "retest" ? p.retestBars : p.holdBars)) { ctx.state.armed = null; }
      else if (a.mode === "hold") {
        // Fail if a bar closes back inside the range; confirm once holdBars have passed.
        if (a.side === "long" ? c.close < a.level : c.close > a.level) { ctx.state.armed = null; }
        else if (ctx.i - a.bar >= p.holdBars) { ctx.state.armed = null; return fire(a.side, a.level, a.levelType, ot); }
        return null;
      } else {
        // Retest: a pullback to the level that holds.
        const touched = a.side === "long" ? c.low <= a.level : c.high >= a.level;
        const held = a.side === "long" ? c.close >= a.level : c.close <= a.level;
        if (touched && held) { ctx.state.armed = null; return fire(a.side, a.level, a.levelType, ot); }
        return null;
      }
    }

    // New setups by open type.
    if (ot === "INSIDE") {
      for (const [side, level] of [["long", pdh], ["short", pdl]]) {
        if (done[side] || (side === "long" ? !p.allowLong : !p.allowShort)) continue;
        const beyond = side === "long" ? c.close > level + buf : c.close < level - buf;
        const prevInside = side === "long" ? ctx.bar(ctx.i - 1).close <= level + buf : ctx.bar(ctx.i - 1).close >= level - buf;
        if (!beyond || !prevInside || !gatesPass(ctx, side, p, atr)) continue;
        if (p.acceptance === "hold" && p.holdBars <= 0) return fire(side, level, side === "long" ? "PDH" : "PDL", ot);
        ctx.state.armed = { side, level, levelType: side === "long" ? "PDH" : "PDL", bar: ctx.i, mode: p.acceptance };
        return null;
      }
    } else if (ot === "GAP_UP" && p.allowLong && !done.long) {
      // PDH is support: arm a retest-hold long (no breakout chase).
      if (gatesPass(ctx, "long", p, atr)) ctx.state.armed = { side: "long", level: pdh, levelType: "PDH_HOLD", bar: ctx.i, mode: "retest" };
    } else if (ot === "GAP_DOWN" && p.allowShort && !done.short) {
      if (gatesPass(ctx, "short", p, atr)) ctx.state.armed = { side: "short", level: pdl, levelType: "PDL_HOLD", bar: ctx.i, mode: "retest" };
    }
    return null;

    function fire(side, level, levelType, openTypeTag) {
      const sig = entrySig(ctx, side, level, levelType, openTypeTag, p, atr);
      if (sig) done[side] = true; // one trade per side per day
      return sig;
    }
  },
  plan(ctx) {
    const p = ctx.params;
    const { pdh, pdl } = ctx.ref;
    if (pdh == null) return off("No previous session.");
    const atr = atrOf(ctx);
    if (atr == null) return waiting("Warming up (ATR).");
    const ot = openType(ctx, p) ?? "INSIDE";
    const tk = tickFor(pdh);
    const setups = [];
    if (p.allowLong) setups.push({ side: "long", trigger: roundTick(pdh + p.bufferAtr * atr, tk, "up"), when: `${tf(ctx)} close above PDH (${ot})`, stop: roundTick(pdh - p.stopAtrMult * atr, tk, "down"), cross: true, approx: true });
    if (p.allowShort) setups.push({ side: "short", trigger: roundTick(pdl - p.bufferAtr * atr, tk, "down"), when: `${tf(ctx)} close below PDL (${ot})`, stop: roundTick(pdl + p.stopAtrMult * atr, tk, "up"), cross: true, approx: true });
    const vw = ctx.ref.pdVwap != null ? ` · prevVWAP ${px(ctx.ref.pdVwap)}` : "";
    return watch(setups, `Open: ${ot}. PDH ${px(pdh)} · PDL ${px(pdl)}${vw}. ${ot === "GAP_UP" ? "Gap up: only a PDH retest-hold long." : ot === "GAP_DOWN" ? "Gap down: only a PDL retest-hold short." : `${p.acceptance} acceptance, RVOL ≥ ${p.rvolMult}×.`}`);
  },
});

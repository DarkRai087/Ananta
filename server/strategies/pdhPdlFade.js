import { defineStrategy } from "./common.js";
import { watch, off, waiting, tf, px } from "./planKit.js";
import { roundTick, tickFor } from "../decision/util.js";
import { rvolFromProfile } from "./volumeBreakoutV2.js";

// PDH/PDL failed-breakout FADE (separate stats). Price sweeps PDH (or PDL) and then, within N bars,
// closes back inside the range on elevated RVOL → fade toward VWAP / previous close. Stop beyond the
// sweep's extreme + an ATR buffer. A single bar that pokes beyond the level and closes back inside
// is itself a valid fade. One trade per side per day. Signals on CLOSED bars only.
const atrOf = (ctx) => ctx.ind("atr", [14]) ?? null;

export default defineStrategy({
  id: "pdhPdlFade",
  levels: ["pdh", "pdl", "vwap"],
  name: "PDH/PDL Failed-Breakout Fade",
  description: "Fades a failed PDH/PDL breakout: price sweeps the level then closes back inside within N bars on RVOL ≥ 1.5, targeting VWAP / previous close. Stop beyond the sweep extreme. Indices have no volume → no trades.",
  defaultInterval: "5m",
  needsMarket: false,
  params: {
    targetR: 0,
    fadeBars: 3, // sweep and close-back-inside must be within this many bars
    rvolMult: 1.5, rvolDays: 20,
    bufferAtr: 0.25, // stop beyond the sweep extreme by this × ATR
    minStopAtr: 0.5, timeStopBars: 6, timeStopMinR: 0.5,
    entryStart: "09:30", entryEnd: "14:00",
  },
  spec: [
    { key: "fadeBars", label: "Sweep window (bars)", type: "number", step: 1 },
    { key: "rvolMult", label: "Min RVOL", type: "number", step: 0.1 },
    { key: "bufferAtr", label: "Stop beyond sweep (× ATR)", type: "number", step: 0.05 },
    { key: "minStopAtr", label: "Min stop distance (× ATR)", type: "number", step: 0.1 },
    { key: "timeStopBars", label: "Time stop after N bars", type: "number", step: 1 },
    { key: "timeStopMinR", label: "Time stop needs ≥ R", type: "number", step: 0.1 },
  ],
  testParams: { rvolMult: 0, bufferAtr: 0.1 },
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const atr = atrOf(ctx);
    const { pdh, pdl } = ctx.ref;
    if (pdh == null) return null;

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

    const c = ctx.bar();
    const done = (ctx.state.done ??= { long: false, short: false });
    const up = (ctx.state.up ??= { active: false, extreme: 0, bar: -1 }); // PDH sweep
    const dn = (ctx.state.dn ??= { active: false, extreme: 0, bar: -1 }); // PDL sweep
    // Record / extend an active sweep (the current bar's own poke counts, so a one-bar reversal fires).
    if (c.high > pdh) { if (!up.active || ctx.i - up.bar > p.fadeBars) { up.active = true; up.extreme = c.high; up.bar = ctx.i; } else up.extreme = Math.max(up.extreme, c.high); }
    if (c.low < pdl) { if (!dn.active || ctx.i - dn.bar > p.fadeBars) { dn.active = true; dn.extreme = c.low; dn.bar = ctx.i; } else dn.extreme = Math.min(dn.extreme, c.low); }
    if (up.active && ctx.i - up.bar > p.fadeBars) up.active = false;
    if (dn.active && ctx.i - dn.bar > p.fadeBars) dn.active = false;

    const rvolOk = () => { const { rvol } = rvolFromProfile(ctx.ref.profile, ctx.minute(), ctx.bar().volume || 0, p.rvolDays); return rvol == null ? p.rvolMult <= 0 : rvol >= p.rvolMult; };

    // Fade a PDH sweep: closed back below PDH → short toward VWAP / prev close.
    if (up.active && p.allowShort && !done.short && c.close < pdh && rvolOk()) {
      const sig = fade("short", up.extreme, pdh);
      if (sig) { done.short = true; up.active = false; return sig; }
    }
    if (dn.active && p.allowLong && !done.long && c.close > pdl && rvolOk()) {
      const sig = fade("long", dn.extreme, pdl);
      if (sig) { done.long = true; dn.active = false; return sig; }
    }
    return null;

    function fade(side, sweepExtreme, level) {
      const tk = tickFor(c.close);
      const entry = c.close;
      let stop = side === "short" ? sweepExtreme + p.bufferAtr * atr : sweepExtreme - p.bufferAtr * atr;
      if (side === "short" ? stop - entry < p.minStopAtr * atr : entry - stop < p.minStopAtr * atr) stop = side === "short" ? entry + p.minStopAtr * atr : entry - p.minStopAtr * atr;
      stop = roundTick(stop, tk, side === "short" ? "up" : "down");
      if (side === "short" ? stop <= entry : stop >= entry) return null;
      // Target toward VWAP / previous close, whichever is nearer on the correct side; else the level.
      const cands = [ctx.ind("vwap"), ctx.ref.pdc, level].filter((x) => x != null && (side === "short" ? x < entry : x > entry));
      if (!cands.length) return null;
      const target = roundTick(side === "short" ? Math.max(...cands) : Math.min(...cands), tk, side === "short" ? "up" : "down");
      const rv = rvolFromProfile(ctx.ref.profile, ctx.minute(), ctx.bar().volume || 0, p.rvolDays).rvol;
      return { side, stop, target, reason: `Failed ${side === "short" ? "PDH" : "PDL"} breakout (sweep ${px(sweepExtreme)}), RVOL=${rv == null ? "–" : rv.toFixed(1)}x` };
    }
  },
  plan(ctx) {
    const { pdh, pdl } = ctx.ref;
    if (pdh == null) return off("No previous session.");
    const atr = atrOf(ctx);
    if (atr == null) return waiting("Warming up (ATR).");
    return watch(
      [
        { side: "short", trigger: pdh, when: `${tf(ctx)} sweeps above PDH then closes back below it (RVOL ≥ ${ctx.params.rvolMult}×)`, stop: roundTick(pdh + ctx.params.bufferAtr * atr, tickFor(pdh), "up"), cross: true, approx: true },
        { side: "long", trigger: pdl, when: `${tf(ctx)} sweeps below PDL then closes back above it (RVOL ≥ ${ctx.params.rvolMult}×)`, stop: roundTick(pdl - ctx.params.bufferAtr * atr, tickFor(pdl), "down"), cross: true, approx: true },
      ],
      `Fade a failed breakout back toward VWAP / prev close ${px(ctx.ref.pdc)}.`
    );
  },
});

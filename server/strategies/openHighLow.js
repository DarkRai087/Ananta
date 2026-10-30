import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px, orEnd, dayRange, hasBars } from "./planKit.js";

export default defineStrategy({
  id: "openHighLow",
  name: "Open = Low / Open = High",
  description: "The 09:15 open is still the day's low (within a tolerance) when the opening range completes, and price is above the open and VWAP → long. Open = high → short. Enter at range completion, or wait for a close beyond the range.",
  params: { orMinutes: 15, tolPct: 0.1, trigger: "orClose", stopBufferPct: 0.05, entryStart: "09:30", entryEnd: "10:30" },
  spec: [
    { key: "orMinutes", label: "Range minutes", type: "select", options: [5, 15, 30] },
    { key: "tolPct", label: "Open = low/high tolerance %", type: "number", step: 0.01 },
    { key: "trigger", label: "Trigger", type: "select", options: ["orClose", "orBreak"] },
    { key: "stopBufferPct", label: "Stop buffer %", type: "number", step: 0.01 },
  ],
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const open = ctx.ref.open;
    const or = ctx.openingRange(p.orMinutes);
    if (open == null || !or || ctx.i < or.completeIndex) return null;
    if (p.trigger === "orClose" && ctx.i !== or.completeIndex) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);

    const tol = p.tolPct / 100;
    const buf = p.stopBufferPct / 100;
    const dayLow = ctx.lowest(ctx.i + 1, "low", 0);
    const dayHigh = ctx.highest(ctx.i + 1, "high", 0);
    const openIsLow = dayLow >= open * (1 - tol);
    const openIsHigh = dayHigh <= open * (1 + tol);
    if (openIsLow === openIsHigh) return null; // neither, or a flat open that is both
    const v = ctx.ind("vwap");

    if (openIsLow && c.close > open && c.close > v) {
      if (p.trigger === "orBreak" && !(c.close > or.high && prev && prev.close <= or.high)) return null;
      return { side: "long", stop: Math.min(dayLow, open) * (1 - buf), reason: "Open = low, holding above open and VWAP" };
    }
    if (openIsHigh && c.close < open && c.close < v) {
      if (p.trigger === "orBreak" && !(c.close < or.low && prev && prev.close >= or.low)) return null;
      return { side: "short", stop: Math.max(dayHigh, open) * (1 + buf), reason: "Open = high, holding below open and VWAP" };
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const end = orEnd(ctx, p.orMinutes);
    const open = ctx.ref.open;
    if (open == null || !hasBars(ctx)) {
      return waiting(`At ${end}: BUY if the 09:15 open is still the day's low and price is above the open and VWAP; SELL if the open is the day's high and price is below both.`);
    }
    const tol = p.tolPct / 100;
    const buf = p.stopBufferPct / 100;
    const d = dayRange(ctx);
    const openIsLow = d.low >= open * (1 - tol);
    const openIsHigh = d.high <= open * (1 + tol);
    const or = ctx.openingRange(p.orMinutes);
    if (or && p.trigger === "orClose") return off(`Only checked at ${end} — the setup didn't fire today.`);
    if (openIsLow === openIsHigh) return off(`Open ${px(open)} is ${openIsLow ? "both the high and the low (flat)" : "neither the day's high nor its low"} — no setup.`);
    const v = ctx.ind("vwap");
    const when = or ? `${tf(ctx)} close beyond the OR` : `at the ${end} close`;
    if (openIsLow) {
      const trigger = or ? or.high : Math.max(open, v ?? open);
      return (or ? watch : waiting)(
        [{ side: "long", trigger, when: `${when}, above open and VWAP (open must stay the low)`, stop: Math.min(d.low, open) * (1 - buf), cross: Boolean(or) }],
        `Open = low so far (${px(open)})`
      );
    }
    const trigger = or ? or.low : Math.min(open, v ?? open);
    return (or ? watch : waiting)(
      [{ side: "short", trigger, when: `${when}, below open and VWAP (open must stay the high)`, stop: Math.max(d.high, open) * (1 + buf), cross: Boolean(or) }],
      `Open = high so far (${px(open)})`
    );
  },
});

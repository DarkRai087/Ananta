import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px, orEnd } from "./planKit.js";

export default defineStrategy({
  id: "narrowCpr",
  name: "Narrow CPR Trend Day",
  description: "Only on days with a narrow CPR, which often come before a trending day. After the opening range, a close above both the CPR top and the OR high, with price above VWAP → long (short: mirror). Stop at the tighter of the CPR bottom and the OR low.",
  params: { maxWidthPct: 0.25, orMinutes: 15, entryStart: "09:30", entryEnd: "13:00" },
  spec: [
    { key: "maxWidthPct", label: "Max CPR width %", type: "number", step: 0.01 },
    { key: "orMinutes", label: "Range minutes", type: "select", options: [5, 15, 30] },
  ],
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const pv = ctx.pivots;
    if (!pv || pv.cprWidthPct > p.maxWidthPct) return null;
    const or = ctx.openingRange(p.orMinutes);
    if (!or || ctx.i <= or.completeIndex) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);
    const v = ctx.ind("vwap");
    const up = Math.max(pv.tc, or.high);
    const dn = Math.min(pv.bc, or.low);
    const w = pv.cprWidthPct.toFixed(2);
    if (c.close > up && prev.close <= up && c.close > v) {
      return { side: "long", stop: Math.max(pv.bc, or.low), reason: `Narrow CPR (${w}%), broke above CPR and OR` };
    }
    if (c.close < dn && prev.close >= dn && c.close < v) {
      return { side: "short", stop: Math.min(pv.tc, or.high), reason: `Narrow CPR (${w}%), broke below CPR and OR` };
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const pv = ctx.pivots;
    if (!pv) return off("No previous session.");
    const w = pv.cprWidthPct.toFixed(2);
    if (pv.cprWidthPct > p.maxWidthPct) return off(`CPR width ${w}% is above ${p.maxWidthPct}% — not a narrow-CPR day.`);
    const or = ctx.openingRange(p.orMinutes);
    if (!or) return waiting(`Narrow CPR (${w}%, ${px(pv.bc)}–${px(pv.tc)}). Opening range forms until ${orEnd(ctx, p.orMinutes)}.`);
    return watch(
      [
        { side: "long", trigger: Math.max(pv.tc, or.high), when: `${tf(ctx)} close above CPR top and OR high, above VWAP`, stop: Math.max(pv.bc, or.low), cross: true },
        { side: "short", trigger: Math.min(pv.bc, or.low), when: `${tf(ctx)} close below CPR bottom and OR low, below VWAP`, stop: Math.min(pv.tc, or.high), cross: true },
      ],
      `Narrow CPR (${w}%) — trend day likely`
    );
  },
});

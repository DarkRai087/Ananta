import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px, orEnd, hasBars } from "./planKit.js";

export default defineStrategy({
  id: "gapAndGo",
  levels: ["orHigh", "orLow", "pdc"],
  name: "Gap and Go",
  description: "Gap up ≥ threshold, then a close above the opening range high → long (gap down: mirror). Stop at the other side of the range.",
  // shortcut: contexts fit to the 2026-07→10 NIFTY50 OOS audit (only gap-up/inside paid); re-audit after more backfill.
  contexts: ["gap:up|or:normal|pos:inside", "gap:up|or:wide|pos:inside"],
  params: { gapPct: 0.5, maxGapPct: 4, orMinutes: 15, entryStart: "09:30", entryEnd: "11:00" },
  spec: [
    { key: "gapPct", label: "Min gap %", type: "number", step: 0.1 },
    { key: "maxGapPct", label: "Max gap %", type: "number", step: 0.1 },
    { key: "orMinutes", label: "Range minutes", type: "select", options: [5, 15, 30] },
  ],
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const g = ctx.ref.gapPct;
    if (g == null) return null;
    const or = ctx.openingRange(p.orMinutes);
    if (!or || ctx.i <= or.completeIndex) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);
    if (g >= p.gapPct && g <= p.maxGapPct && c.close > or.high && prev.close <= or.high) {
      return { side: "long", stop: or.low, reason: `Gap up ${g.toFixed(2)}%, broke OR high` };
    }
    if (g <= -p.gapPct && g >= -p.maxGapPct && c.close < or.low && prev.close >= or.low) {
      return { side: "short", stop: or.high, reason: `Gap down ${g.toFixed(2)}%, broke OR low` };
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const { gapPct: g, pdc } = ctx.ref;
    if (pdc == null) return off("No previous session.");
    // The 09:15 open isn't known until the first bar has closed.
    if (g == null || !hasBars(ctx)) {
      return waiting(`Needs a gap at 09:15: open ≥ ${px(pdc * (1 + p.gapPct / 100))} (gap up → buy the OR breakout) or ≤ ${px(pdc * (1 - p.gapPct / 100))} (gap down → sell the OR breakdown).`);
    }
    const gs = `${g >= 0 ? "+" : ""}${g.toFixed(2)}%`;
    if (Math.abs(g) < p.gapPct || Math.abs(g) > p.maxGapPct) return off(`Gap today ${gs} — needs ${p.gapPct}% to ${p.maxGapPct}% either way.`);
    const or = ctx.openingRange(p.orMinutes);
    if (!or) return waiting(`Gap ${gs}. Opening range forms until ${orEnd(ctx, p.orMinutes)}.`);
    const s =
      g > 0
        ? { side: "long", trigger: or.high, when: `${tf(ctx)} close above OR high`, stop: or.low, cross: true }
        : { side: "short", trigger: or.low, when: `${tf(ctx)} close below OR low`, stop: or.high, cross: true };
    return watch([s], `Gap ${gs}, trading with the gap`);
  },
});

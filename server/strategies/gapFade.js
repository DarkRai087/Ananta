import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px, orEnd, hasBars } from "./planKit.js";

export default defineStrategy({
  id: "gapFade",
  levels: ["orHigh", "orLow", "pdc"],
  name: "Gap Fill / Fade",
  description: "Gap up that fails: close below the opening range low → short, targeting the previous close (gap down: mirror). With Target = 0 the target is the gap fill.",
  // shortcut: context fit to the 2026-07→10 NIFTY50 OOS audit (thin, near-zero edge); re-audit after more backfill.
  contexts: ["gap:up|or:wide|pos:abovePDH"],
  params: { gapPct: 0.5, maxGapPct: 2.5, orMinutes: 15, entryStart: "09:30", entryEnd: "12:00", targetR: 0 },
  spec: [
    { key: "gapPct", label: "Min gap %", type: "number", step: 0.1 },
    { key: "maxGapPct", label: "Max gap %", type: "number", step: 0.1 },
    { key: "orMinutes", label: "Range minutes", type: "select", options: [5, 15, 30] },
  ],
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const { gapPct: g, pdc } = ctx.ref;
    if (g == null) return null;
    const or = ctx.openingRange(p.orMinutes);
    if (!or || ctx.i <= or.completeIndex) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);
    if (g >= p.gapPct && g <= p.maxGapPct && c.close < or.low && prev.close >= or.low && pdc < c.close) {
      return { side: "short", stop: or.high, target: pdc, reason: `Gap up ${g.toFixed(2)}% failed, fading to previous close` };
    }
    if (g <= -p.gapPct && g >= -p.maxGapPct && c.close > or.high && prev.close <= or.high && pdc > c.close) {
      return { side: "long", stop: or.low, target: pdc, reason: `Gap down ${g.toFixed(2)}% failed, filling to previous close` };
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const { gapPct: g, pdc } = ctx.ref;
    if (pdc == null) return off("No previous session.");
    // The 09:15 open isn't known until the first bar has closed.
    if (g == null || !hasBars(ctx)) {
      return waiting(`Needs a gap at 09:15: open ≥ ${px(pdc * (1 + p.gapPct / 100))} (fade it short) or ≤ ${px(pdc * (1 - p.gapPct / 100))} (fade it long), target the previous close ${px(pdc)}.`);
    }
    const gs = `${g >= 0 ? "+" : ""}${g.toFixed(2)}%`;
    if (Math.abs(g) < p.gapPct || Math.abs(g) > p.maxGapPct) return off(`Gap today ${gs} — needs ${p.gapPct}% to ${p.maxGapPct}% either way.`);
    const or = ctx.openingRange(p.orMinutes);
    if (!or) return waiting(`Gap ${gs}. Opening range forms until ${orEnd(ctx, p.orMinutes)}.`);
    if (g > 0 && pdc >= or.low) return off(`Gap ${gs} already filled (previous close ${px(pdc)} is inside the range).`);
    if (g < 0 && pdc <= or.high) return off(`Gap ${gs} already filled (previous close ${px(pdc)} is inside the range).`);
    const s =
      g > 0
        ? { side: "short", trigger: or.low, when: `${tf(ctx)} close below OR low (gap failing)`, stop: or.high, target: pdc, cross: true }
        : { side: "long", trigger: or.high, when: `${tf(ctx)} close above OR high (gap failing)`, stop: or.low, target: pdc, cross: true };
    return watch([s], `Gap ${gs}, fading it back to ${px(pdc)}`);
  },
});

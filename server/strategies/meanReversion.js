import { defineStrategy } from "./common.js";
import { watch, armed, waiting, off, tf, px, barAtr } from "./planKit.js";

export default defineStrategy({
  id: "meanReversion",
  name: "RSI / Bollinger Mean Reversion",
  description: "Midday only by default. Price closes back inside the lower band after RSI was oversold → long to the middle band (short: mirror at the upper band).",
  params: {
    rsiPeriod: 14, rsiLow: 30, rsiHigh: 70, bbPeriod: 20, bbMult: 2, swingBars: 3,
    entryStart: "11:30", entryEnd: "13:30", targetR: 0,
  },
  spec: [
    { key: "rsiPeriod", label: "RSI period", type: "number", step: 1 },
    { key: "rsiLow", label: "RSI oversold", type: "number", step: 1 },
    { key: "rsiHigh", label: "RSI overbought", type: "number", step: 1 },
    { key: "bbPeriod", label: "Bollinger period", type: "number", step: 1 },
    { key: "bbMult", label: "Bollinger σ", type: "number", step: 0.1 },
    { key: "swingBars", label: "Swing stop lookback (bars)", type: "number", step: 1 },
  ],
  warmup: (p) => Math.max(p.bbPeriod, p.rsiPeriod + 1),
  onBar(ctx) {
    const p = ctx.params;
    if (ctx.i < Math.max(p.bbPeriod, p.rsiPeriod + 1)) return null;
    const bb = ctx.ind("bb", [p.bbPeriod, p.bbMult]);
    const bbp = ctx.ind("bb", [p.bbPeriod, p.bbMult], 1);
    const r = ctx.ind("rsi", [p.rsiPeriod]);
    const rp = ctx.ind("rsi", [p.rsiPeriod], 1);
    if (bb.lower == null || bbp.lower == null || r == null || rp == null) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);
    if (prev.close < bbp.lower && c.close > bb.lower && Math.min(r, rp) < p.rsiLow && bb.mid > c.close) {
      return { side: "long", stop: ctx.lowest(p.swingBars, "low", 0), target: bb.mid, reason: "Back inside lower band, RSI oversold" };
    }
    if (prev.close > bbp.upper && c.close < bb.upper && Math.max(r, rp) > p.rsiHigh && bb.mid < c.close) {
      return { side: "short", stop: ctx.highest(p.swingBars, "high", 0), target: bb.mid, reason: "Back inside upper band, RSI overbought" };
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    if (ctx.i + 1 < Math.max(p.bbPeriod, p.rsiPeriod + 1)) return waiting(`Bollinger ${p.bbPeriod} / RSI ${p.rsiPeriod} need ${Math.max(p.bbPeriod, p.rsiPeriod + 1)} bars (restart each session).`);
    const bb = ctx.ind("bb", [p.bbPeriod, p.bbMult]);
    const r = ctx.ind("rsi", [p.rsiPeriod]);
    if (bb.lower == null || r == null) return waiting("Indicators not ready yet.");
    const c = ctx.bar();
    const bands = `BB ${px(bb.lower)} / ${px(bb.mid)} / ${px(bb.upper)} · RSI ${r.toFixed(0)}`;
    const a = barAtr(ctx, c.close);
    if (c.close < bb.lower) {
      if (r >= p.rsiLow) return off(`Closed below the lower band but RSI ${r.toFixed(0)} isn't oversold (< ${p.rsiLow}). ${bands}`);
      return armed(
        [{ side: "long", trigger: bb.lower, when: `${tf(ctx)} close back above the lower band`, stop: ctx.lowest(Math.max(1, p.swingBars - 1), "low", 0), target: bb.mid, approx: true }],
        `Below the lower band with RSI oversold. ${bands}`
      );
    }
    if (c.close > bb.upper) {
      if (r <= p.rsiHigh) return off(`Closed above the upper band but RSI ${r.toFixed(0)} isn't overbought (> ${p.rsiHigh}). ${bands}`);
      return armed(
        [{ side: "short", trigger: bb.upper, when: `${tf(ctx)} close back below the upper band`, stop: ctx.highest(Math.max(1, p.swingBars - 1), "high", 0), target: bb.mid, approx: true }],
        `Above the upper band with RSI overbought. ${bands}`
      );
    }
    return watch(
      [
        { side: "long", trigger: bb.lower, when: `close below the lower band with RSI < ${p.rsiLow}, then a close back above it`, stop: bb.lower - a, target: bb.mid, approx: true },
        { side: "short", trigger: bb.upper, when: `close above the upper band with RSI > ${p.rsiHigh}, then a close back below it`, stop: bb.upper + a, target: bb.mid, approx: true },
      ],
      `Two steps: stretch outside the band, then snap back. ${bands}`
    );
  },
});

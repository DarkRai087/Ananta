import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf } from "./planKit.js";

export default defineStrategy({
  id: "bbSqueeze",
  levels: ["bbUpper", "bbMid", "bbLower"],
  name: "Bollinger Squeeze Breakout",
  description: "Bollinger Bands sit inside the Keltner Channel for several bars (a volatility squeeze), then a close above the upper band → long (below the lower band → short). Stop at the middle band.",
  params: { bbPeriod: 20, bbMult: 2, kcMult: 1.5, minSqueezeBars: 6, entryStart: "10:00", entryEnd: "14:30" },
  spec: [
    { key: "bbPeriod", label: "Period (BB and Keltner)", type: "number", step: 1 },
    { key: "bbMult", label: "Bollinger σ", type: "number", step: 0.1 },
    { key: "kcMult", label: "Keltner ATR multiple", type: "number", step: 0.1 },
    { key: "minSqueezeBars", label: "Min squeeze bars", type: "number", step: 1 },
  ],
  warmup: (p) => p.bbPeriod + p.minSqueezeBars,
  onBar(ctx) {
    const p = ctx.params;
    if (ctx.i < p.bbPeriod + p.minSqueezeBars) return null;
    for (let k = 1; k <= p.minSqueezeBars; k++) {
      const bb = ctx.ind("bb", [p.bbPeriod, p.bbMult], k);
      const kc = ctx.ind("keltner", [p.bbPeriod, p.kcMult], k);
      if (bb.upper == null || kc.upper == null || !(bb.upper < kc.upper && bb.lower > kc.lower)) return null;
    }
    const bb = ctx.ind("bb", [p.bbPeriod, p.bbMult]);
    const c = ctx.bar();
    if (c.close > bb.upper && c.close > c.open) return { side: "long", stop: bb.mid, reason: `Squeeze (${p.minSqueezeBars}+ bars) broke up` };
    if (c.close < bb.lower && c.close < c.open) return { side: "short", stop: bb.mid, reason: `Squeeze (${p.minSqueezeBars}+ bars) broke down` };
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const need = p.bbPeriod + p.minSqueezeBars;
    if (ctx.i + 1 < need) return waiting(`Needs ${need} bars (Bollinger ${p.bbPeriod} + ${p.minSqueezeBars} squeeze bars).`);
    // Squeeze bars in a row, ending at the current bar.
    let run = 0;
    for (let k = 0; k <= ctx.i; k++) {
      const bb = ctx.ind("bb", [p.bbPeriod, p.bbMult], k);
      const kc = ctx.ind("keltner", [p.bbPeriod, p.kcMult], k);
      if (bb.upper == null || kc.upper == null || !(bb.upper < kc.upper && bb.lower > kc.lower)) break;
      run++;
    }
    const bb = ctx.ind("bb", [p.bbPeriod, p.bbMult]);
    if (run < p.minSqueezeBars) return off(`No squeeze: ${run} of ${p.minSqueezeBars} bars with Bollinger inside Keltner.`);
    return watch(
      [
        { side: "long", trigger: bb.upper, when: `green ${tf(ctx)} close above the upper band`, stop: bb.mid, approx: true },
        { side: "short", trigger: bb.lower, when: `red ${tf(ctx)} close below the lower band`, stop: bb.mid, approx: true },
      ],
      `Squeezed for ${run} bars — breakout either way. Bands move each bar.`
    );
  },
});

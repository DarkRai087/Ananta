import { defineStrategy } from "./common.js";
import { watch, waiting, tf, px } from "./planKit.js";

export default defineStrategy({
  id: "emaCross",
  levels: ["ema9", "ema21"],
  name: "9/21 EMA Crossover",
  description: "Fast EMA crosses the slow EMA (both restart each session). Stop at the recent swing; optional exit on the opposite cross. Best on 5m.",
  defaultInterval: "5m",
  params: { fast: 9, slow: 21, swingBars: 5, exitOnCross: true, entryEnd: "14:30" },
  spec: [
    { key: "fast", label: "Fast EMA", type: "number", step: 1 },
    { key: "slow", label: "Slow EMA", type: "number", step: 1 },
    { key: "swingBars", label: "Swing stop lookback (bars)", type: "number", step: 1 },
    { key: "exitOnCross", label: "Exit on opposite cross", type: "bool" },
  ],
  warmup: (p) => p.slow,
  onBar(ctx) {
    const p = ctx.params;
    if (ctx.i < p.slow) return null;
    const f = ctx.ind("ema", [p.fast]);
    const s = ctx.ind("ema", [p.slow]);
    const fp = ctx.ind("ema", [p.fast], 1);
    const sp = ctx.ind("ema", [p.slow], 1);
    if (f == null || s == null || fp == null || sp == null) return null;
    if (ctx.position) {
      const pos = ctx.position;
      if (p.exitOnCross && ((pos.side === "long" && f < s) || (pos.side === "short" && f > s))) {
        return { exit: true, reason: "Opposite EMA cross" };
      }
      return null;
    }
    if (fp <= sp && f > s) return { side: "long", stop: ctx.lowest(p.swingBars, "low", 0), reason: `EMA ${p.fast} crossed above ${p.slow}` };
    if (fp >= sp && f < s) return { side: "short", stop: ctx.highest(p.swingBars, "high", 0), reason: `EMA ${p.fast} crossed below ${p.slow}` };
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    if (ctx.i < p.slow - 1) return waiting(`EMA ${p.slow} needs ${p.slow} bars (restarts each session).`);
    const f = ctx.ind("ema", [p.fast]);
    const s = ctx.ind("ema", [p.slow]);
    if (f == null || s == null) return waiting("EMAs not ready yet.");
    // The next close x that makes the EMAs cross: f + af(x − f) = s + as(x − s).
    const af = 2 / (p.fast + 1);
    const as = 2 / (p.slow + 1);
    const x = (s * (1 - as) - f * (1 - af)) / (af - as);
    if (f > s) {
      return watch(
        [{ side: "short", trigger: x, when: `${tf(ctx)} close below this makes EMA ${p.fast} cross under EMA ${p.slow}`, stop: Math.max(ctx.highest(p.swingBars - 1, "high", 0) ?? x, x), approx: true }],
        `EMA ${p.fast} ${px(f)} above EMA ${p.slow} ${px(s)} (up) — next signal is a SELL`
      );
    }
    return watch(
      [{ side: "long", trigger: x, when: `${tf(ctx)} close above this makes EMA ${p.fast} cross over EMA ${p.slow}`, stop: Math.min(ctx.lowest(p.swingBars - 1, "low", 0) ?? x, x), approx: true }],
      `EMA ${p.fast} ${px(f)} below EMA ${p.slow} ${px(s)} (down) — next signal is a BUY`
    );
  },
});

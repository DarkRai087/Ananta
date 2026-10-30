import { defineStrategy } from "./common.js";
import { inr } from "../decision/util.js";
import { watch, waiting, off, tf, barAtr } from "./planKit.js";

export default defineStrategy({
  id: "volumeBreakout",
  levels: ["dayHigh", "dayLow"],
  name: "Volume Breakout",
  description: "A bar with volume ≥ 2× the previous 20-bar average that closes beyond the recent high/low. Stop at the breakout bar's other end. (Indices have no volume, so no trades there.)",
  params: { volMult: 2, volPeriod: 20, lookback: 10, entryStart: "09:30", entryEnd: "14:30" },
  spec: [
    { key: "volMult", label: "Volume multiple", type: "number", step: 0.1 },
    { key: "volPeriod", label: "Volume average (bars)", type: "number", step: 1 },
    { key: "lookback", label: "Breakout lookback (bars)", type: "number", step: 1 },
  ],
  warmup: (p) => Math.max(p.volPeriod, p.lookback) + 1,
  onBar(ctx) {
    const p = ctx.params;
    if (ctx.i < Math.max(p.volPeriod, p.lookback) + 1) return null;
    const avg = ctx.ind("volSma", [p.volPeriod], 1); // average of the previous bars, not including this one
    const c = ctx.bar();
    if (!avg || avg <= 0 || c.volume < p.volMult * avg) return null;
    const hh = ctx.highest(p.lookback, "high", 1);
    const ll = ctx.lowest(p.lookback, "low", 1);
    if (c.close > hh && c.close > c.open) return { side: "long", stop: c.low, reason: `Volume ${(c.volume / avg).toFixed(1)}× avg, new ${p.lookback}-bar high` };
    if (c.close < ll && c.close < c.open) return { side: "short", stop: c.high, reason: `Volume ${(c.volume / avg).toFixed(1)}× avg, new ${p.lookback}-bar low` };
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const last = ctx.ref.daily[ctx.ref.daily.length - 1];
    if (last && !(last.volume > 0)) return off("No volume data (indices have none) — this strategy can't trade it.");
    const need = Math.max(p.volPeriod, p.lookback) + 1;
    if (ctx.i + 1 < need) return waiting(`Needs ${need} bars for the volume average and breakout levels.`);
    const avg = ctx.ind("volSma", [p.volPeriod]);
    if (!avg) return off("No volume on recent bars.");
    const hh = ctx.highest(p.lookback, "high", 0);
    const ll = ctx.lowest(p.lookback, "low", 0);
    const a = barAtr(ctx, hh);
    const vol = inr(Math.round(p.volMult * avg));
    return watch(
      [
        { side: "long", trigger: hh, when: `green ${tf(ctx)} close above the ${p.lookback}-bar high with volume ≥ ${vol}`, stop: hh - a, approx: true },
        { side: "short", trigger: ll, when: `red ${tf(ctx)} close below the ${p.lookback}-bar low with volume ≥ ${vol}`, stop: ll + a, approx: true },
      ],
      `Needs a volume spike (${p.volMult}× the ${p.volPeriod}-bar average). Stop = the breakout candle's other end (estimated).`
    );
  },
});

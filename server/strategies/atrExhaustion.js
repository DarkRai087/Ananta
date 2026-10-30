import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px, dayRange } from "./planKit.js";

export default defineStrategy({
  id: "atrExhaustion",
  name: "ATR Exhaustion Fade",
  description: "Today's range has already used up its usual daily move (≥ 100% of the 14-day ATR). A fresh day high followed by a close below the previous bar's low → short back toward VWAP (mirror at the day low). Stop beyond the day's extreme.",
  params: { atrPct: 100, stopBufferPct: 0.05, entryStart: "11:30", entryEnd: "14:30", targetR: 0 },
  spec: [
    { key: "atrPct", label: "Range used, % of daily ATR", type: "number", step: 5 },
    { key: "stopBufferPct", label: "Stop buffer %", type: "number", step: 0.01 },
  ],
  warmup: () => 2,
  onBar(ctx) {
    const p = ctx.params;
    const a = ctx.ref.atrDaily;
    if (a == null || ctx.i < 2) return null;
    const i = ctx.i;
    const dayHigh = ctx.highest(i + 1, "high", 0);
    const dayLow = ctx.lowest(i + 1, "low", 0);
    const used = ((dayHigh - dayLow) / a) * 100;
    if (used < p.atrPct) return null;
    const c = ctx.bar();
    const prev = ctx.bar(i - 1);
    const v = ctx.ind("vwap");
    const buf = p.stopBufferPct / 100;
    const atHigh = Math.max(c.high, prev.high) >= dayHigh;
    const atLow = Math.min(c.low, prev.low) <= dayLow;
    if (atHigh && !atLow && c.close < prev.low && c.close < c.open && c.close > v) {
      return { side: "short", stop: dayHigh * (1 + buf), target: v, reason: `Range ${used.toFixed(0)}% of daily ATR, rejected the day high` };
    }
    if (atLow && !atHigh && c.close > prev.high && c.close > c.open && c.close < v) {
      return { side: "long", stop: dayLow * (1 - buf), target: v, reason: `Range ${used.toFixed(0)}% of daily ATR, rejected the day low` };
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const a = ctx.ref.atrDaily;
    if (a == null) return off("Needs 14 earlier sessions for the daily ATR.");
    if (ctx.i < 1) return waiting(`Activates once today's range reaches ${p.atrPct}% of the daily ATR (${px(a)}).`);
    const d = dayRange(ctx);
    const used = ((d.high - d.low) / a) * 100;
    const need = (a * p.atrPct) / 100;
    if (used < p.atrPct) {
      return waiting(`Range so far ${used.toFixed(0)}% of daily ATR — activates at ${p.atrPct}% (a high above ${px(d.low + need)} or a low below ${px(d.high - need)}).`);
    }
    const c = ctx.bar();
    const v = ctx.ind("vwap");
    const buf = p.stopBufferPct / 100;
    const setups = [];
    if (c.close > v) setups.push({ side: "short", trigger: c.low, when: `at a fresh day high, red ${tf(ctx)} close below the previous bar's low`, stop: d.high * (1 + buf), target: v, approx: true });
    if (c.close < v) setups.push({ side: "long", trigger: c.high, when: `at a fresh day low, green ${tf(ctx)} close above the previous bar's high`, stop: d.low * (1 - buf), target: v, approx: true });
    return watch(setups, `Range ${used.toFixed(0)}% of daily ATR — stretched. Fade back toward VWAP ${px(v)}.`);
  },
});

import { defineStrategy } from "./common.js";
import { hhmmToMin } from "../lab/time.js";
import { watch, waiting, off, px } from "./planKit.js";

export default defineStrategy({
  id: "afternoonMomentum",
  name: "Intraday Momentum (late session)",
  description: "If the move from the previous close to the check time (default 09:45) is at least the threshold, and price is still on that side of VWAP in the afternoon, ride it into the 15:15 square-off. Based on research that the first half-hour's return predicts the last half-hour's.",
  params: { checkTime: "09:45", minRetPct: 0.5, swingBars: 6, entryStart: "14:15", entryEnd: "14:45", stopType: "atr", atrMult: 2, targetR: 0 },
  spec: [
    { key: "checkTime", label: "Measure move until", type: "time" },
    { key: "minRetPct", label: "Min move %", type: "number", step: 0.1 },
    { key: "swingBars", label: "Structure stop lookback (bars)", type: "number", step: 1 },
  ],
  warmup: (p) => p.swingBars,
  onBar(ctx) {
    const p = ctx.params;
    const pdc = ctx.ref.pdc;
    if (pdc == null || ctx.position || ctx.tradesToday > 0 || ctx.i < p.swingBars) return null;
    const check = hhmmToMin(p.checkTime);
    // Close of the last bar that ended at or before the check time.
    let k = ctx.i;
    while (k >= 0 && ctx.minute(k) + ctx.intervalMin > check) k--;
    if (k < 0) return null;
    const ret = ((ctx.bar(k).close - pdc) / pdc) * 100;
    const c = ctx.bar();
    const v = ctx.ind("vwap");
    if (ret >= p.minRetPct && c.close > v && c.close > pdc) {
      return { side: "long", stop: ctx.lowest(p.swingBars, "low", 0), reason: `Up ${ret.toFixed(2)}% by ${p.checkTime}, still above VWAP` };
    }
    if (ret <= -p.minRetPct && c.close < v && c.close < pdc) {
      return { side: "short", stop: ctx.highest(p.swingBars, "high", 0), reason: `Down ${Math.abs(ret).toFixed(2)}% by ${p.checkTime}, still below VWAP` };
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const pdc = ctx.ref.pdc;
    if (pdc == null) return off("No previous session.");
    const check = hhmmToMin(p.checkTime);
    const up = pdc * (1 + p.minRetPct / 100);
    const dn = pdc * (1 - p.minRetPct / 100);
    let k = ctx.i;
    while (k >= 0 && ctx.minute(k) + ctx.intervalMin > check) k--;
    const measured = ctx.i >= 0 && ctx.minute(ctx.i) + ctx.intervalMin >= check && k >= 0;
    if (!measured) return waiting(`Measures the move at ${p.checkTime}: above ${px(up)} (+${p.minRetPct}%) → BUY from ${p.entryStart}; below ${px(dn)} → SELL.`);
    const ret = ((ctx.bar(k).close - pdc) / pdc) * 100;
    if (Math.abs(ret) < p.minRetPct) return off(`Move by ${p.checkTime} was ${ret >= 0 ? "+" : ""}${ret.toFixed(2)}% — needs ±${p.minRetPct}%.`);
    const v = ctx.ind("vwap");
    const s =
      ret > 0
        ? { side: "long", trigger: Math.max(v ?? pdc, pdc), when: `from ${p.entryStart}, price above VWAP and previous close → buy, hold to 15:15`, stop: ctx.lowest(p.swingBars, "low", 0), atMarket: true }
        : { side: "short", trigger: Math.min(v ?? pdc, pdc), when: `from ${p.entryStart}, price below VWAP and previous close → sell, hold to 15:15`, stop: ctx.highest(p.swingBars, "high", 0), atMarket: true };
    return watch([s], `${ret > 0 ? "Up" : "Down"} ${Math.abs(ret).toFixed(2)}% by ${p.checkTime} — rides the move into the close`);
  },
});

import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px } from "./planKit.js";

export default defineStrategy({
  id: "vwapPullback",
  name: "VWAP Pullback",
  description: "In a session trend (VWAP sloping, price holding one side), buy a dip that touches VWAP and closes back above it (short: mirror).",
  params: { slopeBars: 6, holdBars: 3, touchPct: 0.05, stopBufferPct: 0.05, entryStart: "09:45", entryEnd: "14:30" },
  spec: [
    { key: "slopeBars", label: "VWAP slope lookback (bars)", type: "number", step: 1 },
    { key: "holdBars", label: "Bars held on trend side", type: "number", step: 1 },
    { key: "touchPct", label: "Touch tolerance %", type: "number", step: 0.01 },
    { key: "stopBufferPct", label: "Stop buffer %", type: "number", step: 0.01 },
  ],
  warmup: (p) => Math.max(p.slopeBars, p.holdBars) + 1,
  onBar(ctx) {
    const p = ctx.params;
    const i = ctx.i;
    if (i < Math.max(p.slopeBars, p.holdBars + 1)) return null;
    const v = ctx.ind("vwap");
    const vThen = ctx.ind("vwap", [], p.slopeBars);
    const c = ctx.bar();
    let above = 0;
    let below = 0;
    for (let k = 1; k <= p.holdBars; k++) {
      const b = ctx.bar(i - k);
      const vk = ctx.ind("vwap", [], k);
      if (b.close > vk) above++;
      else if (b.close < vk) below++;
    }
    const tol = p.touchPct / 100;
    const buf = p.stopBufferPct / 100;
    if (v > vThen && above === p.holdBars && c.low <= v * (1 + tol) && c.close > v && c.close > c.open) {
      return { side: "long", stop: Math.min(c.low, v) * (1 - buf), reason: "Pullback to rising VWAP held" };
    }
    if (v < vThen && below === p.holdBars && c.high >= v * (1 - tol) && c.close < v && c.close < c.open) {
      return { side: "short", stop: Math.max(c.high, v) * (1 + buf), reason: "Pullback to falling VWAP rejected" };
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const i = ctx.i;
    const need = Math.max(p.slopeBars, p.holdBars + 1);
    if (i + 1 < need) return waiting(`Needs ${need} bars of VWAP history first.`);
    const v = ctx.ind("vwap");
    const vThen = ctx.ind("vwap", [], p.slopeBars - 1);
    let above = 0;
    let below = 0;
    for (let k = 0; k < p.holdBars; k++) {
      const b = ctx.bar(i - k);
      const vk = ctx.ind("vwap", [], k);
      if (b.close > vk) above++;
      else if (b.close < vk) below++;
    }
    const tol = p.touchPct / 100;
    const buf = p.stopBufferPct / 100;
    if (v > vThen && above === p.holdBars) {
      return watch(
        [{ side: "long", trigger: v, when: `dips to VWAP (≤ ${px(v * (1 + tol))}), green ${tf(ctx)} candle closes back above it`, stop: v * (1 - buf), approx: true }],
        `VWAP ${px(v)} rising, price holding above — buy the dip`
      );
    }
    if (v < vThen && below === p.holdBars) {
      return watch(
        [{ side: "short", trigger: v, when: `rises to VWAP (≥ ${px(v * (1 - tol))}), red ${tf(ctx)} candle closes back below it`, stop: v * (1 + buf), approx: true }],
        `VWAP ${px(v)} falling, price holding below — sell the rally`
      );
    }
    return off(`No VWAP trend right now (VWAP ${px(v)}): needs VWAP sloping and the last ${p.holdBars} closes on one side.`);
  },
});

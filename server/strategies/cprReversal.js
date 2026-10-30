import { defineStrategy } from "./common.js";
import { watch, off, tf, px, refPrice } from "./planKit.js";

export default defineStrategy({
  id: "cprReversal",
  levels: ["tc", "pivot", "bc", "r1", "s1"],
  name: "CPR / Pivot Reversal",
  description: "Price tags a support (S1, S2, or the CPR top when coming from above) and closes back above it with a bullish bar → long. Mirror at R1, R2, CPR bottom → short.",
  params: { tolerancePct: 0.1, stopBufferPct: 0.05, entryStart: "09:30", entryEnd: "14:30", targetR: 1.5 },
  spec: [
    { key: "tolerancePct", label: "Touch tolerance %", type: "number", step: 0.01 },
    { key: "stopBufferPct", label: "Stop buffer %", type: "number", step: 0.01 },
  ],
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const pv = ctx.pivots;
    if (!pv || ctx.i < 1) return null;
    const c = ctx.bar();
    const prevClose = ctx.bar(ctx.i - 1).close;
    const tol = p.tolerancePct / 100;
    const buf = p.stopBufferPct / 100;

    const supports = [["S1", pv.s1], ["S2", pv.s2]];
    if (prevClose > pv.tc) supports.push(["CPR top", pv.tc]);
    const resistances = [["R1", pv.r1], ["R2", pv.r2]];
    if (prevClose < pv.bc) resistances.push(["CPR bottom", pv.bc]);

    if (c.close > c.open) {
      for (const [name, L] of supports) {
        // Touched the level (within tolerance) without slicing far through it, and closed back above.
        if (c.low <= L * (1 + tol) && c.low >= L * (1 - 3 * tol) && c.close > L) {
          return { side: "long", stop: Math.min(c.low, L) * (1 - buf), reason: `Bounce off ${name}` };
        }
      }
    }
    if (c.close < c.open) {
      for (const [name, L] of resistances) {
        if (c.high >= L * (1 - tol) && c.high <= L * (1 + 3 * tol) && c.close < L) {
          return { side: "short", stop: Math.max(c.high, L) * (1 + buf), reason: `Rejection at ${name}` };
        }
      }
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const pv = ctx.pivots;
    if (!pv) return off("No previous session.");
    const buf = p.stopBufferPct / 100;
    const price = refPrice(ctx);
    const supports = [["S1", pv.s1], ["S2", pv.s2]];
    if (price > pv.tc) supports.push(["CPR top", pv.tc]);
    const resistances = [["R1", pv.r1], ["R2", pv.r2]];
    if (price < pv.bc) resistances.push(["CPR bottom", pv.bc]);
    // Nearest level on each side of the current price.
    const sup = supports.filter(([, L]) => L < price).sort((a, b) => b[1] - a[1])[0];
    const res = resistances.filter(([, L]) => L > price).sort((a, b) => a[1] - b[1])[0];
    const setups = [];
    if (sup) setups.push({ side: "long", trigger: sup[1], when: `dips to ${sup[0]}, green ${tf(ctx)} candle closes back above it`, stop: sup[1] * (1 - buf), approx: true });
    if (res) setups.push({ side: "short", trigger: res[1], when: `rises to ${res[0]}, red ${tf(ctx)} candle closes back below it`, stop: res[1] * (1 + buf), approx: true });
    if (!setups.length) return off("Price is beyond S2 / R2 — no level to trade against.");
    return watch(setups, `R2 ${px(pv.r2)} · R1 ${px(pv.r1)} · CPR ${px(pv.bc)}–${px(pv.tc)} · S1 ${px(pv.s1)} · S2 ${px(pv.s2)}`);
  },
});

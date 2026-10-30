import { defineStrategy } from "./common.js";
import { watch, off, tf, px, refPrice } from "./planKit.js";

export default defineStrategy({
  id: "camarilla",
  levels: ["h4", "h3", "l3", "l4"],
  name: "Camarilla Pivots",
  description: "Reversal: price tests L3 and closes back above it with a bullish bar → long, stop below L4 (short: mirror at H3/H4). Breakout: close above H4 → long, stop below H3 (short: close below L4).",
  params: { mode: "both", tolerancePct: 0.1, stopBufferPct: 0.05, entryStart: "09:30", entryEnd: "14:30", targetR: 1.5 },
  spec: [
    { key: "mode", label: "Setups", type: "select", options: ["both", "reversal", "breakout"] },
    { key: "tolerancePct", label: "Touch tolerance %", type: "number", step: 0.01 },
    { key: "stopBufferPct", label: "Stop buffer %", type: "number", step: 0.01 },
  ],
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const pv = ctx.pivots;
    if (!pv || ctx.i < 1) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);
    const tol = p.tolerancePct / 100;
    const buf = p.stopBufferPct / 100;

    if (p.mode !== "reversal") {
      if (c.close > pv.h4 && prev.close <= pv.h4) return { side: "long", stop: pv.h3 * (1 - buf), reason: "Close above Camarilla H4" };
      if (c.close < pv.l4 && prev.close >= pv.l4) return { side: "short", stop: pv.l3 * (1 + buf), reason: "Close below Camarilla L4" };
    }
    if (p.mode !== "breakout") {
      if (c.close > c.open && c.low <= pv.l3 * (1 + tol) && c.low > pv.l4 && c.close > pv.l3) {
        return { side: "long", stop: pv.l4 * (1 - buf), reason: "Rejected Camarilla L3" };
      }
      if (c.close < c.open && c.high >= pv.h3 * (1 - tol) && c.high < pv.h4 && c.close < pv.h3) {
        return { side: "short", stop: pv.h4 * (1 + buf), reason: "Rejected Camarilla H3" };
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
    const setups = [];
    if (p.mode !== "reversal") {
      setups.push({ side: "long", trigger: pv.h4, when: `${tf(ctx)} close above H4 (breakout)`, stop: pv.h3 * (1 - buf), cross: true });
      setups.push({ side: "short", trigger: pv.l4, when: `${tf(ctx)} close below L4 (breakdown)`, stop: pv.l3 * (1 + buf), cross: true });
    }
    if (p.mode !== "breakout") {
      // Reversals need price to come to the level from the right side.
      if (price == null || price > pv.l3) setups.push({ side: "long", trigger: pv.l3, when: `dips to L3 (not L4), green ${tf(ctx)} candle closes back above L3`, stop: pv.l4 * (1 - buf) });
      if (price == null || price < pv.h3) setups.push({ side: "short", trigger: pv.h3, when: `rises to H3 (not H4), red ${tf(ctx)} candle closes back below H3`, stop: pv.h4 * (1 + buf) });
    }
    return watch(setups, `H4 ${px(pv.h4)} · H3 ${px(pv.h3)} · L3 ${px(pv.l3)} · L4 ${px(pv.l4)}`);
  },
});

import { defineStrategy } from "./common.js";
import { watch, armed, waiting, off, tf, px, orEnd, lastBar, barAtr } from "./planKit.js";

export default defineStrategy({
  id: "orbFakeout",
  name: "ORB Failed Breakout",
  description: "Price closes below the opening range low, then within a few bars closes back inside → long, as trapped sellers cover (short: mirror at the OR high). Stop beyond the false break; target the other side of the range.",
  params: { orMinutes: 15, maxBars: 4, stopBufferPct: 0.05, entryStart: "09:30", entryEnd: "13:00", targetR: 0 },
  spec: [
    { key: "orMinutes", label: "Range minutes", type: "select", options: [5, 15, 30] },
    { key: "maxBars", label: "Max bars outside the range", type: "number", step: 1 },
    { key: "stopBufferPct", label: "Stop buffer %", type: "number", step: 0.01 },
  ],
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const or = ctx.openingRange(p.orMinutes);
    if (!or || ctx.i <= or.completeIndex + 1) return null;
    const i = ctx.i;
    const c = ctx.bar();
    const buf = p.stopBufferPct / 100;

    // How many bars right before this one closed outside the range (bars i-n .. i-1).
    const run = (outside) => {
      let k = i - 1;
      while (k > or.completeIndex && outside(ctx.bar(k))) k--;
      return i - 1 - k;
    };

    if (c.close > or.low && c.close <= or.high) {
      const n = run((b) => b.close < or.low);
      if (n > 0 && n <= p.maxBars) {
        const low = ctx.lowest(n + 1, "low", 0);
        return { side: "long", stop: low * (1 - buf), target: or.high, reason: `Failed break of OR low (${n} bar${n > 1 ? "s" : ""} outside)` };
      }
    }
    if (c.close < or.high && c.close >= or.low) {
      const n = run((b) => b.close > or.high);
      if (n > 0 && n <= p.maxBars) {
        const high = ctx.highest(n + 1, "high", 0);
        return { side: "short", stop: high * (1 + buf), target: or.low, reason: `Failed break of OR high (${n} bar${n > 1 ? "s" : ""} outside)` };
      }
    }
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const or = ctx.openingRange(p.orMinutes);
    if (!or) return waiting(`Opening range forms until ${orEnd(ctx, p.orMinutes)}. Then watch for a false break of either side.`);
    const c = lastBar(ctx);
    const buf = p.stopBufferPct / 100;
    const a = barAtr(ctx, c?.close);
    // Closes outside the range in a row, ending at the current bar.
    const runOutside = (outside) => {
      let k = ctx.i;
      while (k > or.completeIndex && outside(ctx.bar(k))) k--;
      return ctx.i - k;
    };
    const nBelow = runOutside((b) => b.close < or.low);
    const nAbove = runOutside((b) => b.close > or.high);
    const range = `Opening range ${px(or.low)}–${px(or.high)}`;
    if (nBelow > 0) {
      if (nBelow > p.maxBars) return off(`Below the OR low for ${nBelow} bars — a real breakdown, not a fake (max ${p.maxBars}).`);
      const low = ctx.lowest(nBelow, "low", 0);
      return armed(
        [{ side: "long", trigger: or.low, when: `${tf(ctx)} close back above OR low (within ${(p.maxBars - nBelow + 1)} more bar${(p.maxBars - nBelow + 1) > 1 ? "s" : ""})`, stop: low * (1 - buf), target: or.high, approx: true }],
        `${range}. Broke below ${nBelow} bar${nBelow > 1 ? "s" : ""} ago — a close back inside is a failed breakdown.`
      );
    }
    if (nAbove > 0) {
      if (nAbove > p.maxBars) return off(`Above the OR high for ${nAbove} bars — a real breakout, not a fake (max ${p.maxBars}).`);
      const high = ctx.highest(nAbove, "high", 0);
      return armed(
        [{ side: "short", trigger: or.high, when: `${tf(ctx)} close back below OR high (within ${(p.maxBars - nAbove + 1)} more bar${(p.maxBars - nAbove + 1) > 1 ? "s" : ""})`, stop: high * (1 + buf), target: or.low, approx: true }],
        `${range}. Broke above ${nAbove} bar${nAbove > 1 ? "s" : ""} ago — a close back inside is a failed breakout.`
      );
    }
    return watch(
      [
        { side: "long", trigger: or.low, when: `close below OR low, then back above it within ${p.maxBars} bars`, stop: (or.low - a) * (1 - buf), target: or.high, approx: true },
        { side: "short", trigger: or.high, when: `close above OR high, then back below it within ${p.maxBars} bars`, stop: (or.high + a) * (1 + buf), target: or.low, approx: true },
      ],
      `${range}. Two steps: a break, then a quick close back inside.`
    );
  },
});

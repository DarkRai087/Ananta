import { defineStrategy } from "./common.js";
import { watch, waiting, off, tf, px, orEnd } from "./planKit.js";

const range = (d) => d.high - d.low;

// Did yesterday (the last daily bar) set up a quiet day? Returns its name or null.
function quietDay(daily, setup) {
  const y = daily[daily.length - 1];
  if (!y) return null;
  const nr = (n) => daily.length >= n && daily.slice(-n).every((d) => range(y) <= range(d));
  const inside = () => daily.length >= 2 && y.high <= daily[daily.length - 2].high && y.low >= daily[daily.length - 2].low;
  if ((setup === "nr7" || setup === "any") && nr(7)) return "NR7";
  if ((setup === "nr4" || setup === "any") && nr(4)) return "NR4";
  if ((setup === "insideDay" || setup === "any") && inside()) return "inside day";
  return null;
}

export default defineStrategy({
  id: "nr7Orb",
  levels: ["orHigh", "orLow"],
  name: "NR7 / Inside-Day ORB",
  description: "Only after a quiet day: yesterday had the narrowest range of the last 7 (NR7) or 4 (NR4) days, or was an inside day. Then trade the opening range breakout, expecting the range to expand. Stop at the other side of the range.",
  params: { setup: "nr7", orMinutes: 15, bufferPct: 0.05, entryStart: "09:30", entryEnd: "12:00" },
  spec: [
    { key: "setup", label: "Yesterday was", type: "select", options: ["nr7", "nr4", "insideDay", "any"] },
    { key: "orMinutes", label: "Range minutes", type: "select", options: [5, 15, 30] },
    { key: "bufferPct", label: "Breakout buffer %", type: "number", step: 0.01 },
  ],
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const why = quietDay(ctx.ref.daily, p.setup);
    if (!why) return null;
    const or = ctx.openingRange(p.orMinutes);
    if (!or || ctx.i <= or.completeIndex) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);
    const up = or.high * (1 + p.bufferPct / 100);
    const dn = or.low * (1 - p.bufferPct / 100);
    if (c.close > up && prev.close <= up) return { side: "long", stop: or.low, reason: `After ${why}: close above OR high` };
    if (c.close < dn && prev.close >= dn) return { side: "short", stop: or.high, reason: `After ${why}: close below OR low` };
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const why = quietDay(ctx.ref.daily, p.setup);
    if (!why) return off(`Yesterday wasn't a quiet day (${p.setup === "any" ? "NR7 / NR4 / inside day" : p.setup}) — no trade today.`);
    const or = ctx.openingRange(p.orMinutes);
    if (!or) return waiting(`After ${why}: opening range forms until ${orEnd(ctx, p.orMinutes)}, then trade its breakout.`);
    return watch(
      [
        { side: "long", trigger: or.high * (1 + p.bufferPct / 100), when: `${tf(ctx)} close above OR high`, stop: or.low, cross: true },
        { side: "short", trigger: or.low * (1 - p.bufferPct / 100), when: `${tf(ctx)} close below OR low`, stop: or.high, cross: true },
      ],
      `After ${why}. Opening range ${px(or.low)}–${px(or.high)}`
    );
  },
});

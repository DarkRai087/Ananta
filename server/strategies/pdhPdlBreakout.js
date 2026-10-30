import { defineStrategy } from "./common.js";
import { watch, off, tf, px, barAtr } from "./planKit.js";

export default defineStrategy({
  id: "pdhPdl",
  levels: ["pdh", "pdl"],
  name: "Previous Day High/Low Breakout",
  description: "First intraday close above the previous day's high (long) or below its low (short). Stop at the breakout bar's other end.",
  params: { bufferPct: 0.05, entryStart: "09:20", entryEnd: "14:30" },
  spec: [{ key: "bufferPct", label: "Breakout buffer %", type: "number", step: 0.01 }],
  warmup: () => 1,
  onBar(ctx) {
    const p = ctx.params;
    const { pdh, pdl } = ctx.ref;
    if (pdh == null || ctx.i < 1) return null;
    const c = ctx.bar();
    const prev = ctx.bar(ctx.i - 1);
    const up = pdh * (1 + p.bufferPct / 100);
    const dn = pdl * (1 - p.bufferPct / 100);
    if (c.close > up && prev.close <= up) return { side: "long", stop: c.low, reason: "Close above previous day high" };
    if (c.close < dn && prev.close >= dn) return { side: "short", stop: c.high, reason: "Close below previous day low" };
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    const { pdh, pdl } = ctx.ref;
    if (pdh == null) return off("No previous session.");
    const up = pdh * (1 + p.bufferPct / 100);
    const dn = pdl * (1 - p.bufferPct / 100);
    const a = barAtr(ctx, up);
    // The stop is the breakout candle's other end — estimated as one typical bar away.
    return watch(
      [
        { side: "long", trigger: up, when: `${tf(ctx)} close above previous day high`, stop: up - a, cross: true, approx: true },
        { side: "short", trigger: dn, when: `${tf(ctx)} close below previous day low`, stop: dn + a, cross: true, approx: true },
      ],
      `PDH ${px(pdh)} · PDL ${px(pdl)}. Stop = the breakout candle's other end (estimated).`
    );
  },
});

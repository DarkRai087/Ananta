import { defineStrategy } from "./common.js";
import { watch, waiting, tf, px } from "./planKit.js";

export default defineStrategy({
  id: "supertrend",
  levels: ["supertrend"],
  name: "Supertrend Trend",
  description: "Enter when Supertrend (10,3, restarted each session) flips; stop at the Supertrend line; exit on the next flip or at 15:15.",
  // shortcut: context fit to the 2026-07→10 NIFTY50 OOS audit (only gap-up/wide/inside paid); re-audit after more backfill.
  contexts: ["gap:up|or:wide|pos:inside"],
  params: { period: 10, mult: 3, exitOnFlip: true, entryEnd: "14:30", targetR: 0 },
  spec: [
    { key: "period", label: "ATR period", type: "number", step: 1 },
    { key: "mult", label: "Multiplier", type: "number", step: 0.1 },
    { key: "exitOnFlip", label: "Exit on flip", type: "bool" },
  ],
  warmup: (p) => p.period + 1,
  onBar(ctx) {
    const p = ctx.params;
    if (ctx.i < 1) return null;
    const st = ctx.ind("supertrend", [p.period, p.mult]);
    const prev = ctx.ind("supertrend", [p.period, p.mult], 1);
    if (st.dir == null || prev.dir == null) return null;
    if (ctx.position) {
      const want = ctx.position.side === "long" ? 1 : -1;
      if (p.exitOnFlip && st.dir !== want) return { exit: true, reason: "Supertrend flipped" };
      return null;
    }
    if (prev.dir === -1 && st.dir === 1) return { side: "long", stop: st.value, reason: "Supertrend flipped up" };
    if (prev.dir === 1 && st.dir === -1) return { side: "short", stop: st.value, reason: "Supertrend flipped down" };
    return null;
  },
  plan(ctx) {
    const p = ctx.params;
    if (ctx.i < 1) return waiting(`Supertrend needs ${p.period + 1} bars (restarts each session).`);
    const st = ctx.ind("supertrend", [p.period, p.mult]);
    if (st.dir == null) return waiting(`Supertrend needs ${p.period + 1} bars (restarts each session).`);
    const a = ctx.ind("atr", [p.period]) ?? 0;
    // A close through the line flips it; the new line (the stop) sits about mult × ATR on the other side.
    if (st.dir === 1) {
      return watch(
        [{ side: "short", trigger: st.value, when: `${tf(ctx)} close below the Supertrend line flips it down`, stop: st.value + p.mult * a, approx: true }],
        `Supertrend up, line ${px(st.value)} — next signal is a SELL`
      );
    }
    return watch(
      [{ side: "long", trigger: st.value, when: `${tf(ctx)} close above the Supertrend line flips it up`, stop: st.value - p.mult * a, approx: true }],
      `Supertrend down, line ${px(st.value)} — next signal is a BUY`
    );
  },
});

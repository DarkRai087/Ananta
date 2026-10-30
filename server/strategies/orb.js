// Opening Range Breakout, decided by the multi-factor engine in server/orbEngine/.
//
// A cross of ORH / ORL never trades on its own. On every bar the engine finds the breakout on
// both sides (model A close + acceptance · B retest · C momentum), rejects failed and chased
// breakouts, scores eight factors out of 100, checks the mandatory conditions, and enters only
// when the decision is LONG or SHORT: triggered on this bar, score ≥ minScore (85 by default),
// every mandatory condition passing. A breakout that closes back inside the range is exited.
//
// Backtests have no live quote, India VIX or breadth, so those points are never earned there
// (missing data scores 0). Lower minScore in the Lab to study how the score relates to results.
import { defineStrategy } from "./common.js";
import { watch, armed, waiting, off, tf, px, orEnd } from "./planKit.js";
import { evaluate, triggersNow, configFor, ORB } from "../orbEngine/index.js";
import { buildOrbReport } from "../orbEngine/report.js";

export default defineStrategy({
  id: "orb",
  levels: ["orHigh", "orLow"],
  decision: { evaluate, configFor, build: buildOrbReport, vix: true, report: "orb" },
  name: "Opening Range Breakout",
  description:
    "Multi-factor ORB: a completed close beyond the opening range, then acceptance (A), a held retest (B) or a momentum candle (C). Trades only when range quality, market, relative volume, candle, confirmation, VWAP / momentum, relative strength and risk score ≥ 85/100 and every mandatory check passes; failed and chased breakouts are skipped.",
  params: { orMinutes: 15, minScore: ORB.executeAt, minNetRR: ORB.risk.minNetRR, bufferPct: ORB.setup.bufferPct, models: "all", target: "t2", exitOnFail: true, entryStart: "09:20", entryEnd: "12:00", targetR: 0 },
  spec: [
    { key: "orMinutes", label: "Range minutes", type: "select", options: [5, 15, 30, 60] },
    { key: "minScore", label: "Min setup score (of 100)", type: "number", step: 1 },
    { key: "minNetRR", label: "Min net reward/risk", type: "number", step: 0.1 },
    { key: "bufferPct", label: "Breakout buffer %", type: "number", step: 0.01 },
    { key: "models", label: "Entry models", type: "select", options: ["all", "close", "retest", "momentum"] },
    { key: "target", label: "Target", type: "select", options: ["t2", "t1"] },
    { key: "exitOnFail", label: "Exit if it closes back inside the range", type: "bool" },
  ],
  // Reads NIFTY 50 and the sector index (ctx.market): backtests and plans attach them.
  needsMarket: true,
  // The guard tests (lookahead, session leak) run strategies with these on top of the defaults,
  // so the entry path runs on random data, which can't reach 85 (no market data, quote or VIX)
  // and rarely offers 1.5:1. Every other mandatory condition stays on.
  testParams: { minScore: 0, minNetRR: 0 },
  warmup: () => 1,

  onBar(ctx) {
    const p = ctx.params;
    if (ctx.position) {
      if (!p.exitOnFail) return null;
      // A failed breakout invalidates the trade: exit on a close back inside the range.
      const or = ctx.openingRange(p.orMinutes);
      if (!or) return null;
      const c = ctx.bar();
      const tol = ORB.setup.holdTolAtr * (ctx.ind("atr", [14]) ?? 0);
      const back = ctx.position.side === "long" ? c.close < or.high - tol : c.close > or.low + tol;
      return back ? { exit: true, reason: "Closed back inside the opening range" } : null;
    }
    if (!triggersNow(ctx)) return null;
    const ev = evaluate(ctx);
    if (!ev.eligible) return null;
    const L = ev.levels;
    return {
      side: ev.side,
      stop: L.stop,
      target: L.primary,
      reason: `ORB model ${ev.setup.model} ${ev.score}/100 (${ev.classification.label}) · OR ${ev.details.range.classification}`,
    };
  },

  plan(ctx) {
    const p = ctx.params;
    if (ctx.i < 0) return waiting(`The ${p.orMinutes}-minute opening range forms 09:15–${orEnd(ctx, p.orMinutes)}. Then the engine watches for a confirmed close beyond it.`);
    const ev = evaluate(ctx);
    if (ev.state === "forming") return waiting(ev.why);
    const o = ev.or;
    const range = `OR ${px(o.low)}–${px(o.high)} (${o.widthPct.toFixed(2)}%, ${ev.details.range.classification.toLowerCase()})`;
    const head = `Score ${ev.score}/100 (${ev.classification.label}) → ${ev.decision}.`;
    if (ev.state === "inside") return watch([], `${range}. No breakout close yet. ${ev.why}`);
    if (!ev.showLevels) return off(`${head} ${ev.why} ${range}.`);
    const L = ev.levels;
    const setup = { side: ev.side, trigger: L.trigger, when: `${tf(ctx)}: ${L.triggerText}`, stop: L.stop, target: L.primary, approx: true };
    return ev.state === "broken" ? armed([setup], `${head} ${ev.why} ${range}.`) : watch([setup], `${head} ${range}.`);
  },
});

// VWAP σ-Band Mean Reversion, decided by the eight-factor engine in server/vwapReversion/.
//
// A band touch alone never trades. On every bar the engine finds the setup (a ±2σ test → a close
// back inside → a close beyond the rejection candle), scores the seven weighted factors out of
// 100, checks the mandatory conditions (strong trend, confirmation, liquidity, risk, session /
// news), and enters only when the decision is LONG or SHORT: triggered on this bar, score ≥
// minScore (85 by default), every mandatory condition passing.
//
// Backtests have no live order book or breadth, so those points are never earned there (missing
// data scores 0). Lower minScore in the Lab to study how the score relates to results.
import { defineStrategy } from "./common.js";
import { watch, armed, waiting, off, tf, px } from "./planKit.js";
import { evaluate, triggersNow, VWAP_REVERSION } from "../vwapReversion/index.js";

export default defineStrategy({
  id: "vwapBands",
  name: "VWAP σ-Band Reversion",
  description:
    "Eight-factor VWAP σ-band mean reversion: a ±2σ test, a close back inside, then a close beyond the rejection candle. Trades only when regime, deviation, price action, volume, market, liquidity and risk score ≥ 85/100 and every mandatory session, trend, liquidity and risk check passes. Target VWAP.",
  params: { minScore: VWAP_REVERSION.executeAt, minNetRR: VWAP_REVERSION.risk.minNetRR, band: 2, lookback: 8, maxBarsToConfirm: 6, stopAtrBuffer: 0.2, target: "vwap", exitAtVwap: true, entryStart: "10:00", entryEnd: "14:30", targetR: 0 },
  spec: [
    { key: "minScore", label: "Min setup score (of 100)", type: "number", step: 1 },
    { key: "minNetRR", label: "Min net reward/risk", type: "number", step: 0.1 },
    { key: "band", label: "Band σ", type: "number", step: 0.1 },
    { key: "lookback", label: "Band-test lookback (bars)", type: "number", step: 1 },
    { key: "maxBarsToConfirm", label: "Trigger within (bars)", type: "number", step: 1 },
    { key: "stopAtrBuffer", label: "Stop buffer (× ATR)", type: "number", step: 0.05 },
    { key: "target", label: "Target", type: "select", options: ["vwap", "1sigma"] },
    { key: "exitAtVwap", label: "Exit on a close back at VWAP", type: "bool" },
  ],
  // Reads NIFTY 50 and the sector index (ctx.market): backtests and plans attach them.
  needsMarket: true,
  // The guard tests (lookahead, session leak) run strategies with these on top of the defaults,
  // so the entry path is exercised on random data, which can't reach 85 (no market data, no
  // order book) and rarely offers 1.5:1 to VWAP. Every other mandatory condition stays on.
  testParams: { minScore: 0, minNetRR: 0 },
  warmup: () => VWAP_REVERSION.setup.minBars,

  onBar(ctx) {
    const p = ctx.params;
    if (ctx.position) {
      if (!p.exitAtVwap) return null;
      const vw = ctx.ind("vwap");
      const c = ctx.bar();
      const back = ctx.position.side === "long" ? c.close >= vw : c.close <= vw;
      return back ? { exit: true, reason: "Back at VWAP" } : null;
    }
    if (!triggersNow(ctx)) return null;
    const ev = evaluate(ctx);
    if (!ev.eligible) return null;
    const L = ev.levels;
    const pat = ev.factors.find((f) => f.id === "priceAction")?.details.pattern;
    return {
      side: ev.side,
      stop: L.stop,
      target: p.target === "1sigma" ? L.t1 : L.t2,
      reason: `σ-reversion ${ev.score}/100 (${ev.classification.label})${pat ? ` · ${pat}` : ""} · z ${ev.indicators.peakZ?.toFixed(2)}σ`,
    };
  },

  plan(ctx) {
    const p = ctx.params;
    const m = p.band;
    if (ctx.i < 0) return waiting(`The VWAP σ bands form after the first ${VWAP_REVERSION.setup.minBars} bars; entries from ${p.entryStart}.`);
    const ev = evaluate(ctx);
    if (ev.state === "warming") return waiting(ev.why);
    const x = ev.indicators;
    const bands = `−${m}σ ${px(x.vwap - m * x.sigma)} · VWAP ${px(x.vwap)} · +${m}σ ${px(x.vwap + m * x.sigma)}`;
    const head = `Score ${ev.score}/100 (${ev.classification.label}) → ${ev.decision}.`;
    if (ev.state === "none") return watch([], `Waiting for a ±${m}σ test (z now ${x.z.toFixed(2)}σ). ${bands}. No levels until a band is tested and rejected.`);
    if (ev.state === "stretched" && !ev.hardFails.length) return watch([], `Stretched to ${x.peakZ.toFixed(2)}σ: waiting for a ${tf(ctx)} close back inside ${ev.side === "long" ? "−" : "+"}${m}σ (${px(x.bandNow)}). ${head} ${bands}`);
    if (!ev.showLevels) return off(`${head} ${ev.why} ${bands}`);
    const L = ev.levels;
    const long = ev.side === "long";
    const setup = {
      side: ev.side,
      trigger: L.trigger,
      when: `${tf(ctx)} close ${long ? "above" : "below"} ${px(L.triggerLevel)} (rejection candle ${long ? "high" : "low"})`,
      stop: L.stop,
      target: p.target === "1sigma" ? L.t1 : L.t2,
      approx: L.approx,
    };
    const note = `${head} ${ev.why} ${bands}`;
    return ev.state === "armed" ? armed([setup], note) : watch([setup], note);
  },
});

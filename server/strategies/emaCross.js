import { defineStrategy } from "./common.js";
import { watch, waiting, tf, px } from "./planKit.js";
import { ema } from "../lab/indicators.js";
import { aggregateMinutes } from "../lab/sessions.js";
import { istMinute } from "../lab/time.js";
import { roundTick, tickFor } from "../decision/util.js";

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

// Causal 15m-EMA(period) slope aligned to every base-interval bar: the change in the 15m EMA over
// the last 15m bar that had FULLY closed by that bar (null until two such bars exist). Memoised
// per session; every value at bar k uses only 15m bars ≤ k, so it's lookahead-safe.
function htfSlope(sd, htfMin, period) {
  return sd.memo(`emaHtfSlope|${htfMin}|${period}`, () => {
    const n = sd.candles.length;
    const bars = aggregateMinutes(sd.candles, htfMin);
    const e = ema(bars.map((b) => b.close), period);
    const barClose = bars.map((b) => istMinute(b.time) + htfMin); // IST minute each 15m bar closes
    const out = new Array(n).fill(null);
    for (let k = 0; k < n; k++) {
      const kClose = sd.minutes[k] + sd.intervalMin;
      let j = -1;
      for (let b = 0; b < bars.length && barClose[b] <= kClose; b++) j = b;
      if (j >= 1 && e[j] != null && e[j - 1] != null) out[k] = e[j] - e[j - 1];
    }
    return out;
  });
}

// Each enabled filter, for a candidate entry on `side` at bar ctx.i. A filter with no data to judge
// (warming up, no volume, index offline) fails closed, except market-VWAP, which passes when the
// index isn't attached so an offline backtest still runs.
function filterStates(ctx, side, p) {
  const out = [];
  const long = side === "long";
  if (p.useRegime) {
    const adx = ctx.ind("adx", [14])?.adx ?? null;
    const f = ctx.ind("ema", [p.fast]);
    const s = ctx.ind("ema", [p.slow]);
    const a = ctx.ind("atr", [14]);
    const sep = f != null && s != null && a > 0 ? Math.abs(f - s) / a : null;
    const pass = adx != null && adx > p.adxMin && sep != null && sep > p.minSepAtr;
    out.push({ key: "regime", pass, note: adx == null || sep == null ? "warming up" : `ADX ${adx.toFixed(0)}, sep ${sep.toFixed(2)}×ATR` });
  }
  if (p.useHtf) {
    const slope = htfSlope(ctx.sd, p.htfMin, 21)[ctx.i];
    const pass = slope != null && (long ? slope > 0 : slope < 0);
    out.push({ key: "htf", pass, note: slope == null ? "warming up" : `${p.htfMin}m EMA21 ${slope > 0 ? "rising" : "falling"}` });
  }
  if (p.useRelVol) {
    const slot = ctx.minute();
    const vols = ctx.ref.profile.slice(-p.relVolDays).map((pr) => pr.vol[slot]).filter((v) => v != null);
    const avg = vols.length ? mean(vols) : null;
    const cur = ctx.bar().volume || 0;
    const pass = avg > 0 && cur >= p.relVolMult * avg;
    out.push({ key: "relVol", pass, note: avg ? `${(cur / avg).toFixed(1)}× ${vols.length}d avg` : "no history" });
  }
  if (p.useMarketVwap) {
    const m = ctx.market("nifty");
    const pass = !m || m.vwap == null || (long ? m.close > m.vwap : m.close < m.vwap);
    out.push({ key: "marketVwap", pass, note: !m || m.vwap == null ? "index n/a" : `NIFTY ${m.close > m.vwap ? ">" : "<"} VWAP` });
  }
  return out;
}

const filtersNote = (states) => (states.length ? ` · filters: ${states.map((s) => `${s.key} ${s.pass ? "✓" : "✗"}`).join(" ")}` : "");

export default defineStrategy({
  id: "emaCross",
  levels: ["ema9", "ema21"],
  name: "9/21 EMA Crossover",
  description: "Fast EMA crosses the slow EMA (both restart each session). Optional regime / 15m-trend / relative-volume / NIFTY-VWAP filters. Stop at the recent swing; optional exit on the opposite cross. Best on 5m.",
  defaultInterval: "5m",
  needsMarket: true, // only read when useMarketVwap is on; off by default, so default trades are unchanged
  params: {
    fast: 9, slow: 21, swingBars: 5, exitOnCross: true, entryEnd: "14:30",
    // STEP 2 filters — each independently toggleable (all off by default so A/B is clean).
    // shortcut: minSepAtr defaults 0 because we enter AT the cross, where EMA9≈EMA21 (separation ≈ 0);
    // a non-zero value only makes sense with a confirmed/pullback entry, which this strategy isn't.
    useRegime: false, adxMin: 22, minSepAtr: 0,
    useHtf: false, htfMin: 15,
    useRelVol: false, relVolMult: 1.5, relVolDays: 20,
    useMarketVwap: false,
  },
  spec: [
    { key: "fast", label: "Fast EMA", type: "number", step: 1 },
    { key: "slow", label: "Slow EMA", type: "number", step: 1 },
    { key: "swingBars", label: "Swing stop lookback (bars)", type: "number", step: 1 },
    { key: "exitOnCross", label: "Exit on opposite cross", type: "bool" },
    { key: "useRegime", label: "Filter: ADX + EMA separation", type: "bool" },
    { key: "adxMin", label: "Min ADX(14)", type: "number", step: 1 },
    { key: "minSepAtr", label: "Min |EMA9−EMA21| ÷ ATR", type: "number", step: 0.1 },
    { key: "useHtf", label: "Filter: 15m EMA21 slope agrees", type: "bool" },
    { key: "htfMin", label: "Higher timeframe (min)", type: "number", step: 5 },
    { key: "useRelVol", label: "Filter: relative volume", type: "bool" },
    { key: "relVolMult", label: "Min rel. volume (× slot avg)", type: "number", step: 0.1 },
    { key: "relVolDays", label: "Rel. volume lookback (sessions)", type: "number", step: 1 },
    { key: "useMarketVwap", label: "Filter: side agrees with NIFTY vs VWAP", type: "bool" },
  ],
  warmup: (p) => p.slow,
  onBar(ctx) {
    const p = ctx.params;
    if (ctx.i < p.slow) return null;
    const f = ctx.ind("ema", [p.fast]);
    const s = ctx.ind("ema", [p.slow]);
    const fp = ctx.ind("ema", [p.fast], 1);
    const sp = ctx.ind("ema", [p.slow], 1);
    if (f == null || s == null || fp == null || sp == null) return null;
    if (ctx.position) {
      const pos = ctx.position;
      if (p.exitOnCross && ((pos.side === "long" && f < s) || (pos.side === "short" && f > s))) {
        return { exit: true, reason: "Opposite EMA cross" };
      }
      return null;
    }
    let side = null;
    if (fp <= sp && f > s) side = "long";
    else if (fp >= sp && f < s) side = "short";
    if (!side) return null;
    if (!filterStates(ctx, side, p).every((x) => x.pass)) return null;
    return side === "long"
      ? { side: "long", stop: ctx.lowest(p.swingBars, "low", 0), reason: `EMA ${p.fast} crossed above ${p.slow}` }
      : { side: "short", stop: ctx.highest(p.swingBars, "high", 0), reason: `EMA ${p.fast} crossed below ${p.slow}` };
  },
  plan(ctx) {
    const p = ctx.params;
    if (ctx.i < p.slow - 1) return waiting(`EMA ${p.slow} needs ${p.slow} bars (restarts each session).`);
    const f = ctx.ind("ema", [p.fast]);
    const s = ctx.ind("ema", [p.slow]);
    if (f == null || s == null) return waiting("EMAs not ready yet.");
    // The next close x that makes the EMAs cross: f + af(x − f) = s + as(x − s).
    const af = 2 / (p.fast + 1);
    const as = 2 / (p.slow + 1);
    const x = (s * (1 - as) - f * (1 - af)) / (af - as);
    const side = f > s ? "short" : "long";
    const tk = tickFor(x);
    const trigger = roundTick(x, tk);
    const states = filterStates(ctx, side, p);
    const note = (txt) => txt + filtersNote(states);
    if (side === "short") {
      const stop = roundTick(Math.max(ctx.highest(p.swingBars - 1, "high", 0) ?? x, x), tk, "up");
      return watch(
        [{ side: "short", trigger, when: `${tf(ctx)} close below this makes EMA ${p.fast} cross under EMA ${p.slow}`, stop, approx: true }],
        note(`EMA ${p.fast} ${px(f)} above EMA ${p.slow} ${px(s)} (up) — next signal is a SELL`)
      );
    }
    const stop = roundTick(Math.min(ctx.lowest(p.swingBars - 1, "low", 0) ?? x, x), tk, "down");
    return watch(
      [{ side: "long", trigger, when: `${tf(ctx)} close above this makes EMA ${p.fast} cross over EMA ${p.slow}`, stop, approx: true }],
      note(`EMA ${p.fast} ${px(f)} below EMA ${p.slow} ${px(s)} (down) — next signal is a BUY`)
    );
  },
});

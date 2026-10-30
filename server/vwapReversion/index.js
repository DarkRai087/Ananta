// VWAP σ-Band Mean Reversion — the eight-factor decision engine.
//
//   analyse  → the setup on both sides of VWAP (setup.js), then all eight factors
//   score    → factors 1–7 add up to 100; missing data scores 0 and is listed
//   validate → mandatory conditions (strong-trend, confirmation, liquidity, risk, session/news)
//   decide   → exactly one of LONG · SHORT · WATCHLIST · NO TRADE
//
// evaluate(ctx) reads bars 0..i through the guarded BarContext, so the backtest (onBar), the
// trade-plan row (plan) and the live decision report all run this same code on the same data.
// Live-only inputs (quote, breadth, account, symbol events) arrive in `extras`.
import { VWAP_REVERSION } from "../config/vwapReversion.js";
import { minToHHMM } from "../lab/time.js";
import { bandSeries, findSetup, primarySetup, bandAt } from "./setup.js";
import { tradeLevels, resolveRisk } from "./levels.js";
import { regimeFactor } from "./factors/regime.js";
import { deviationFactor } from "./factors/deviation.js";
import { priceActionFactor } from "./factors/priceAction.js";
import { volumeFactor } from "./factors/volume.js";
import { marketFactor } from "./factors/market.js";
import { liquidityFactor } from "./factors/liquidity.js";
import { riskFactor } from "./factors/risk.js";
import { sessionFilter } from "./factors/session.js";
import { tickFor, num } from "../decision/util.js";

export { VWAP_REVERSION };

// Config with the strategy's Lab params on top.
export function configFor(params = {}) {
  const C = VWAP_REVERSION;
  const n = (v, d) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
  return {
    ...C,
    executeAt: n(params.minScore, C.executeAt),
    setup: { ...C.setup, band: n(params.band, C.setup.band), lookback: n(params.lookback, C.setup.lookback), maxBarsToConfirm: n(params.maxBarsToConfirm, C.setup.maxBarsToConfirm) },
    risk: { ...C.risk, stopAtrBuffer: n(params.stopAtrBuffer, C.risk.stopAtrBuffer), minNetRR: n(params.minNetRR, C.risk.minNetRR) },
  };
}

export function classify(score, classes = VWAP_REVERSION.classes) {
  return classes.find((c) => score >= c.min) ?? classes[classes.length - 1];
}

// Typical bar range: ATR(14) when ready, else the mean true range so far, else a daily slice.
function atrNow(ctx, S, i) {
  const a = ctx.ind("atr", [14]);
  if (num(a) && a > 0) return { value: a, source: "ATR(14)" };
  if (i >= 5) {
    let s = 0;
    for (let k = 1; k <= i; k++) {
      const c = S.bars[k];
      const p = S.bars[k - 1];
      s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    return { value: s / i, source: `mean true range of ${i} bars (ATR 14 not ready)` };
  }
  if (ctx.ref.atrDaily) return { value: ctx.ref.atrDaily * 0.15, source: "15% of the 14-day daily ATR (too few bars)" };
  return { value: S.bars[i].close * 0.003, source: "0.3% of price (no ATR yet)" };
}

/**
 * Fast check for the backtest: does a trigger fire on THIS bar? Only then is the full
 * evaluation worth running (onBar enters only on a fresh trigger).
 */
export function triggersNow(ctx) {
  const cfg = configFor(ctx.params);
  const i = ctx.i;
  if (i < cfg.setup.minBars) return false;
  const S = bandSeries(ctx, cfg.setup.minBars, Math.max(0, i - cfg.setup.lookback - 1));
  return findSetup(S, "long", i, cfg.setup).state === "triggered" || findSetup(S, "short", i, cfg.setup).state === "triggered";
}

function warming(why, extra = {}) {
  return { decision: "NO TRADE", eligible: false, showLevels: false, conditional: false, state: "warming", side: null, score: 0, maxAvailable: 0, factors: [], gates: [], hardFails: [], pending: [], cautions: [], missing: [], levels: null, why, ...extra };
}

/**
 * Full evaluation at bar ctx.i.
 * extras: { account, quote, breadth, symbol, events, tradesToday, dayPnlRs, nowMinute, tick, sectorId }
 */
export function evaluate(ctx, { extras = {} } = {}) {
  const params = ctx.params || {};
  const cfg = configFor(params);
  const i = ctx.i;
  const intervalMin = ctx.intervalMin;
  if (i < 0) return warming("No bars yet this session.");
  const S = bandSeries(ctx, cfg.setup.minBars);
  const sigma = S.sigma[i];
  const timeOf = (k) => minToHHMM(ctx.minute(k));
  if (!(sigma > 0)) return warming(`The VWAP σ bands need ${cfg.setup.minBars} bars (ready from ${minToHHMM(ctx.minute(0) + cfg.setup.minBars * intervalMin)}).`);

  const close = S.bars[i].close;
  const vwap = S.vwap[i];
  const z = (close - vwap) / sigma;
  const sLong = findSetup(S, "long", i, cfg.setup);
  const sShort = findSetup(S, "short", i, cfg.setup);
  const setup = primarySetup(sLong, sShort, z);
  const other = setup === sLong ? sShort : sLong;
  const side = setup.side;
  const long = side === "long";

  const D = {
    ctx,
    cfg,
    params,
    i,
    S,
    setup,
    side,
    long,
    intervalMin,
    nextMin: ctx.minute(i) + intervalMin,
    timeOf,
    extras,
    quote: extras.quote ?? null,
    breadth: extras.breadth ?? null,
    tick: tickFor(close, extras.tick),
  };
  D.atr = atrNow(ctx, S, i);
  D.risk = resolveRisk(cfg.risk, extras.account, D.quote);

  // Regime first: T3 depends on it. Then the levels, which factors 2, 6, 7 and 8 use.
  const regime = regimeFactor(D);
  D.levels = tradeLevels(D, regime.details.scoreForT3);
  const deviation = deviationFactor(D);
  const priceAction = priceActionFactor(D);
  const volume = volumeFactor(D);
  const market = marketFactor(D);
  const liquidity = liquidityFactor(D);
  const risk = riskFactor(D);
  const session = sessionFilter(D);

  const factors = [regime, deviation, priceAction, volume, market, liquidity, risk];
  const score = Math.round(factors.reduce((s, f) => s + f.score, 0) * 10) / 10;
  const maxAvailable = factors.reduce((s, f) => s + f.maxAvailable, 0);
  const gates = [...session.gates, ...regime.gates, ...priceAction.gates, ...liquidity.gates, ...risk.gates];
  const hardFails = gates.filter((g) => !g.pass && g.hard);
  const pending = gates.filter((g) => !g.pass && !g.hard);
  const classification = classify(score, cfg.classes);
  const trigLine = (f, key) => f.lines.find((l) => l.key === key);
  const upside = setup.state === "armed" || setup.state === "stretched" ? (4 - (trigLine(priceAction, "trigger")?.points ?? 0)) + (3 - (trigLine(volume, "trigVol")?.points ?? 0)) : 0;

  let decision = "NO TRADE";
  let eligible = false;
  let showLevels = false;
  let why;
  const noSetup = { none: "No ±2σ band test — no setup.", failed: `No setup: ${setup.note}.`, stale: `The setup went stale: no trigger within ${cfg.setup.maxBarsToConfirm} bars of the rejection candle.`, fired: `The trigger already fired at the ${setup.triggerIdx >= 0 ? timeOf(setup.triggerIdx) : ""} candle — no fresh entry.` };
  if (noSetup[setup.state]) {
    why = noSetup[setup.state];
  } else if (hardFails.length) {
    why = `Mandatory condition failed: ${hardFails.map((g) => g.label.toLowerCase()).join("; ")}.`;
  } else if (setup.state === "triggered" && score >= cfg.executeAt) {
    decision = long ? "LONG" : "SHORT";
    eligible = true;
    showLevels = true;
    why = `Triggered, score ${score} ≥ ${cfg.executeAt}, every mandatory condition passes.`;
  } else if (score >= cfg.watchAt) {
    decision = "WATCHLIST";
    showLevels = setup.state !== "triggered" && D.levels != null; // stretched: no levels until a candle closes back inside
    why =
      setup.state === "triggered"
        ? `Triggered, but the score ${score} is below the ${cfg.executeAt} needed to execute.`
        : `${pending.map((g) => g.reason).join("; ")}. Score ${score} now${upside ? `, up to ${Math.min(100, score + upside)} if the trigger comes with volume` : ""}; ${cfg.executeAt} needed to execute.`;
  } else {
    why = `Score ${score} is below ${cfg.watchAt} (watchlist) — ${classification.label.toLowerCase()} setup.`;
  }

  const rsi5 = ctx.ind("rsi", [5]);
  const rsi14 = ctx.ind("rsi", [14]);
  const missing = [...factors.flatMap((f) => f.missing), ...factors.flatMap((f) => f.extraMissing || []), ...session.missing];
  return {
    decision,
    eligible,
    showLevels,
    conditional: showLevels && !eligible,
    why,
    side,
    state: setup.state,
    setup,
    otherSide: { side: other.side, state: other.state },
    score,
    maxAvailable,
    minScore: cfg.executeAt,
    watchAt: cfg.watchAt,
    minNetRR: cfg.risk.minNetRR,
    deadline: setup.t >= 0 ? minToHHMM(ctx.minute(setup.t) + cfg.setup.maxBarsToConfirm * intervalMin) : null, // last candle that can still trigger
    classification,
    upside,
    factors,
    gates,
    hardFails,
    pending,
    cautions: session.cautions,
    missing,
    session: session.info,
    levels: D.levels,
    risk: D.risk,
    tick: D.tick,
    bar: { index: i, time: timeOf(i), next: minToHHMM(D.nextMin), close },
    indicators: {
      close,
      vwap,
      sigma,
      z,
      atr: D.atr.value,
      atrSource: D.atr.source,
      rsi5,
      rsi14,
      bandNow: bandAt(S, i, cfg.setup.band, side),
      ...regime.details,
      ...deviation.details,
      rvol: volume.details.rvol,
      volume: volume.details.volume,
      avgVolume: volume.details.avgVolume,
      avgBars: volume.details.avgBars,
      market: market.details,
      liquidity: liquidity.details,
    },
  };
}

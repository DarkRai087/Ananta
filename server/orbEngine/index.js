// Opening Range Breakout — the multi-factor decision engine.
//
//   analyse  → the opening range, then the breakout on both sides (setup.js)
//   validate → the mandatory conditions (range complete, confirmed, not failed, volume, liquidity,
//              spread, stop, reward / risk, session, news, risk limits, spent volatility, chasing)
//   score    → eight factors, 100 points; missing data scores 0 and is listed
//   calculate→ entry, structural stop, targets, size after charges (levels.js)
//   decide   → exactly one of LONG · SHORT · WATCHLIST · NO TRADE
//
// evaluate(ctx) reads bars 0..i through the guarded BarContext, so the backtest (onBar), the
// trade-plan row (plan) and the live decision report run the same code on the same data.
// Live-only inputs (quote, breadth, India VIX, account, symbol events) arrive in `extras`.
import { ORB } from "../config/orb.js";
import { minToHHMM, OPEN_MIN } from "../lab/time.js";
import { tickFor, num } from "../decision/util.js";
import { resolveRisk } from "../decision/sizing.js";
import { atrSeries } from "../decision/atr.js";
import { orStats, makeRvol, findBreakout, primarySide } from "./setup.js";
import { orbLevels } from "./levels.js";
import { rangeFactor } from "./factors/range.js";
import { marketFactor } from "./factors/market.js";
import { volumeFactor } from "./factors/volume.js";
import { candleFactor } from "./factors/candle.js";
import { confirmationFactor } from "./factors/confirmation.js";
import { momentumFactor } from "./factors/momentum.js";
import { strengthFactor } from "./factors/strength.js";
import { riskFactor } from "./factors/risk.js";
import { sessionFilter } from "./factors/session.js";

export { ORB };

// Config with the strategy's Lab params on top.
export function configFor(params = {}) {
  const n = (v, d) => (v === undefined || v === null || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
  return {
    ...ORB,
    executeAt: n(params.minScore, ORB.executeAt),
    setup: { ...ORB.setup, bufferPct: n(params.bufferPct, ORB.setup.bufferPct) },
    risk: { ...ORB.risk, minNetRR: n(params.minNetRR, ORB.risk.minNetRR) },
  };
}

export const classify = (score, classes = ORB.classes) => classes.find((c) => score >= c.min) ?? classes[classes.length - 1];

const bars = (ctx) => Array.from({ length: ctx.i + 1 }, (_, k) => ctx.bar(k));

/** Fast check for the backtest: does a breakout entry trigger on THIS bar? */
export function triggersNow(ctx) {
  const p = ctx.params;
  const cfg = configFor(p);
  const or = ctx.openingRange(p.orMinutes);
  if (!or || ctx.i <= or.completeIndex) return false;
  const S = bars(ctx);
  const atr = atrSeries(ctx, ctx.i).value;
  const rvol = makeRvol(ctx, cfg);
  return ["long", "short"].some((side) => findBreakout(S, or, side, ctx.i, cfg, atr, rvol, p.models).state === "triggered");
}

const empty = (why, extra = {}) => ({ details: null, decision: "NO TRADE", eligible: false, showLevels: false, conditional: false, state: "forming", side: null, score: 0, maxAvailable: 0, factors: [], gates: [], hardFails: [], pending: [], cautions: [], missing: [], levels: null, why, ...extra });

/**
 * Full evaluation at bar ctx.i.
 * extras: { account, quote, breadth, vix, symbol, events, tradesToday, dayPnlRs, nowMinute, staleMin, tick }
 */
export function evaluate(ctx, { extras = {} } = {}) {
  const params = ctx.params || {};
  const cfg = configFor(params);
  const i = ctx.i;
  const intervalMin = ctx.intervalMin;
  if (i < 0) return empty("No bars yet this session.");
  const timeOf = (k) => minToHHMM(ctx.minute(k));
  const S = bars(ctx);
  const atrS = atrSeries(ctx, i);
  const rvol = makeRvol(ctx, cfg);
  const or = orStats(ctx, params.orMinutes ?? 15, cfg);
  const orEndMin = OPEN_MIN + Math.max(Number(params.orMinutes ?? 15), intervalMin);
  if (!or) return empty(`The ${params.orMinutes}-minute opening range completes at ${minToHHMM(orEndMin)}; no breakout can be judged before then.`, { orEnd: minToHHMM(orEndMin) });

  const close = S[i].close;
  const L = findBreakout(S, or, "long", i, cfg, atrS.value, rvol, params.models);
  const Sh = findBreakout(S, or, "short", i, cfg, atrS.value, rvol, params.models);
  const setup = primarySide(L, Sh, close);
  const other = setup === L ? Sh : L;
  const long = setup.side === "long";
  let dayHi = -Infinity;
  let dayLo = Infinity;
  for (const b of S) {
    dayHi = Math.max(dayHi, b.high);
    dayLo = Math.min(dayLo, b.low);
  }

  const D = {
    ctx,
    cfg,
    params,
    i,
    S,
    or,
    setup,
    side: setup.side,
    long,
    atr: atrS.value,
    rvol,
    intervalMin,
    interval: `${intervalMin}m`,
    nextMin: ctx.minute(i) + intervalMin,
    timeOf,
    extras,
    quote: extras.quote ?? null,
    breadth: extras.breadth ?? null,
    vix: extras.vix ?? null,
    tick: tickFor(close, extras.tick),
    consumed: ctx.ref.atrDaily ? (dayHi - dayLo) / ctx.ref.atrDaily : null,
  };
  D.risk = resolveRisk(cfg.risk, extras.account, D.quote);
  D.levels = orbLevels(D);

  const range = rangeFactor(D);
  const market = marketFactor(D);
  D.marketDetails = market.details;
  const volume = volumeFactor(D);
  const candle = candleFactor(D);
  const confirm = confirmationFactor(D);
  const momentum = momentumFactor(D);
  const strength = strengthFactor(D);
  const risk = riskFactor(D);
  const session = sessionFilter(D);

  const factors = [range, market, volume, candle, confirm, momentum, strength, risk];
  const score = Math.round(factors.reduce((s, f) => s + f.score, 0) * 10) / 10;
  const maxAvailable = factors.reduce((s, f) => s + f.maxAvailable, 0);
  const gates = [...session.gates, ...confirm.gates, ...strength.gates, ...risk.gates];
  const hardFails = gates.filter((g) => !g.pass && g.hard);
  const pending = gates.filter((g) => !g.pass && !g.hard);
  const classification = classify(score, cfg.classes);

  let decision = "NO TRADE";
  let eligible = false;
  let showLevels = false;
  let why;
  const st = setup.state;
  if (st === "inside") {
    why = `No breakout close yet: watching for a ${D.interval} close above ${num(L.breakLevel) ? L.breakLevel.toFixed(2) : "ORH"} or below ${num(Sh.breakLevel) ? Sh.breakLevel.toFixed(2) : "ORL"}.`;
  } else if (st === "failed") {
    why = `The ${long ? "upside" : "downside"} breakout failed (${setup.failWhy} at ${timeOf(setup.failIdx)}). No automatic reversal — the other side needs its own breakout.`;
  } else if (st === "expired") {
    why = `The breakout ${setup.note}.`;
  } else if (st === "fired") {
    why = `This breakout already triggered at the ${timeOf(setup.triggerIdx)} candle — no repeat entry.`;
  } else if (hardFails.length) {
    why = `Mandatory condition failed: ${hardFails.map((g) => g.label.toLowerCase()).join("; ")}.`;
  } else if (st === "triggered" && score >= cfg.executeAt) {
    decision = long ? "LONG" : "SHORT";
    eligible = true;
    showLevels = true;
    why = `Model ${setup.model} triggered, score ${score} ≥ ${cfg.executeAt}, every mandatory condition passes.`;
  } else if (score >= cfg.watchAt) {
    decision = "WATCHLIST";
    showLevels = st === "broken" && D.levels != null;
    why = st === "triggered" ? `Triggered (model ${setup.model}), but the score ${score} is below the ${cfg.executeAt} needed to execute.` : `${pending.map((g) => g.reason).join("; ")}. Score ${score}; ${cfg.executeAt} needed to execute.`;
  } else {
    why = `Score ${score} is below ${cfg.watchAt} (watchlist) — ${classification.label.toLowerCase()} setup.`;
  }

  const missing = [...factors.flatMap((f) => f.missing), ...factors.flatMap((f) => f.extraMissing || []), ...session.missing];
  return {
    decision,
    eligible,
    showLevels,
    conditional: showLevels && !eligible,
    why,
    side: setup.side,
    state: st,
    setup,
    otherSide: { side: other.side, state: other.state, level: other.level },
    score,
    maxAvailable,
    minScore: cfg.executeAt,
    watchAt: cfg.watchAt,
    minNetRR: cfg.risk.minNetRR,
    classification,
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
    or,
    consumed: D.consumed,
    bar: { index: i, time: timeOf(i), next: minToHHMM(D.nextMin), close },
    details: {
      range: range.details,
      market: market.details,
      volume: volume.details,
      candle: candle.details,
      confirm: confirm.details,
      momentum: momentum.details,
      strength: strength.details,
      atr: atrS.value[i],
      atrSource: atrS.source[i],
      dayHigh: dayHi,
      dayLow: dayLo,
      ref: { pdc: ctx.ref.pdc, pdh: ctx.ref.pdh, pdl: ctx.ref.pdl, open: ctx.ref.open, gapPct: ctx.ref.gapPct, atrDaily: ctx.ref.atrDaily },
    },
  };
}

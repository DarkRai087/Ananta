// The ORB decision dashboard (sections A–F of the spec, plus the decision explanation) from one
// evaluation. Trade numbers appear only when the decision allows them: NO TRADE never carries an
// entry, stop, target or quantity — only the exact failed conditions and what has to change.
import { num, roundTick, rs } from "../decision/util.js";

const f2 = (x, d = 2) => (num(x) ? x.toFixed(d) : "—");
const dirWord = (d) => (d > 0 ? "Up" : d < 0 ? "Down" : "Mixed");
const MODEL = { A: "Close + acceptance", B: "Breakout and retest", C: "Momentum" };

const NEEDS = {
  orComplete: (g) => `Wait for the opening range (${g.reason})`,
  window: () => "The entry window has closed — late breakouts are skipped; next session",
  time: () => "Not enough time left for the move before 15:15 — next session",
  data: () => "Complete candle data for today (resync the symbol)",
  stale: () => "Fresh data: the last candle is out of date (check the data feed)",
  events: (g) => `Wait until the event blackout is over (${g.reason})`,
  shock: () => "Let price settle: no candle of 3.5 ATR or more since the range",
  gap: () => "News-driven gap day — skip today",
  failed: () => "That side's breakout failed — it stays off today; the other side needs its own confirmed breakout",
  volume: () => "A breakout candle with at least 0.8× the usual volume for that time of day",
  chase: () => "Don't chase: wait for a retest of the level (model B) instead of buying an extended move",
  value: () => "More traded value per minute (the stock is too thin right now)",
  daily: () => "A more liquid stock (20-day average traded value is too low)",
  participation: () => "A smaller position or a busier market (the size is too large a share of each bar)",
  spread: () => "A tighter bid-ask spread",
  circuit: () => "Price must move away from the circuit limit",
  trades: () => "Daily trade limit reached — next session",
  dayLoss: () => "Daily loss limit reached — next session",
  consumed: () => "The stock has already used its typical daily range — no room left for a breakout move",
  stopOk: () => "A logical stop below the breakout structure",
  qty: () => "A tighter structural stop: even one share risks more than the budget",
};

function bullets(ev) {
  const confirms = [];
  const opposes = [];
  for (const f of ev.factors) {
    for (const l of f.lines) {
      if (l.status === "na" || l.status === "missing" || !l.max) continue;
      const text = `${l.label}: ${l.value ?? "—"}${l.note ? ` — ${l.note}` : ""}`;
      if (l.points >= 0.7 * l.max) confirms.push(text);
      else if (l.points <= 0.3 * l.max && l.max >= 2) opposes.push(text);
    }
  }
  for (const c of ev.cautions) opposes.push(c);
  return { confirms, opposes };
}

/** ev: orbEngine evaluate(). c: { symbol, interval, phase, label, asOf, lastPrice, priceSource, quote, quoteError, breadth, vix, run, entryEv, scoreWithoutLive, params } */
export function buildOrbReport(ev, c) {
  const tf = c.interval;
  const long = ev.side === "long";
  const out = {
    strategy: "orb",
    symbol: c.symbol,
    interval: c.interval,
    phase: c.phase,
    label: c.label,
    asOf: c.asOf,
    barTime: ev.bar?.time ?? null,
    decision: ev.decision,
    eligible: ev.eligible,
    conditional: ev.conditional,
    why: ev.why,
    side: ev.side,
    state: ev.state,
    score: ev.score,
    maxAvailable: ev.maxAvailable,
    minScore: ev.minScore,
    watchAt: ev.watchAt,
    classification: ev.classification ?? null,
    scoreWithoutLive: c.scoreWithoutLive ?? null,
    gates: ev.gates,
    cautions: ev.cautions,
    missing: [...new Set(ev.missing)],
    live: { quote: c.quote ?? null, quoteError: c.quoteError ?? null, breadth: c.breadth ?? null, vix: c.vix ?? null },
    position: null,
    trades: c.run?.trades ?? [],
    chart: [],
  };
  if (c.run?.open) {
    const p = c.run.open;
    out.position = { ...p, lastPrice: c.lastPrice, entryDecision: c.entryEv ? { decision: c.entryEv.decision, score: c.entryEv.score, time: c.entryEv.bar?.time, model: c.entryEv.setup?.model } : null };
  }
  if (ev.state === "forming" || !ev.details) {
    out.F = { score: 0, failed: [ev.why], missing: [], regime: "—", needs: [ev.why] };
    return out;
  }

  const d = ev.details;
  const mk = d.market;
  const o = ev.or;
  const ix = (x) => (x ? { name: x.name, dir: dirWord(x.dir), dayPct: x.dayPct, aboveVwap: x.aboveVwap } : null);
  out.A = {
    symbol: c.symbol,
    price: c.lastPrice ?? ev.bar.close,
    priceSource: c.priceSource ?? `close of the ${ev.bar.time} candle`,
    prevClose: d.ref.pdc,
    open: d.ref.open,
    gapPct: d.ref.gapPct,
    gapAtr: mk.gapAtr,
    nifty: ix(mk.nifty),
    sector: ix(mk.sector),
    regime: mk.regime,
    vix: c.vix ?? null,
    breadth: c.breadth ?? null,
    time: ev.session?.time,
    session: ev.session,
  };
  out.B = {
    minutes: o.minutes,
    high: o.high,
    low: o.low,
    mid: o.mid,
    width: o.width,
    widthPct: o.widthPct,
    atrRatio: o.atrRatio,
    atrDaily: o.atrDaily,
    percentile: o.percentile,
    historyN: o.historyN,
    medianWidthPct: o.medianWidthPct,
    classification: d.range.classification,
    volume: o.volume,
    volRatio: o.volRatio,
    formation: o.formation,
  };
  const cd = d.candle;
  const cf = d.confirm;
  out.C = {
    direction: ev.state === "inside" ? "None yet" : long ? "Up (long)" : "Down (short)",
    level: ev.setup.level,
    breakLevel: ev.setup.breakLevel,
    candleTime: cd?.time ?? null,
    candleClose: cd?.candle?.close ?? null,
    bodyRatio: cd?.metrics?.bodyPct ?? null,
    closePos: cd?.metrics?.closePos ?? null,
    againstWick: cd?.metrics?.againstWickPct ?? null,
    distanceAtr: cd?.distAtr ?? null,
    distance: cd ? (long ? cd.candle.close - ev.setup.level : ev.setup.level - cd.candle.close) : null,
    candleAtr: cd?.sizeAtr ?? null,
    candleClass: cd?.classification ?? null,
    rvol: d.volume.breakout?.value ?? null,
    rvolSource: d.volume.breakout?.source ?? null,
    participation: d.volume.participation,
    confirmation: cf.status,
    model: ev.setup.model ? `${ev.setup.model} — ${MODEL[ev.setup.model]}` : null,
    retest: cf.retest ? `retest at the level, ${f2(cf.retest.depthAtr)} ATR deep${ev.setup.model === "B" ? ", confirmed" : ", waiting for confirmation"}` : "none",
    falseRisk: cf.riskLevel,
    flags: cf.flags,
    otherSide: ev.otherSide,
    wickBreaks: ev.setup.wickBreaks,
  };
  const m = d.momentum;
  out.D = {
    vwap: m.vwap,
    vwapSlope: m.vwapSlope,
    vwapDistance: m.vwapDistance,
    vwapDistAtr: m.vwapDistAtr,
    ema9: m.ema9,
    ema20: m.ema20,
    ema50: m.ema50,
    rsi5: m.rsi5,
    rsi14: m.rsi14,
    adx: m.adx,
    plusDI: m.plusDI,
    minusDI: m.minusDI,
    atr: d.atr,
    atrSource: d.atrSource,
    macdStatus: m.macdStatus,
    rsNifty: d.strength.rsNifty,
    rsSector: d.strength.rsSector,
    liquidity: d.strength.liquidity,
  };
  out.E = ev.factors.map((f) => ({ id: f.id, name: f.name, score: f.score, max: f.max, maxAvailable: f.maxAvailable, observation: f.observation, lines: f.lines }));
  out.chart.push({ price: o.high, label: `ORH ${f2(o.high)}`, key: "orHigh" }, { price: o.mid, label: "ORM", key: "orMid" }, { price: o.low, label: `ORL ${f2(o.low)}`, key: "orLow" });

  const L = ev.levels;
  if (ev.showLevels && L) {
    const status = ev.eligible ? "Confirmed signal — enter at the next candle's open" : "Potential setup — conditional, not an active entry";
    out.F = {
      signal: ev.decision,
      status: ev.eligible ? "ACTIVE" : "CONDITIONAL",
      side: ev.side,
      action: long ? "BUY" : "SELL",
      score: ev.score,
      model: L.model ? `${L.model} — ${MODEL[L.model]}` : ev.state === "broken" ? "A or B pending" : "—",
      trigger: L.trigger,
      triggerText: ev.eligible ? `Triggered on the ${ev.bar.time} candle: ${L.triggerText}` : `CONDITIONAL — ${L.triggerText}`,
      expectedEntry: ev.eligible ? roundTick(L.entry, ev.tick) : L.entry,
      entryNote: ev.eligible ? `next candle's open (${ev.bar.next}), about the last close; ${L.slippagePct}% slippage allowed` : "estimate: the fill comes at the open after the trigger candle closes",
      chaseLimit: L.chaseLimit,
      stop: L.stop,
      stopBasis: L.stopBasis,
      stopNote: L.stopNote,
      t1: L.t1,
      t1Why: L.t1Why,
      t2: L.t2,
      t2Why: L.t2Why,
      t3: L.t3,
      t3Why: L.t3Why,
      t3Note: L.t3Note,
      primaryName: L.primaryName,
      riskPerShare: L.riskPerShare,
      capital: ev.risk.capital,
      riskPct: ev.risk.riskPct,
      riskRs: ev.risk.riskRs,
      qty: L.qty,
      exposure: L.exposure,
      utilizationPct: ev.risk.capital > 0 ? (L.exposure / ev.risk.capital) * 100 : null,
      maxLoss: L.maxLossRs,
      lossCharges: L.lossCharges,
      chargesAtTarget: L.chargesAtPrimary,
      netAtT1: L.netAtT1,
      netAtT2: L.netAtT2,
      netAtT3: L.netAtT3,
      grossRR: L.grossRR,
      netRR: L.netRR,
      slippagePct: L.slippagePct,
      slippageSource: ev.risk.slippageSource,
      riskNotes: ev.risk.notes,
      executionStatus: out.position ? "In trade — simulated by the backtest engine (no order placed)" : status,
    };
    const a = long ? "BUY" : "SELL";
    out.chart.push({ price: L.trigger, label: `${a} ${ev.eligible ? "" : "(cond.) "}${f2(L.trigger)}`, key: long ? "buy" : "sell" }, { price: L.stop, label: "SL", key: "stop" }, { price: L.t1, label: "T1", key: "target" });
    if (L.t2 != null) out.chart.push({ price: L.t2, label: "T2", key: "target" });
    if (L.t3 != null) out.chart.push({ price: L.t3, label: "T3", key: "target" });

    const { confirms, opposes } = bullets(ev);
    const lineOf = (fid, key) => ev.factors.find((f) => f.id === fid)?.lines.find((l) => l.key === key);
    out.G = {
      qualifies: `${long ? "Upside" : "Downside"} breakout of the ${o.minutes}-minute range (${f2(o.low)}–${f2(o.high)}): ${cf.status.toLowerCase()}. Score ${ev.score}/100 (${ev.classification.label}).`,
      confirms,
      opposes: [...opposes, ...cf.flags],
      range: `${d.range.classification} range, ${f2(o.widthPct)}% wide${num(o.percentile) ? `, ${f2(o.percentile, 0)}th percentile of ${o.historyN} sessions` : num(o.atrRatio) ? `, ${f2(o.atrRatio)} × daily ATR` : ""}. ${lineOf("range", "room")?.value ?? ""}`,
      volume: d.volume.breakout ? `Breakout volume ${f2(d.volume.breakout.value)}× (${d.volume.participation})${d.volume.breakout.source === "session" ? " vs the session average — no time-of-day history yet" : " vs the same time of day"}. ${lineOf("volume", "absorb")?.note ?? ""}` : "No breakout volume to judge.",
      candle: cd ? `${cd.classification} candle: body ${f2(cd.metrics.bodyPct * 100, 0)}%, closed ${f2(cd.metrics.closePos * 100, 0)}% toward the ${long ? "high" : "low"}, ${f2(cd.distAtr)} ATR beyond the level.` : "No breakout candle yet.",
      acceptance: ev.setup.model === "B" ? "Yes — price came back, held the level and was rejected there." : `${cf.held} close${cf.held === 1 ? "" : "s"} held beyond the level${ev.setup.model === "C" ? " (momentum entry on the breakout candle itself — acceptance not yet proven)" : ""}.`,
      momentum: ev.factors.find((f) => f.id === "momentum").observation,
      reward: `${f2(L.netRR)} : 1 net to ${L.primaryName} ${rs(L.primary)} after charges (minimum ${ev.minNetRR}).`,
      invalidation: `A ${tf} close back inside the range (${long ? "below" : "above"} ${rs(o[long ? "high" : "low"])}) invalidates the breakout and exits the trade; the stop ${rs(L.stop)} (${L.stopBasis}${L.stopNote ? `, ${L.stopNote}` : ""}) caps the loss.`,
      falseBreakout: cf.flags.length ? cf.flags.join("; ") : `a close back inside the range, a heavy-volume stall near ${rs(long ? d.ref.pdh : d.ref.pdl)}, or the market turning against the trade`,
      action: ev.eligible ? `Execute — ${a} at the next candle's open (≈ ${rs(roundTick(L.entry, ev.tick))}). Skip if it opens ${long ? "above" : "below"} ${rs(L.chaseLimit)}.` : `Wait — ${ev.why}`,
    };
  }

  if (!ev.showLevels) {
    const failed = [...ev.hardFails.map((g) => `${g.label}: ${g.reason}`), ...ev.pending.map((g) => `${g.label} (pending): ${g.reason}`)];
    const needs = [];
    if (ev.state === "inside") needs.push(`A completed ${tf} candle closing above ${rs(ev.setup.side === "long" ? ev.setup.breakLevel : ev.otherSide.level)} or below ${rs(ev.setup.side === "short" ? ev.setup.breakLevel : ev.otherSide.level)}, with volume, then acceptance or a held retest`);
    if (ev.state === "fired") needs.push("A fresh, independent setup — this breakout already triggered");
    if (ev.state === "expired") needs.push("A fresh breakout — this one found no entry in time");
    if (ev.state === "broken") needs.push(`Acceptance (the next ${tf} candle holding beyond the level) or a retest rejected at ${rs(ev.setup.level)}`);
    for (const g of ev.hardFails) {
      if (g.id === "rr" && L?.valid && L.qty > 0) needs.push(`At least ${f2(ev.minNetRR, 1)} : 1 net to ${L.primaryName} (now ${f2(L.netRR)}): a closer stop structure or more room to the target`);
      else if (NEEDS[g.id]) needs.push(NEEDS[g.id](g));
    }
    if (!ev.hardFails.length && ev.score < ev.watchAt) {
      const weak = [...ev.factors].sort((a, b) => a.score / a.max - b.score / b.max).slice(0, 3).map((f) => `${f.name} ${f.score}/${f.max}`);
      needs.push(`Score must reach ${ev.watchAt} to watch and ${ev.minScore} to execute (now ${ev.score}). Weakest: ${weak.join(", ")}`);
    }
    if (ev.decision === "WATCHLIST" && ev.state === "triggered") needs.push(`A breakout scoring ${ev.minScore}+ — this one triggered at ${ev.score}`);
    out.H = { score: ev.score, failed, missing: out.missing, regime: mk.regime, needs: [...new Set(needs)] };
  }
  return out;
}

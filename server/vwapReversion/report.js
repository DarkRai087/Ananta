// The decision report (sections A–F of the spec) from one evaluation. Numbers only where the
// decision allows them: NO TRADE never carries an entry, stop, target or quantity.
import { num, roundTick } from "../decision/util.js";

const rs = (x) => (num(x) ? `₹${x.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "—");
const f2 = (x, d = 2) => (num(x) ? x.toFixed(d) : "—");
const dirWord = (d) => (d > 0 ? "Up" : d < 0 ? "Down" : "Mixed");

// What would have to change, for each mandatory condition that failed.
const NEEDS = {
  window: (g) => (/closed/.test(g.reason) ? "Entry window has closed — next session, after the window opens" : `Wait for the entry window (${g.reason})`),
  time: () => "Not enough time left for price to get back to VWAP before 15:15 — next session",
  events: (g) => `Wait until the event blackout is over (${g.reason})`,
  shock: () => "Let price settle: no candle of 3.5 ATR or more in the last 6",
  abnormal: () => "Abnormal-volatility day — mean reversion is unreliable; skip today",
  gap: () => "News-driven gap day — skip today",
  trend: () => "The trend has to cool: ADX under 30, or price stops riding the outer band",
  value: () => "More traded value per minute (the stock is too thin right now)",
  daily: () => "A more liquid stock (20-day average traded value is too low)",
  participation: () => "A smaller position, or a busier market (the size is too large a share of each bar)",
  spread: () => "A tighter bid-ask spread",
  circuit: () => "Price must move away from the circuit limit",
  trades: () => "Daily trade limit reached — next session",
  dayLoss: () => "Daily loss limit reached — next session",
  qty: () => "A tighter stop structure: even one share risks more than the budget",
  confirm: (g) => g.reason,
};

function setupNeeds(ev, tf) {
  const x = ev.indicators;
  const m = 2;
  const L = ev.levels;
  const lower = x.vwap - m * x.sigma;
  const upper = x.vwap + m * x.sigma;
  const away = (p) => `${f2(Math.abs((p - x.close) / x.close) * 100)}% away`;
  switch (ev.state) {
    case "none":
      return `Price must test a band and reject it: −2σ ${rs(lower)} (${away(lower)}) or +2σ ${rs(upper)} (${away(upper)})`;
    case "stretched":
      return `A ${tf} close back ${ev.side === "long" ? "above −2σ" : "below +2σ"} (${rs(x.bandNow)}), then a close ${ev.side === "long" ? "above" : "below"} the rejection candle`;
    case "armed":
      return `A ${tf} close ${ev.side === "long" ? "above" : "below"} ${rs(L?.triggerLevel)} (the rejection candle's ${ev.side === "long" ? "high" : "low"})`;
    case "fired":
      return "A fresh band test — this one already triggered";
    case "stale":
      return "A fresh band test — the last one went stale without a trigger";
    case "failed":
      return "Price must stop extending while the band widens, then test the band again";
    case "warming":
      return ev.why;
    default:
      return null;
  }
}

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
  const div = ev.indicators.market?.divergence;
  if (div) opposes.push(div);
  for (const c of ev.cautions) opposes.push(c);
  return { confirms, opposes };
}

/**
 * ev: evaluate() result. ctx: { symbol, interval, intervalMin, phase, label, lastPrice, priceSource,
 * quote, quoteError, breadth, run, entryEv, scoreWithoutLive, params }
 */
export function buildReport(ev, c) {
  const tf = c.interval;
  const x = ev.indicators || {};
  const long = ev.side === "long";
  const L = ev.levels;
  const out = {
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
    coveragePct: ev.maxAvailable,
    minScore: ev.minScore,
    watchAt: ev.watchAt,
    classification: ev.classification ?? null,
    upside: ev.upside ?? 0,
    scoreWithoutLive: c.scoreWithoutLive ?? null,
    gates: ev.gates,
    cautions: ev.cautions,
    missing: [...new Set(ev.missing)],
    live: { quote: c.quote ?? null, quoteError: c.quoteError ?? null, breadth: c.breadth ?? null },
    position: null,
    trades: c.run?.trades ?? [],
    chart: [],
  };

  if (ev.state === "warming") {
    out.F = { score: 0, failed: [ev.why], missing: [], regime: "—", needs: [ev.why] };
    return out;
  }

  const mk = x.market || {};
  const ix = (i) => (i ? { name: i.name, dir: dirWord(i.dir), dayPct: i.dayPct, aboveVwap: i.aboveVwap, momPct: i.momPct } : null);
  out.A = {
    symbol: c.symbol,
    price: c.lastPrice ?? x.close,
    priceSource: c.priceSource ?? `close of the ${ev.bar.time} candle`,
    regime: x.regime,
    bias: x.bias,
    adx: x.adx,
    plusDI: x.plusDI,
    minusDI: x.minusDI,
    er: x.er,
    rsi5: x.rsi5,
    rsi14: x.rsi14,
    atr: x.atr,
    atrSource: x.atrSource,
    vwapSlope: x.slope,
    rvol: x.rvol,
    rvolBars: x.avgBars,
    volume: x.volume,
    avgVolume: x.avgVolume,
    nifty: ix(mk.nifty),
    sector: ix(mk.sector),
    stockDayPct: mk.stockDayPct,
    session: ev.session,
  };

  const b = x.bands;
  out.B = {
    bands: [
      { label: "+3σ", price: b.p3 },
      { label: "+2σ", price: b.p2 },
      { label: "+1σ", price: b.p1 },
      { label: "VWAP", price: b.vwap },
      { label: "−1σ", price: b.m1 },
      { label: "−2σ", price: b.m2 },
      { label: "−3σ", price: b.m3 },
    ],
    sigma: x.sigma,
    bandAtr: x.bandAtr,
    z: x.z,
    peakZ: x.peakZ,
    distance: x.distance,
    distancePct: x.distancePct,
    nearest: x.nearest,
    classification: x.classification,
    trend: x.trend,
    outside: x.outside,
    timeOutsideMin: x.timeOutsideMin,
    sessionOutside: x.sessionOutside,
    sigmaRatio: x.sigmaRatio,
  };
  out.chart.push({ price: b.p2, label: "+2σ", key: "vwapUpper" }, { price: b.vwap, label: "VWAP", key: "vwap" }, { price: b.m2, label: "−2σ", key: "vwapLower" });

  out.C = ev.factors.map((f) => ({ id: f.id, name: f.name, score: f.score, max: f.max, maxAvailable: f.maxAvailable, observation: f.observation, lines: f.lines }));

  if (ev.showLevels && L) {
    const tick = ev.tick;
    out.D = {
      status: ev.eligible ? "ACTIVE" : "CONDITIONAL",
      side: ev.side,
      action: long ? "BUY" : "SELL",
      triggerText: ev.eligible ? `Triggered: the ${ev.bar.time} ${tf} candle closed ${long ? "above" : "below"} ${rs(L.triggerLevel)}` : `CONDITIONAL — a ${tf} candle must close ${long ? "above" : "below"} ${rs(L.triggerLevel)} (the rejection candle's ${long ? "high" : "low"}) by the ${ev.deadline} candle`,
      trigger: L.trigger,
      expectedEntry: ev.eligible ? roundTick(L.entry, tick) : L.entry,
      entryNote: ev.eligible ? `next candle's open (${ev.bar.next}), about the last close; ${L.slippagePct}% slippage allowed` : `best case: one tick beyond the trigger level. The fill comes at the open after the trigger candle closes, usually ${long ? "higher" : "lower"}`,
      stop: L.stop,
      t1: L.t1,
      t2: L.t2,
      t3: L.t3,
      t3Note: L.t3Note,
      chaseLimit: L.chaseLimit,
      riskPerShare: L.riskPerShare,
      qty: L.qty,
      exposure: L.exposure,
      maxRisk: L.maxLossRs,
      lossCharges: L.lossCharges,
      grossRR: L.grossRR,
      netRR: L.netRR,
      netAtT1: L.netAtT1,
      netAtT2: L.netAtT2,
      netAtT3: L.netAtT3,
      chargesAtT2: L.chargesAtT2,
      slippagePct: L.slippagePct,
      slippageSource: ev.risk.slippageSource,
      risk: { capital: ev.risk.capital, riskPct: ev.risk.riskPct, riskRs: ev.risk.riskRs, maxPositionValue: ev.risk.maxPositionValue, notes: ev.risk.notes },
      score: ev.score,
    };
    const a = long ? "BUY" : "SELL";
    out.chart.push({ price: L.trigger, label: `${a} ${ev.eligible ? "" : "(cond.) "}${f2(L.trigger)}`, key: long ? "buy" : "sell" }, { price: L.stop, label: "SL", key: "stop" }, { price: L.t1, label: "T1", key: "target" }, { price: L.t2, label: "T2 VWAP", key: "target" });
    if (L.t3 != null) out.chart.push({ price: L.t3, label: "T3", key: "target" });

    const s = ev.setup;
    const pa = ev.factors.find((f) => f.id === "priceAction").details;
    const { confirms, opposes } = bullets(ev);
    out.E = {
      qualifies: `Price stretched to ${f2(x.peakZ)}σ, ${pa.pattern ? `rejected with a ${pa.pattern}` : "rejected"} at the ${pa.rejectionTime} candle and closed back inside; ${ev.eligible ? "the trigger fired" : "the trigger is pending"}. Score ${ev.score}/100 (${ev.classification.label}).`,
      confirms,
      opposes,
      invalidation: `A trade ${long ? "below" : "above"} the swing ${long ? "low" : "high"} ${rs(s.extreme)}: the stop at ${rs(L.stop)} (swing ${long ? "−" : "+"} ${f2(L.buffer)} buffer) takes you out — the stretch is repricing, not reverting.`,
      cancel: ev.eligible
        ? `Skip the entry if the next candle opens ${long ? "below" : "above"} the stop ${rs(L.stop)}${L.chaseLimit != null ? ` or ${long ? "above" : "below"} ${rs(L.chaseLimit)} (reward/risk would drop under ${ev.minNetRR}:1)` : ""}.`
        : `Cancel if a ${tf} candle closes back ${long ? "below −2σ" : "above +2σ"}, price trades ${long ? "below" : "above"} ${rs(s.extreme)}, there's no trigger by the close of the ${ev.deadline ?? "—"} candle, the trigger candle closes ${long ? "above" : "below"} ${rs(L.chaseLimit)} (too far to chase), or the entry window closes.`,
      primaryExit: `VWAP ${rs(L.t2)} (T2). Take part at T1 ${rs(L.t1)} and move the stop to the entry${L.t3 != null ? `; T3 ${rs(L.t3)} only for a runner` : ""}. Exit everything on a ${tf} close back at VWAP, or at 15:15.`,
      eligibleNow: ev.eligible ? `Yes — ${a} at the next candle's open (≈ ${rs(roundTick(L.entry, ev.tick))}).` : `No — conditional. ${ev.why}`,
    };
  }

  if (!ev.showLevels) {
    const failed = [...ev.hardFails.map((g) => `${g.label}: ${g.reason}`), ...ev.pending.map((g) => `${g.label} (pending): ${g.reason}`)];
    const needs = [];
    const sn = setupNeeds(ev, tf);
    if (sn) needs.push(sn);
    for (const g of [...ev.hardFails, ...ev.pending]) {
      if (g.id === "rr" && L?.valid && L.qty > 0) needs.push(`At least ${f2(ev.minNetRR, 1)}:1 net to VWAP (now ${f2(L.netRR)}:1): VWAP must sit about ${rs((ev.minNetRR * L.maxLossRs + (L.chargesAtT2 ?? 0)) / L.qty + Math.abs(L.entryFill - L.entry))} per share beyond the entry (now ${rs(L.rewardPerShare)}), or a tighter stop`);
      else if (g.id === "rr") needs.push("VWAP must be beyond the entry — there is nothing to revert to");
      else if (NEEDS[g.id] && g.id !== "confirm") needs.push(NEEDS[g.id](g));
    }
    if (!ev.hardFails.length && ev.score < ev.watchAt) {
      const weak = [...ev.factors].sort((a, b2) => a.score / a.max - b2.score / b2.max).slice(0, 3).map((f) => `${f.name} ${f.score}/${f.max}`);
      needs.push(`Score must reach ${ev.watchAt} to watch and ${ev.minScore} to execute (now ${ev.score}). Weakest: ${weak.join(", ")}`);
    }
    if (ev.decision === "WATCHLIST" && ev.state === "triggered") needs.push(`A setup scoring ${ev.minScore}+ — this one triggered at ${ev.score}`);
    out.F = { score: ev.score, failed, missing: out.missing, regime: x.regime, needs: [...new Set(needs)] };
  }

  if (c.run?.open) {
    const p = c.run.open;
    out.position = { ...p, lastPrice: c.lastPrice, entryDecision: c.entryEv ? { decision: c.entryEv.decision, score: c.entryEv.score, time: c.entryEv.bar?.time } : null };
  }
  return out;
}

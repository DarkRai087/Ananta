// VWAP σ-band mean reversion: the eight-factor engine (server/vwapReversion/) on handcrafted
// sessions — setup states, levels and sizing, scoring with missing data, every mandatory gate,
// the decision, the report, and the indicator / data helpers it relies on.
import { describe, it, expect } from "vitest";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { adx, efficiencyRatio } from "../lab/indicators.js";
import { attachMarket, lineUp } from "../market/marketContext.js";
import { runSession } from "../backtest/engine.js";
import { sizeForRisk } from "../backtest/costs.js";
import { LAB } from "../config/lab.js";
import { istEpoch } from "../lab/time.js";
import { evaluate, classify } from "../vwapReversion/index.js";
import { buildReport } from "../vwapReversion/report.js";
import { tickFor, roundTick } from "../decision/util.js";
import { parseFeedTime, normalizeQuote } from "../data/quotes.js";
import strat from "../strategies/vwapBands.js";
import { makeSession } from "./helpers.js";

const DATE = "2026-10-29";
const PREV = { date: "2026-10-28", high: 1012, low: 988, close: 1000 };
const HISTORY = Array.from({ length: 20 }, (_, k) => ({ date: `2026-10-${String(k + 1).padStart(2, "0")}`, open: 1000, high: 1015, low: 985, close: 1000, volume: 1.5e6 }));

// A balanced range day (a slow sine around 1000), then three bars down into the −2σ band on
// fading volume, a hammer on climax volume (bar 53, 13:40) and a green trigger candle (bar 54).
function rangeDay({ trigger = 0.9 } = {}) {
  const vol = 20000;
  const bars = [];
  let prev = 1000;
  for (let k = 0; k < 50; k++) {
    const c = 1000 + 10 * Math.sin((2 * Math.PI * k) / 16);
    bars.push([prev, Math.max(prev, c) + 0.4, Math.min(prev, c) - 0.4, c, vol]);
    prev = c;
  }
  const push = (o, h, l, c, v) => {
    bars.push([o, h, l, c, v]);
    prev = c;
  };
  const step = (prev - 986.5) / 3;
  for (let j = 0; j < 3; j++) push(prev, prev + 0.3, prev - step - 0.2, prev - step, vol * (0.9 - j * 0.1));
  push(prev, prev + 0.3, 984.5, prev + 0.2, vol * 2.2);
  push(prev, prev + trigger + 0.15, prev - 0.1, prev + trigger, vol * 1.5);
  for (let k = bars.length; k < 75; k++) push(prev, prev + 0.8, prev - 0.8, prev + 0.4, vol);
  return bars;
}
const HAMMER = 53;
const TRIGGER = 54;

const session = (bars) => ({ ...makeSession(DATE, bars, PREV), history: HISTORY });
// Index sessions rising all day, above yesterday's close and their VWAP.
const indexSession = (base) => makeSession(DATE, Array.from({ length: 75 }, (_, k) => [base + 2 * k, base + 2 * k + 1.5, base + 2 * k - 0.5, base + 2 * k + 1]), { high: base, low: base - 50, close: base - 20 });
const withMarket = (s) => attachMarket([s], { nifty: [indexSession(20000)], sector: [indexSession(30000)], niftyId: "NIFTY50", sectorId: "NIFTYIT" })[0];

function evalAt(s, i, { params = {}, extras = {} } = {}) {
  const ctx = new BarContext(new SessionData(s, 5), { ...strat.params, ...params });
  ctx.i = i;
  return evaluate(ctx, { extras });
}
const factor = (ev, id) => ev.factors.find((f) => f.id === id);
const lineOf = (ev, id, key) => factor(ev, id).lines.find((l) => l.key === key);
const gateOf = (ev, id) => ev.gates.find((g) => g.id === id);

describe("indicators", () => {
  // Hand-worked with period 2: DMs (1,0) (1,0) (0,0.5) (1.5,0), true ranges 2, 2, 2, 3.
  const cs = [[10, 10, 8, 9], [10, 11, 9, 10.5], [10.5, 12, 10, 11.5], [11.5, 11.5, 9.5, 10], [10, 13, 10, 12.5]].map(([open, high, low, close]) => ({ open, high, low, close }));
  const r = adx(cs, 2);
  it("+DI / −DI from Wilder-smoothed directional movement", () => {
    expect(r.plusDI[1]).toBeNull();
    expect(r.plusDI[2]).toBeCloseTo(50, 9);
    expect(r.minusDI[2]).toBeCloseTo(0, 9);
    expect(r.plusDI[3]).toBeCloseTo(25, 9);
    expect(r.minusDI[3]).toBeCloseTo(12.5, 9);
    expect(r.plusDI[4]).toBeCloseTo(40, 9);
    expect(r.minusDI[4]).toBeCloseTo(5, 9);
  });
  it("ADX starts at index 2 × period − 1 as the mean DX, then Wilder-smooths", () => {
    expect(r.adx[2]).toBeNull();
    expect(r.adx[3]).toBeCloseTo((100 + 100 / 3) / 2, 9);
    expect(r.adx[4]).toBeCloseTo(((100 + 100 / 3) / 2 + 700 / 9) / 2, 9);
  });
  it("efficiency ratio: 1 for a straight line, 0 for a round trip", () => {
    expect(efficiencyRatio([1, 2, 3, 4, 5], 4)[4]).toBe(1);
    expect(efficiencyRatio([1, 2, 1, 2, 1], 4)[4]).toBe(0);
    expect(efficiencyRatio([1, 2, 3], 4)[2]).toBeNull();
  });
});

describe("setup state machine", () => {
  const s = session(rangeDay());
  it("none → armed (hammer closes back inside) → triggered → fired", () => {
    expect(evalAt(s, HAMMER - 1).state).toBe("none");
    const armed = evalAt(s, HAMMER);
    expect(armed.state).toBe("armed");
    expect(armed.side).toBe("long");
    expect(armed.setup.triggerLevel).toBe(s.candles[HAMMER].high);
    expect(evalAt(s, TRIGGER).state).toBe("triggered");
    expect(evalAt(s, TRIGGER + 1).state).toBe("fired");
  });
  it("never uses bars after i (same evaluation with the future cut off)", () => {
    const cut = { ...s, candles: s.candles.slice(0, TRIGGER + 1) };
    const a = evalAt(s, TRIGGER);
    const b = evalAt(cut, TRIGGER);
    expect(b.score).toBe(a.score);
    expect(b.levels).toEqual(a.levels);
    expect(b.decision).toBe(a.decision);
  });
});

describe("levels and sizing", () => {
  const s = session(rangeDay());
  const ev = evalAt(s, TRIGGER);
  const L = ev.levels;
  it("stop below the swing low by max(0.2 ATR, 2 ticks), on the tick", () => {
    const buffer = Math.max(0.2 * ev.indicators.atr, 2 * 0.05);
    expect(L.stop).toBe(roundTick(984.5 - buffer, 0.05, "down"));
    expect(L.stop).toBeLessThan(984.5);
  });
  it("T2 = VWAP, T1 between the entry and VWAP, entry = the trigger close", () => {
    expect(L.t2).toBe(roundTick(ev.indicators.vwap, 0.05, "down"));
    expect(L.entry).toBe(s.candles[TRIGGER].close);
    expect(L.t1).toBeGreaterThan(L.entry);
    expect(L.t1).toBeLessThan(L.t2);
  });
  it("quantity keeps the loss at the stop, charges and slippage included, within 0.5% of capital", () => {
    expect(L.qty).toBeGreaterThan(0);
    expect(L.maxLossRs).toBeLessThanOrEqual(1000);
    expect(L.qty).toBe(sizeForRisk("long", L.entryFill, L.stop, { riskRs: 1000, maxValue: 1e6, slippagePct: LAB.backtest.slippagePct }).qty);
    expect(L.netRR).toBeGreaterThan(1.5);
    expect(L.netRR).toBeLessThan(L.grossRR); // costs and slippage only ever reduce it
  });
  it("chase limit: the worst entry that still clears 1.5 : 1 net", () => {
    expect(L.chaseLimit).toBeGreaterThan(L.entry);
    expect(L.chaseLimit).toBeLessThan(L.t2);
  });
  it("a trigger candle that closes past the chase limit fails the reward / risk gate", () => {
    const far = evalAt(session(rangeDay({ trigger: 2.2 })), TRIGGER);
    expect(far.state).toBe("triggered");
    expect(far.levels.entry).toBeGreaterThan(far.levels.chaseLimit);
    expect(gateOf(far, "rr").pass).toBe(false);
    expect(far.decision).toBe("NO TRADE");
  });
  it("armed setups carry conditional levels: a stop entry one tick above the rejection high", () => {
    const a = evalAt(s, HAMMER);
    expect(a.levels.conditional).toBe(true);
    expect(a.levels.trigger).toBe(roundTick(s.candles[HAMMER].high + 0.05, 0.05, "up"));
  });
});

describe("scoring", () => {
  const s = session(rangeDay());
  it("missing data scores 0 and is listed — never positive", () => {
    const ev = evalAt(s, TRIGGER);
    for (const key of ["nifty", "sector", "rs", "breadth"]) {
      expect(lineOf(ev, "market", key).status).toBe("missing");
      expect(lineOf(ev, "market", key).points).toBe(0);
    }
    expect(lineOf(ev, "volume", "book").points).toBe(0);
    expect(lineOf(ev, "liquidity", "spread").points).toBe(0);
    expect(ev.maxAvailable).toBe(100 - 10 - 3 - 3);
    expect(ev.missing.some((m) => /Cumulative volume delta/.test(m))).toBe(true);
    expect(ev.missing.some((m) => /news/i.test(m))).toBe(true);
  });
  it("factor maxima add up to 100 and scores stay inside them", () => {
    const ev = evalAt(withMarket(session(rangeDay())), TRIGGER);
    expect(ev.factors.reduce((t, f) => t + f.max, 0)).toBe(100);
    for (const f of ev.factors) {
      expect(f.score).toBeGreaterThanOrEqual(0);
      expect(f.score).toBeLessThanOrEqual(f.max);
      expect(f.lines.reduce((t, l) => t + l.max, 0)).toBe(f.max);
    }
  });
  it("the clean hammer + trigger earns full price-action points; the trigger is worth 4 more than armed", () => {
    expect(factor(evalAt(s, TRIGGER), "priceAction").score).toBe(20);
    expect(lineOf(evalAt(s, HAMMER), "priceAction", "trigger").points).toBe(0);
    expect(lineOf(evalAt(s, HAMMER), "priceAction", "pattern").value).toMatch(/Hammer/);
  });
  it("NIFTY and the sector rising add market points; they are read only up to bar i", () => {
    const ev = evalAt(withMarket(session(rangeDay())), TRIGGER);
    expect(lineOf(ev, "market", "nifty").points).toBe(3);
    expect(lineOf(ev, "market", "sector").points).toBe(3);
    expect(factor(ev, "market").score).toBeGreaterThan(factor(evalAt(s, TRIGGER), "market").score);
  });
  it("classification bands follow the spec", () => {
    expect(classify(90).action).toBe("ELIGIBLE FOR EXECUTION");
    expect(classify(80).action).toBe("WAIT FOR CONFIRMATION");
    expect(classify(70).action).toBe("WATCHLIST");
    expect(classify(55).label).toBe("Weak");
    expect(classify(10).label).toBe("Poor");
  });
});

describe("decision", () => {
  const sm = () => withMarket(session(rangeDay()));
  it("LONG only when triggered, score ≥ minScore and every mandatory condition passes", () => {
    const ev = evalAt(sm(), TRIGGER, { params: { minScore: 70 } });
    expect(ev.hardFails).toEqual([]);
    expect(ev.score).toBeGreaterThanOrEqual(70);
    expect(ev.decision).toBe("LONG");
    expect(ev.eligible).toBe(true);
  });
  it("the same setup below the 85 default is a WATCHLIST, not a trade", () => {
    const ev = evalAt(sm(), TRIGGER);
    expect(ev.score).toBeLessThan(85);
    expect(ev.decision).toBe("WATCHLIST");
    expect(ev.eligible).toBe(false);
  });
  it("before the trigger it is never an entry, even with a low minScore", () => {
    const ev = evalAt(sm(), HAMMER, { params: { minScore: 0 } });
    expect(ev.decision).not.toBe("LONG");
    expect(gateOf(ev, "confirm").pending).toBe(true);
  });
  it("no band test → NO TRADE with no levels", () => {
    const ev = evalAt(sm(), 30);
    expect(ev.state).toBe("none");
    expect(ev.decision).toBe("NO TRADE");
    expect(ev.levels).toBeNull();
  });
  it("a scheduled event blacks the setup out", () => {
    const events = [{ date: DATE, time: "13:55", before: 15, after: 30, label: "Test policy decision" }];
    const ev = evalAt(sm(), TRIGGER, { params: { minScore: 0 }, extras: { events } });
    expect(gateOf(ev, "events").pass).toBe(false);
    expect(ev.decision).toBe("NO TRADE");
  });
  it("after the entry window closes → NO TRADE", () => {
    const ev = evalAt(sm(), TRIGGER, { params: { minScore: 0, entryEnd: "13:30" } });
    expect(gateOf(ev, "window").pass).toBe(false);
    expect(ev.decision).toBe("NO TRADE");
  });
  it("too many trades today or the daily loss limit → NO TRADE", () => {
    expect(evalAt(sm(), TRIGGER, { params: { minScore: 0 }, extras: { tradesToday: 3 } }).decision).toBe("NO TRADE");
    expect(evalAt(sm(), TRIGGER, { params: { minScore: 0 }, extras: { dayPnlRs: -2500 } }).decision).toBe("NO TRADE");
  });
  it("never fades a strong trend that rides the outer band", () => {
    // An accelerating decline rides below −2σ (z → −2.24 for a quadratic fall), then a hammer + trigger.
    const bars = [];
    let prev = 1000;
    for (let k = 0; k < 60; k++) {
      const c = 1000 - 0.02 * k * k;
      bars.push([prev, Math.max(prev, c) + 0.3, Math.min(prev, c) - 0.3, c, 20000]);
      prev = c;
    }
    bars.push([prev, prev + 0.3, prev - 3, prev + 0.2, 40000]);
    bars.push([prev + 0.2, prev + 1.2, prev + 0.1, prev + 1.1, 30000]);
    while (bars.length < 75) bars.push([prev, prev + 0.5, prev - 0.5, prev, 20000]);
    const ev = evalAt(session(bars), 61, { params: { minScore: 0, minNetRR: 0 } });
    expect(ev.state).toBe("triggered");
    expect(gateOf(ev, "trend").pass).toBe(false);
    expect(ev.decision).toBe("NO TRADE");
  });
});

describe("live quote", () => {
  const base = { fresh: true, ltp: 987.6, totBuy: 300000, totSell: 100000, bidDepth: 50000, askDepth: 100000, upperCircuit: 1080, lowerCircuit: 890 };
  it("a tight spread and a bid-heavy book add points", () => {
    const quote = { ...base, bid: 987.55, ask: 987.6, spreadPct: 0.005 };
    const a = evalAt(session(rangeDay()), TRIGGER);
    const b = evalAt(session(rangeDay()), TRIGGER, { extras: { quote } });
    expect(lineOf(b, "volume", "book").points).toBe(3);
    expect(lineOf(b, "liquidity", "spread").points).toBe(3);
    expect(b.score).toBe(a.score + 6);
  });
  it("a wide spread fails the execution gate", () => {
    const ev = evalAt(session(rangeDay()), TRIGGER, { params: { minScore: 0 }, extras: { quote: { ...base, bid: 985, ask: 990, spreadPct: 0.506 } } });
    expect(gateOf(ev, "spread").pass).toBe(false);
    expect(ev.decision).toBe("NO TRADE");
  });
  it("price near a circuit limit fails the execution gate", () => {
    const ev = evalAt(session(rangeDay()), TRIGGER, { params: { minScore: 0 }, extras: { quote: { ...base, bid: 987.55, ask: 987.6, spreadPct: 0.005, lowerCircuit: 980 } } });
    expect(gateOf(ev, "circuit").pass).toBe(false);
  });
  it("account risk above 0.5% is capped and the cap is reported", () => {
    const ev = evalAt(session(rangeDay()), TRIGGER, { extras: { account: { capital: 100000, riskPct: 2, leverage: 5 } } });
    expect(ev.risk.riskPct).toBe(0.5);
    expect(ev.risk.riskRs).toBe(500);
    expect(ev.risk.notes[0]).toMatch(/capped/);
  });
});

describe("strategy and backtest", () => {
  it("onBar enters only on the trigger bar, with the engine's stop and VWAP target", () => {
    const s = withMarket(session(rangeDay()));
    const ctx = new BarContext(new SessionData(s, 5), { ...strat.params, minScore: 70 });
    ctx.i = HAMMER;
    expect(strat.onBar(ctx)).toBeNull();
    ctx.i = TRIGGER;
    const sig = strat.onBar(ctx);
    const ev = evalAt(s, TRIGGER, { params: { minScore: 70 } });
    expect(sig.side).toBe("long");
    expect(sig.stop).toBe(ev.levels.stop);
    expect(sig.target).toBe(ev.levels.t2);
  });
  it("the backtest fills at the next open and keeps the engine's rules", () => {
    const s = withMarket(session(rangeDay()));
    const r = runSession({ session: s, symbol: "T", strategy: strat, params: { ...strat.params, minScore: 70 }, settings: LAB.backtest, intervalMin: 5 });
    expect(r.trades.length).toBe(1);
    const t = r.trades[0];
    expect(t.side).toBe("long");
    expect(t.entryTime).toBe(s.candles[TRIGGER + 1].time);
    expect(t.entry).toBeCloseTo(s.candles[TRIGGER + 1].open * (1 + LAB.backtest.slippagePct / 100), 6);
  });
  it("at the default 85 the same day takes no trade", () => {
    const s = withMarket(session(rangeDay()));
    expect(runSession({ session: s, symbol: "T", strategy: strat, params: strat.params, settings: LAB.backtest, intervalMin: 5 }).trades).toEqual([]);
  });
});

describe("report", () => {
  const ctx = { symbol: "T", interval: "5m", phase: "live", label: "test", params: strat.params };
  it("LONG carries every trade number and the explanation", () => {
    const r = buildReport(evalAt(withMarket(session(rangeDay())), TRIGGER, { params: { minScore: 70 } }), ctx);
    expect(r.decision).toBe("LONG");
    for (const k of ["trigger", "expectedEntry", "stop", "t1", "t2", "riskPerShare", "qty", "exposure", "maxRisk", "grossRR", "netRR"]) expect(r.D[k]).not.toBeNull();
    expect(r.D.status).toBe("ACTIVE");
    expect(r.E.eligibleNow).toMatch(/^Yes/);
    expect(r.B.bands.map((b) => b.label)).toEqual(["+3σ", "+2σ", "+1σ", "VWAP", "−1σ", "−2σ", "−3σ"]);
    expect(r.C).toHaveLength(7);
  });
  it("WATCHLIST before the trigger shows the levels as CONDITIONAL", () => {
    const r = buildReport(evalAt(withMarket(session(rangeDay())), HAMMER), ctx);
    expect(r.decision).toBe("WATCHLIST");
    expect(r.D.status).toBe("CONDITIONAL");
    expect(r.E.eligibleNow).toMatch(/^No/);
  });
  it("NO TRADE carries no entry, stop, target or quantity — only what has to change", () => {
    const r = buildReport(evalAt(withMarket(session(rangeDay())), 30), ctx);
    expect(r.decision).toBe("NO TRADE");
    expect(r.D).toBeUndefined();
    expect(r.F.needs.length).toBeGreaterThan(0);
    expect(r.F.needs[0]).toMatch(/test a band/);
  });
});

describe("helpers", () => {
  it("NSE tick sizes by price, and rounding to the tick", () => {
    expect(tickFor(240)).toBe(0.01);
    expect(tickFor(963)).toBe(0.05);
    expect(tickFor(1153)).toBe(0.1);
    expect(tickFor(1153, 0.05)).toBe(0.05);
    expect(roundTick(1153.27, 0.1, "down")).toBe(1153.2);
    expect(roundTick(1153.21, 0.1, "up")).toBe(1153.3);
    expect(roundTick(0.3, 0.1, "up")).toBe(0.3);
  });
  it("quote feed time is IST", () => {
    expect(parseFeedTime("30-Oct-2026 13:41:09")).toBe(istEpoch("2026-10-30", "13:41") + 9);
    expect(parseFeedTime("garbage")).toBeNull();
  });
  it("normalizes a SmartAPI FULL quote", () => {
    const t = istEpoch("2026-10-30", "13:41") + 9;
    const q = normalizeQuote(
      { tradingSymbol: "SBIN-EQ", ltp: 963.65, close: 971.9, exchFeedTime: "30-Oct-2026 13:41:09", totBuyQuan: 10, totSellQuan: 20, upperCircuit: 1069, lowerCircuit: 874, depth: { buy: [{ price: 963.6, quantity: 5 }, { price: 963.5, quantity: 7 }], sell: [{ price: 963.7, quantity: 3 }] } },
      t + 30,
      120,
    );
    expect(q.symbol).toBe("SBIN");
    expect(q.bid).toBe(963.6);
    expect(q.ask).toBe(963.7);
    expect(q.spreadPct).toBeCloseTo((0.1 / 963.65) * 100, 6);
    expect(q.bidDepth).toBe(12);
    expect(q.fresh).toBe(true);
    expect(normalizeQuote({ ...{ depth: { buy: [{ price: 1 }], sell: [{ price: 2 }] } }, exchFeedTime: "30-Oct-2026 13:41:09" }, t + 600, 120).fresh).toBe(false);
  });
  it("index bars line up with the latest bar that started at or before each stock bar", () => {
    const stock = makeSession(DATE, [[1, 1, 1, 1], [1, 1, 1, 1], [1, 1, 1, 1]]);
    const t0 = istEpoch(DATE, "09:15");
    const ix = { date: DATE, prev: { close: 9 }, candles: [{ time: t0, open: 10, high: 10, low: 10, close: 10 }, { time: t0 + 600, open: 11, high: 11, low: 11, close: 11 }] };
    expect(lineUp(stock, ix, "NIFTY50").map).toEqual([0, 0, 1]);
  });
});

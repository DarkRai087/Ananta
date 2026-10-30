// Opening Range Breakout: the multi-factor engine (server/orbEngine/) on handcrafted sessions —
// opening-range stats against history, the three entry models, failed / chased / wick-only
// breakouts, levels and sizing, scoring with missing data, the decision, the backtest and the report.
import { describe, it, expect } from "vitest";
import { buildSessions, sessionProfile } from "../lab/sessions.js";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { macd } from "../lab/indicators.js";
import { attachMarket } from "../market/marketContext.js";
import { runSession } from "../backtest/engine.js";
import { LAB } from "../config/lab.js";
import { istEpoch } from "../lab/time.js";
import { evaluate } from "../orbEngine/index.js";
import { buildOrbReport } from "../orbEngine/report.js";
import strat from "../strategies/orb.js";
import { makeCandles, makeSession } from "./helpers.js";

const VOL = 30000;
const DATES = ["2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08", "2026-10-09", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16", "2026-10-19", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26", "2026-10-27", "2026-10-28"];
const TODAY = "2026-10-29";

// History (17 sessions): a 15-minute opening range of width 1.0 … 1.96 around 100 on double volume, then a slow
// swing of ±2 (a typical daily range of about 4.4) on normal volume.
function historyDay(d) {
  const w = 1 + 0.06 * d;
  const bars = [];
  for (let k = 0; k < 3; k++) bars.push([100, 100 + w / 2, 100 - w / 2, 100, 2 * VOL]);
  let prev = 100;
  for (let k = 3; k < 75; k++) {
    const c = 100 + 2 * Math.sin((2 * Math.PI * (k - 3)) / 36);
    bars.push([prev, Math.max(prev, c) + 0.1, Math.min(prev, c) - 0.1, c, VOL]);
    prev = c;
  }
  return bars;
}

// Yesterday for the clean cases: a wide 99.5–110 day back to 100, so PDH (110) and the pivots
// (103 / 107) sit well above today's breakout. (The plain history day leaves PDH and R1 just above
// the entry — the structure-cap test uses that.)
function wideDay() {
  const bars = historyDay(DATES.length - 1).slice(0, 3);
  let prev = 100;
  for (let k = 3; k < 75; k++) {
    const c = 100 + 10 * Math.sin((Math.PI * (k - 3)) / 71);
    bars.push([prev, Math.max(prev, c) + 0.1, Math.min(prev, c) - 0.1, c, VOL]);
    prev = c;
  }
  return bars;
}

// Today: a 99.25–100.75 range (width 1.5, mid-history), then `after` bars from 09:30.
function today(after) {
  const bars = [
    [100, 100.75, 99.6, 100.2, 2 * VOL],
    [100.2, 100.6, 99.25, 100.4, 2 * VOL],
    [100.4, 100.7, 99.9, 100.5, 2 * VOL],
    ...after,
  ];
  let prev = bars[bars.length - 1][3];
  while (bars.length < 75) {
    bars.push([prev, prev + 0.15, prev - 0.15, prev + 0.02, VOL]);
    prev += 0.02;
  }
  return bars;
}

// Breakout at 09:30 (bar 3) on 1.3× volume, then the next candle holds above ORH → model A at bar 4.
const MODEL_A = [
  [100.5, 101.3, 100.45, 101.2, 1.3 * VOL],
  [101.2, 101.5, 101.0, 101.4, 1.2 * VOL],
];

function sessionsFor(after, { capped = false } = {}) {
  const last = DATES.length - 1;
  const candles = [...DATES.flatMap((d, k) => makeCandles(d, k === last && !capped ? wideDay() : historyDay(k))), ...makeCandles(TODAY, today(after))];
  return buildSessions(candles);
}
const todayOf = (after, opts) => sessionsFor(after, opts).find((s) => s.date === TODAY);

// Index sessions rising all day, above yesterday's close and their VWAP.
const indexSession = (base) => makeSession(TODAY, Array.from({ length: 75 }, (_, k) => [base + 2 * k, base + 2 * k + 1.5, base + 2 * k - 0.5, base + 2 * k + 1]), { high: base, low: base - 50, close: base - 20 });
const withMarket = (s) => attachMarket([s], { nifty: [indexSession(20000)], sector: [indexSession(30000)], niftyId: "NIFTY50", sectorId: "NIFTYIT" })[0];

function evalAt(s, i, { params = {}, extras = {} } = {}) {
  const ctx = new BarContext(new SessionData(s, 5), { ...strat.params, ...params });
  ctx.i = i;
  return evaluate(ctx, { extras });
}
const fac = (ev, id) => ev.factors.find((f) => f.id === id);
const lineOf = (ev, id, key) => fac(ev, id).lines.find((l) => l.key === key);
const gateOf = (ev, id) => ev.gates.find((g) => g.id === id);

describe("opening profile and indicators", () => {
  it("sessionProfile keeps OR widths, OR volume and volume / range by minute — never candles", () => {
    const p = sessionProfile(DATES[0], makeCandles(DATES[0], historyDay(0)));
    expect(p.or[15].width).toBeCloseTo(1, 9);
    expect(p.or[15].volume).toBe(6 * VOL);
    expect(p.or[5].width).toBeCloseTo(1, 9);
    expect(p.vol[9 * 60 + 30]).toBe(VOL);
    expect(Object.keys(p).sort()).toEqual(["date", "or", "rng", "vol"]);
  });
  it("each session sees only earlier sessions' profiles", () => {
    const ss = sessionsFor(MODEL_A);
    const t = ss.find((s) => s.date === TODAY);
    expect(t.profile).toHaveLength(DATES.length);
    expect(t.profile.every((p) => p.date < TODAY)).toBe(true);
  });
  it("MACD: a straight line has a constant fast − slow gap and a zero histogram", () => {
    const m = macd(Array.from({ length: 40 }, (_, k) => 100 + k), 3, 5, 2);
    expect(m.macd[3]).toBeNull();
    expect(m.macd[4]).toBeCloseTo(1, 9);
    expect(m.signal[4]).toBeNull();
    expect(m.hist[10]).toBeCloseTo(0, 9);
  });
});

describe("opening range", () => {
  const ev = evalAt(todayOf(MODEL_A), 2);
  it("is not judged before it completes", () => {
    const early = evalAt(todayOf(MODEL_A), 1);
    expect(early.state).toBe("forming");
    expect(early.decision).toBe("NO TRADE");
  });
  it("ORH / ORL / ORM / width and its percentile among earlier sessions", () => {
    expect(ev.or.high).toBe(100.75);
    expect(ev.or.low).toBe(99.25);
    expect(ev.or.mid).toBe(100);
    expect(ev.or.width).toBeCloseTo(1.5, 9);
    expect(ev.or.historyN).toBe(17);
    expect(ev.or.percentile).toBeCloseTo((9 / 17) * 100, 6); // widths 1.0 … 1.96: nine narrower than 1.5
    expect(ev.details.range.classification).toBe("Normal");
  });
  it("relative volume compares with the same time of day", () => {
    const ev4 = evalAt(todayOf(MODEL_A), 4);
    expect(ev4.details.volume.breakout.source).toBe("time-of-day");
    expect(ev4.details.volume.breakout.value).toBeCloseTo(1.3, 9);
  });
});

describe("entry models", () => {
  it("model A: a close above ORH, then a candle that holds → triggered on the acceptance candle", () => {
    const s = todayOf(MODEL_A);
    expect(evalAt(s, 3).state).toBe("broken");
    const ev = evalAt(s, 4);
    expect(ev.state).toBe("triggered");
    expect(ev.setup.model).toBe("A");
    expect(ev.side).toBe("long");
    expect(evalAt(s, 5).state).toBe("fired");
  });
  it("model C: a strong candle on heavy volume triggers on the breakout candle itself", () => {
    const ev = evalAt(todayOf([[100.5, 101.25, 100.45, 101.2, 2.5 * VOL]]), 3);
    expect(ev.state).toBe("triggered");
    expect(ev.setup.model).toBe("C");
  });
  it("model B: a rejected retest of ORH, then a close above the retest candle's high", () => {
    const after = [
      [100.5, 101.3, 100.45, 101.2, 1.3 * VOL],
      [101.2, 101.25, 100.8, 101.1, 0.7 * VOL], // back to the level, held, closed in the upper half
      [101.0, 101.5, 100.95, 101.45, 1.2 * VOL], // closes above the retest candle's high
    ];
    const s = todayOf(after);
    const ev = evalAt(s, 5, { params: { models: "retest" } });
    expect(ev.state).toBe("triggered");
    expect(ev.setup.model).toBe("B");
    expect(ev.setup.retest.r).toBe(4);
    expect(lineOf(ev, "volume", "follow").points).toBe(3); // a quiet retest
  });
  it("a close back inside the range fails the breakout — no entry, no automatic reversal", () => {
    const ev = evalAt(todayOf([[100.5, 101.3, 100.45, 101.2, 1.3 * VOL], [101.2, 101.2, 99.9, 100.0, 1.5 * VOL]]), 4);
    expect(ev.state).toBe("failed");
    expect(ev.decision).toBe("NO TRADE");
    expect(ev.otherSide.state).toBe("inside");
    expect(gateOf(ev, "failed").pass).toBe(false);
  });
  it("wicks through ORH without a close are not a breakout", () => {
    const ev = evalAt(todayOf([[100.5, 101.0, 100.3, 100.6, VOL], [100.6, 101.1, 100.4, 100.7, VOL]]), 4);
    expect(ev.state).toBe("inside");
    expect(ev.setup.wickBreaks).toBe(2);
    expect(ev.levels).toBeNull();
  });
  it("an entry more than 1 ATR beyond ORH is a chase: skipped", () => {
    const ev = evalAt(todayOf([[100.5, 103.2, 100.45, 103.1, 2.5 * VOL], [103.1, 103.4, 103.0, 103.3, VOL]]), 4);
    expect(ev.state).not.toBe("triggered");
    expect(ev.setup.extended.length).toBeGreaterThan(0);
  });
  it("never uses bars after i", () => {
    const s = todayOf(MODEL_A);
    const a = evalAt(s, 4);
    const b = evalAt({ ...s, candles: s.candles.slice(0, 5) }, 4);
    expect(b.score).toBe(a.score);
    expect(b.levels).toEqual(a.levels);
  });
});

describe("levels", () => {
  const ev = evalAt(withMarket(todayOf(MODEL_A)), 4);
  const L = ev.levels;
  it("stop: the tighter of the breakout candle's low and ORM, minus the ATR buffer", () => {
    expect(L.stopBasis).toMatch(/breakout candle/);
    expect(L.stop).toBeLessThan(100.45);
    expect(L.stop).toBeGreaterThan(100);
  });
  it("targets: the nearest of range projection, structure and the volatility cap", () => {
    expect(L.t1).toBeLessThanOrEqual(L.projections.p1 + 1e-9);
    expect(L.t1).toBeGreaterThan(L.entry);
    if (L.t2 != null) expect(L.t2).toBeGreaterThan(L.t1);
    expect(L.volCap).toBeGreaterThan(L.entry);
  });
  it("size keeps the loss at the stop within 0.5% of capital, charges included", () => {
    expect(L.qty).toBeGreaterThan(0);
    expect(L.maxLossRs).toBeLessThanOrEqual(1000);
    expect(L.netRR).toBeLessThan(L.grossRR);
  });
  it("a previous-day high or pivot just above the entry caps the targets — and the trade fails 1.5 : 1", () => {
    const ev = evalAt(withMarket(todayOf(MODEL_A, { capped: true })), 4, { params: { minScore: 0 } });
    expect(ev.levels.t1Why).toMatch(/structure/);
    expect(ev.levels.t1).toBeLessThan(ev.levels.projections.p1);
    expect(gateOf(ev, "rr").pass).toBe(false);
    expect(ev.decision).toBe("NO TRADE");
  });
  it("a spent day (range ≥ the typical daily range) fails", () => {
    const big = evalAt(withMarket(todayOf([[100.5, 106, 100.45, 101.2, 1.3 * VOL], [101.2, 101.5, 101.0, 101.4, 1.2 * VOL]])), 4);
    expect(gateOf(big, "consumed").pass).toBe(false);
    expect(big.decision).toBe("NO TRADE");
  });
});

describe("scoring and decision", () => {
  it("missing data scores 0 and is listed", () => {
    const ev = evalAt(todayOf(MODEL_A), 4);
    for (const [f, k] of [["market", "nifty"], ["market", "vix"], ["market", "breadth"], ["strength", "spread"]]) {
      expect(lineOf(ev, f, k).status).toBe("missing");
      expect(lineOf(ev, f, k).points).toBe(0);
    }
    expect(ev.missing.some((m) => /global/i.test(m))).toBe(true);
  });
  it("eight factors add up to 100", () => {
    const ev = evalAt(withMarket(todayOf(MODEL_A)), 4);
    expect(ev.factors.reduce((t, f) => t + f.max, 0)).toBe(100);
    for (const f of ev.factors) expect(f.lines.reduce((t, l) => t + l.max, 0)).toBe(f.max);
  });
  it("LONG only when triggered, score ≥ minScore and every mandatory condition passes", () => {
    const ev = evalAt(withMarket(todayOf(MODEL_A)), 4, { params: { minScore: 60 } });
    expect(ev.hardFails).toEqual([]);
    expect(ev.decision).toBe("LONG");
    const strict = evalAt(withMarket(todayOf(MODEL_A)), 4);
    expect(strict.score).toBeLessThan(85);
    expect(strict.eligible).toBe(false);
  });
  it("after the entry window → NO TRADE", () => {
    const ev = evalAt(withMarket(todayOf(MODEL_A)), 4, { params: { minScore: 0, entryEnd: "09:30" } });
    expect(gateOf(ev, "window").pass).toBe(false);
    expect(ev.decision).toBe("NO TRADE");
  });
  it("weak breakout volume fails the volume condition", () => {
    const ev = evalAt(withMarket(todayOf([[100.5, 101.3, 100.45, 101.2, 0.5 * VOL], [101.2, 101.5, 101.0, 101.4, VOL]])), 4, { params: { minScore: 0 } });
    expect(gateOf(ev, "volume").pass).toBe(false);
    expect(ev.decision).toBe("NO TRADE");
  });
  it("a scheduled event blacks the breakout out", () => {
    const ev = evalAt(withMarket(todayOf(MODEL_A)), 4, { params: { minScore: 0 }, extras: { events: [{ date: TODAY, time: "09:45", before: 15, after: 30, label: "Test event" }] } });
    expect(gateOf(ev, "events").pass).toBe(false);
  });
  it("India VIX and breadth add points live", () => {
    const base = evalAt(withMarket(todayOf(MODEL_A)), 4);
    const live = evalAt(withMarket(todayOf(MODEL_A)), 4, { extras: { vix: { ltp: 14, prevClose: 14.2 }, breadth: { advances: 35, declines: 15, unchanged: 0, coverage: 1 } } });
    expect(live.score).toBe(base.score + 3);
  });
});

describe("strategy and backtest", () => {
  it("enters at the next open on the trigger, exits when price closes back inside the range", () => {
    const after = [...MODEL_A, [101.4, 101.5, 101.3, 101.45, VOL], [101.45, 101.5, 100.3, 100.4, 2 * VOL]];
    const s = withMarket(todayOf(after));
    const r = runSession({ session: s, symbol: "T", strategy: strat, params: { ...strat.params, minScore: 60 }, settings: LAB.backtest, intervalMin: 5 });
    expect(r.trades).toHaveLength(1);
    const t = r.trades[0];
    expect(t.entryTime).toBe(istEpoch(TODAY, "09:40"));
    expect(t.signal).toMatch(/ORB model A/);
    expect(["signal", "stop"]).toContain(t.reason);
  });
  it("at the default 85 the same day takes no trade", () => {
    const r = runSession({ session: withMarket(todayOf(MODEL_A)), symbol: "T", strategy: strat, params: strat.params, settings: LAB.backtest, intervalMin: 5 });
    expect(r.trades).toEqual([]);
  });
});

describe("report", () => {
  const c = { symbol: "T", interval: "5m", phase: "live", label: "test", params: strat.params };
  it("LONG shows every trading parameter and the 12-point explanation", () => {
    const r = buildOrbReport(evalAt(withMarket(todayOf(MODEL_A)), 4, { params: { minScore: 60 } }), c);
    expect(r.decision).toBe("LONG");
    for (const k of ["trigger", "expectedEntry", "stop", "t1", "riskPerShare", "capital", "riskPct", "riskRs", "qty", "exposure", "chargesAtTarget", "netRR"]) expect(r.F[k]).not.toBeNull();
    expect(r.F.status).toBe("ACTIVE");
    expect(Object.keys(r.G)).toHaveLength(12);
    expect(r.B.classification).toBe("Normal");
    expect(r.E).toHaveLength(8);
  });
  it("NO TRADE carries no entry, stop, target or quantity — only the failed conditions and what has to change", () => {
    const r = buildOrbReport(evalAt(withMarket(todayOf([[100.5, 101.3, 100.45, 101.2, 1.3 * VOL], [101.2, 101.2, 99.9, 100.0, 1.5 * VOL]])), 4), c);
    expect(r.decision).toBe("NO TRADE");
    expect(r.F).toBeUndefined();
    expect(r.H.failed.length).toBeGreaterThan(0);
    expect(r.H.needs.length).toBeGreaterThan(0);
  });
});

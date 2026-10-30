// Prediction module: scoring rules, model sanity, and the walk-forward runners.
import { describe, it, expect } from "vitest";
import { summarize, callOf, ensembleScore } from "../prediction/evaluate.js";
import { runDaily } from "../prediction/runDaily.js";
import { runIntraday } from "../prediction/runIntraday.js";
import { DAILY_MODELS, INTRADAY_MODELS } from "../prediction/models/index.js";
import { buildSessions } from "../lab/sessions.js";
import { makeCandles, randomSessions, mulberry32 } from "./helpers.js";

const dailyFrom = (closes) =>
  closes.map((c, k) => ({ time: 1_600_000_000 + k * 86400, open: c, high: c * 1.002, low: c * 0.998, close: c, volume: 1000 }));

describe("scoring", () => {
  it("callOf uses the neutral band", () => {
    expect(callOf(0.5, 0.2)).toBe(1);
    expect(callOf(-0.5, 0.2)).toBe(-1);
    expect(callOf(0.1, 0.2)).toBe(0);
    expect(callOf(null)).toBeNull();
  });

  it("hit rate vs the always-the-usual-direction baseline", () => {
    // 10 days: 6 up, 4 down. The model calls 4 days and gets 3 right.
    const s = [
      { call: 1, fwd: 0.01 }, { call: 1, fwd: 0.02 }, { call: -1, fwd: -0.01 }, { call: -1, fwd: 0.01 },
      { call: 0, fwd: 0.01 }, { call: 0, fwd: 0.01 }, { call: 0, fwd: 0.01 }, { call: 0, fwd: -0.01 }, { call: 0, fwd: -0.02 }, { call: 0, fwd: -0.01 },
    ];
    const r = summarize(s, { minCalls: 1 });
    expect(r.calls).toBe(4);
    expect(r.hitRate).toBeCloseTo(0.75);
    expect(r.baseline).toBeCloseTo(0.6); // always bullish: right on 6 of 10 days
    expect(r.edge).toBeCloseTo(0.15);
    expect(r.bullCalls).toBe(2);
    expect(r.avgBullPct).toBeCloseTo(1.5);
  });

  it("too few calls is 'insufficient', not an edge", () => {
    expect(summarize([{ call: 1, fwd: 0.01 }], { minCalls: 5 }).verdict).toBe("insufficient");
  });

  it("ensemble skips missing scores and zero weights", () => {
    expect(ensembleScore({ a: 1, b: -0.5, c: null, d: 1 }, { a: 1, b: 1, c: 1, d: 0 })).toBeCloseTo(0.25);
  });
});

describe("daily models", () => {
  const up = dailyFrom(Array.from({ length: 300 }, (_, k) => 100 * 1.003 ** k));
  const down = dailyFrom(Array.from({ length: 300 }, (_, k) => 100 * 0.997 ** k));

  it.each(DAILY_MODELS.map((m) => [m.id, m]))("%s returns a score in [-1, 1] or null", (_id, m) => {
    const r = m.predict(up.slice(-m.lookback(m.params)), m.params);
    if (r) {
      expect(r.score).toBeGreaterThanOrEqual(-1);
      expect(r.score).toBeLessThanOrEqual(1);
      expect(Array.isArray(r.reasons)).toBe(true);
    }
  });

  it("trend is fully bullish in a steady uptrend and bearish in a downtrend", () => {
    const t = DAILY_MODELS.find((m) => m.id === "trend");
    expect(t.predict(up, t.params).score).toBe(1);
    expect(t.predict(down, t.params).score).toBe(-1);
  });

  it("a market that only goes up gives 'always bullish' no edge", () => {
    const r = runDaily(up);
    const e = r.models.find((m) => m.id === "trend").eval["5d"];
    expect(e.hitRate).toBe(1);
    expect(e.baseline).toBe(1);
    expect(e.verdict).not.toBe("edge");
  });

  it("finds a real edge: short-term reversal in a zig-zag market", () => {
    // +2%, −1.9%, +2%, −1.9% … with noise: each up day is followed by a down day.
    const rnd = mulberry32(3);
    const closes = [100];
    for (let k = 1; k < 900; k++) closes.push(closes[k - 1] * (1 + (k % 2 ? 0.02 : -0.019) + (rnd() - 0.5) * 0.004));
    const r = runDaily(dailyFrom(closes));
    expect(r.models.find((m) => m.id === "meanReversion").eval["1d"].verdict).toBe("edge");
  });

  it("index trend reads the index, never days after the call", () => {
    const share = dailyFrom(Array.from({ length: 400 }, (_, k) => 100 + Math.sin(k / 7) * 4));
    const idx = dailyFrom(Array.from({ length: 400 }, (_, k) => 200 + k * 0.2));
    const a = runDaily(share.slice(0, 300), { index: { name: "IX", bars: idx } });
    const b = runDaily(share.slice(0, 300), { index: { name: "IX", bars: idx.slice(0, 300) } });
    expect(a.models.find((m) => m.id === "indexTrend").eval).toEqual(b.models.find((m) => m.id === "indexTrend").eval);
    expect(a.models.find((m) => m.id === "indexTrend").now.call).toBe("bullish");
  });

  it("the live call on a partial bar doesn't change the test", () => {
    const bars = dailyFrom(Array.from({ length: 400 }, (_, k) => 100 + Math.sin(k / 9) * 5 + k * 0.01));
    const a = runDaily(bars.slice(0, -1));
    const b = runDaily(bars, { partial: true });
    expect(b.models.map((m) => m.eval)).toEqual(a.models.map((m) => m.eval));
  });
});

describe("intraday runner", () => {
  const days = randomSessions(60, 21);
  const sessions = buildSessions(days.flatMap((d) => makeCandles(d.date, d.bars))).slice(1);

  it("tests every past session at the same time of day and calls today", () => {
    const today = { ...sessions[sessions.length - 1] };
    today.candles = today.candles.slice(0, 12); // 09:15–10:15 done
    // A second random series stands in for the share's index.
    const ixSessions = buildSessions(randomSessions(60, 99).flatMap((d) => makeCandles(d.date, d.bars))).slice(1);
    const index = { name: "TEST INDEX", byDate: new Map(ixSessions.map((x) => [x.date, x])) };
    const r = runIntraday({ past: sessions.slice(0, -1), today, cut: 10 * 60 + 15, intervalMin: 5, index });
    expect(r.models.find((m) => m.id === "indexTrend").now.reasons.join(" ")).toContain("TEST INDEX");
    expect(r.sessionsTested).toBe(sessions.length - 1);
    expect(r.checkpoint).toBe("10:15");
    expect(r.models.map((m) => m.id)).toEqual(INTRADAY_MODELS.map((m) => m.id));
    for (const m of [...r.models, r.combined]) {
      expect(m.eval.samples).toBeGreaterThan(0);
      if (m.now.score != null) expect(["bullish", "bearish", "neutral"]).toContain(m.now.call);
    }
  });
});

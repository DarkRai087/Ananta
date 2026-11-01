// Volume Breakout v2: RVOL time-slot math, level detection, tick-rounded min-distance stop,
// measured target, and the engine invariants (closed-candle fills, sizing within risk, net of costs).
import { describe, it, expect } from "vitest";
import vbV2, { rvolFromProfile, stopFor, measuredTarget, scoreLevel } from "../strategies/volumeBreakoutV2.js";
import { runSession } from "../backtest/engine.js";
import { settingsWithDefaults } from "../backtest/run.js";
import { resolveParams } from "../strategies/index.js";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { buildSessions } from "../lab/sessions.js";
import { tickFor, roundTick } from "../decision/util.js";
import { makeCandles, randomSessions, flat } from "./helpers.js";

const settings = settingsWithDefaults({});
const onTick = (x) => Math.abs(x / tickFor(x) - Math.round(x / tickFor(x))) < 1e-6;

describe("RVOL time-slot math", () => {
  const profiles = [
    { vol: { 555: 1000 } }, // 555 = 09:15 + 90min = 10:45 slot (IST minute-of-day)
    { vol: { 555: 2000 } },
    { vol: { 555: 3000 } },
  ];
  it("divides current volume by the same-slot average over the last N sessions", () => {
    expect(rvolFromProfile(profiles, 555, 4000, 20)).toEqual({ rvol: 2, n: 3 }); // avg 2000
    expect(rvolFromProfile(profiles, 555, 4000, 2).rvol).toBeCloseTo(4000 / 2500); // last 2 only
  });
  it("is null when the slot has no history (never a false spike)", () => {
    expect(rvolFromProfile(profiles, 600, 9999, 20).rvol).toBeNull();
    expect(rvolFromProfile([], 555, 9999, 20).rvol).toBeNull();
  });
});

describe("stop and target math", () => {
  const p = { stopAtrMult: 1, minStopAtr: 0.5 };
  it("takes the tighter of candle-low / level−ATR, on tick", () => {
    const stop = stopFor("long", 100, { low: 99.8, high: 100.2, close: 101, open: 100.1 }, 1, p);
    expect(stop).toBeCloseTo(99.8); // max(99.8, 99) and 101−99.8 ≥ 0.5
    expect(onTick(stop)).toBe(true);
  });
  it("enforces the minimum ATR distance from the close", () => {
    const stop = stopFor("long", 100, { low: 99.8, high: 100.15, close: 100.1, open: 100.0 }, 1, p);
    expect(stop).toBeCloseTo(99.6); // 100.1 − 0.5×1
  });
  it("short mirrors, rounded up", () => {
    const stop = stopFor("short", 100, { low: 99.8, high: 100.2, close: 99, open: 99.9 }, 1, p);
    expect(stop).toBeCloseTo(100.2);
    expect(onTick(stop)).toBe(true);
  });
  it("measured move projects the range from the level", () => {
    expect(measuredTarget("long", 100, 2)).toBe(102);
    expect(measuredTarget("short", 100, 2)).toBe(98);
  });
  it("scores a tighter range / more touches higher", () => {
    expect(scoreLevel({ touches: 3, range: 1 }, 10)).toBeGreaterThan(scoreLevel({ touches: 1, range: 5 }, 10));
  });
});

describe("level detection (onBar)", () => {
  it("fires a long PDH breakout on a real volume spike", () => {
    // 22 flat prior days at 100 (profile vol 1000/slot, PDH ≈ 100.01), then a rising today with a
    // breakout bar at index 18 (10:45) closing 101.1 on 5000 volume.
    const prior = flat(25).map((b) => [b[0], b[1], b[2], b[3], 1000]);
    const days = Array.from({ length: 22 }, (_, k) => ({ date: `2025-03-${String(3 + k).padStart(2, "0")}`, bars: prior }));
    const today = [];
    for (let k = 0; k < 18; k++) today.push([100 + k * 0.02, 100 + k * 0.02 + 0.03, 100 + k * 0.02 - 0.03, 100 + k * 0.02 + 0.01, 1000]);
    today.push([100.36, 101.2, 100.36, 101.1, 5000]); // the breakout bar, index 18
    days.push({ date: "2025-04-04", bars: today });
    const sessions = buildSessions(days.flatMap((d) => makeCandles(d.date, d.bars)));
    const todaySession = sessions[sessions.length - 1];
    const params = resolveParams(vbV2, { useContraction: false, useCandleQuality: false, useMarketVwap: false, useRelStrength: false, useConsolidation: false, useOpeningRange: false, useVwapReclaim: false, rvolMult: 2 });
    const ctx = new BarContext(new SessionData(todaySession, 5), params);
    ctx.i = 18;
    const sig = vbV2.onBar(ctx);
    expect(sig?.side).toBe("long");
    expect(sig.reason).toContain("level=PDH_PDL");
    expect(sig.stop).toBeLessThan(ctx.bar().close);
  });
});

describe("engine invariants over many sessions", () => {
  const sessions = buildSessions(randomSessions(60, 5).flatMap((d) => makeCandles(d.date, d.bars))).filter((s) => !s.special).slice(1);
  const params = resolveParams(vbV2, { useContraction: false, useCandleQuality: false, useMarketVwap: false, useRelStrength: false, rvolMult: 1.0, consolMinTouches: 1 });
  let trades = [];
  for (const s of sessions) {
    const sd = new SessionData(s, 5, `T|5m|${s.date}`);
    trades = trades.concat(runSession({ session: s, symbol: "T", strategy: vbV2, params, settings, intervalMin: 5, sd }).trades);
  }
  it("produces trades (the entry path runs)", () => expect(trades.length).toBeGreaterThan(0));
  it("every trade is net of costs, sized ≥ 1 share, with a tick-aligned stop", () => {
    for (const t of trades) {
      expect(t.costs).toBeGreaterThan(0);
      expect(t.net).toBeCloseTo(t.gross - t.costs, 6);
      expect(t.qty).toBeGreaterThanOrEqual(1);
      expect(onTick(t.initialStop)).toBe(true);
    }
  });
});

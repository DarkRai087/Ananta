import { describe, it, expect } from "vitest";
import { runSession } from "../backtest/engine.js";
import { tradeCosts, sizeForRisk } from "../backtest/costs.js";
import { metrics, winRange } from "../backtest/metrics.js";
import { LAB } from "../config/lab.js";
import { istHHMM } from "../lab/time.js";
import { makeSession, flat } from "./helpers.js";

const settings = { ...LAB.backtest, slippagePct: 0, maxDailyLoss: 0 };
const params = { allowLong: true, allowShort: true, entryStart: "09:15", entryEnd: "14:45", stopType: "structure", atrPeriod: 14, atrMult: 1.5, stopPct: 0.5, targetR: 2 };

// A scripted strategy: fires at given bar indices.
const scripted = (signals) => ({
  id: "test",
  warmup: () => 0,
  onBar: (ctx) => signals[ctx.i] ?? null,
});

const run = (bars, signals, p = {}, s = {}) =>
  runSession({ session: makeSession("2025-01-06", bars), symbol: "TEST", strategy: scripted(signals), params: { ...params, ...p }, settings: { ...settings, ...s }, intervalMin: 5 });

describe("fills and exits", () => {
  it("fills on the NEXT bar's open", () => {
    const bars = [...flat(3), [101, 101, 101, 101], ...flat(80, 101)];
    const { trades } = run(bars, { 2: { side: "long", stop: 99 } });
    expect(trades[0].entry).toBe(101); // bar 3 open, not bar 2 close
    expect(istHHMM(trades[0].entryTime)).toBe("09:30");
  });

  it("drops a signal on the last bar of the session", () => {
    const bars = flat(10);
    const { trades } = run(bars, { 9: { side: "long", stop: 99 } });
    expect(trades).toHaveLength(0);
  });

  it("assumes the stop is hit first when stop and target are in the same bar", () => {
    const bars = [...flat(2), [100, 105, 98, 100], ...flat(5)];
    const { trades } = run(bars, { 1: { side: "long", stop: 99 } }, { targetR: 2 }); // target 102
    expect(trades[0].reason).toBe("stop");
    expect(trades[0].exit).toBe(99);
    expect(trades[0].outcome).toBe("loss");
  });

  it("hits the target when only the target is touched", () => {
    const bars = [...flat(2), [100, 102.5, 99.5, 102], ...flat(5, 102)];
    const { trades } = run(bars, { 1: { side: "long", stop: 99 } }, { targetR: 2 });
    expect(trades[0]).toMatchObject({ reason: "target", exit: 102 });
  });

  it("fills a stop gapped through at the open", () => {
    const bars = [...flat(3), [97, 98, 96, 97], ...flat(5, 97)];
    const { trades } = run(bars, { 1: { side: "long", stop: 99 } }); // filled at bar 2, gap at bar 3
    expect(trades[0].exit).toBe(97);
  });

  it("square-off at 15:15 is a forced exit (neither win nor loss)", () => {
    const bars = flat(75, 100).map((b, k) => (k > 10 ? [100.5, 100.6, 100.4, 100.5] : b));
    const { trades } = run(bars, { 1: { side: "long", stop: 99 } }, { targetR: 0 });
    expect(istHHMM(trades[0].exitTime)).toBe("15:15");
    expect(trades[0]).toMatchObject({ reason: "forced", outcome: "forced" });
  });

  it("no entries at or after the cutoff (14:45)", () => {
    const bars = flat(75);
    // bar 65 = 14:40 → would fill 14:45 → blocked; bar 64 → fills 14:40 → allowed
    expect(run(bars, { 65: { side: "long", stop: 99 } }).trades).toHaveLength(0);
    expect(run(bars, { 64: { side: "long", stop: 99 } }).trades).toHaveLength(1);
  });

  it("respects the strategy's entry window and long/short toggles", () => {
    const bars = flat(75);
    expect(run(bars, { 1: { side: "long", stop: 99 } }, { entryStart: "10:00" }).trades).toHaveLength(0);
    expect(run(bars, { 1: { side: "short", stop: 101 } }, { allowShort: false }).trades).toHaveLength(0);
  });

  it("caps trades per day and halts after the daily max loss", () => {
    const bars = [...flat(2), [100, 100, 98, 98.5], [98.5, 98.6, 98.5, 98.5], [98.5, 98.6, 96, 96], ...flat(70, 96)];
    const sig = { 1: { side: "long", stop: 99 }, 3: { side: "long", stop: 97.5 }, 10: { side: "long", stop: 95 } };
    expect(run(bars, sig, {}, { maxTradesPerDay: 1 }).trades).toHaveLength(1);
    // First loss ≈ ₹1000 risk → halt with maxDailyLoss 500.
    expect(run(bars, sig, {}, { maxTradesPerDay: 5, maxDailyLoss: 500 }).trades).toHaveLength(1);
    expect(run(bars, sig, {}, { maxTradesPerDay: 5, maxDailyLoss: 0 }).trades.length).toBeGreaterThan(1);
  });

  it("sizes so a stopped-out trade loses at most the risk, charges included", () => {
    // Long at 100, stop 97: 333 shares without charges; the charges take it lower.
    const bars = [...flat(2), [100, 100, 96, 96], ...flat(10, 96)];
    const { trades } = run(bars, { 1: { side: "long", stop: 97 } }, {}, { riskPerTrade: 1000 });
    const t = trades[0];
    expect(t.reason).toBe("stop");
    expect(t.qty).toBeLessThan(Math.floor(1000 / 3));
    expect(-t.net).toBeLessThanOrEqual(1000);
    expect(t.rNet).toBeCloseTo(-1, 6); // 1R = the planned net loss
    const one = sizeForRisk("long", 100, 97, { riskRs: 1000 });
    expect(one.qty).toBe(t.qty);
    expect(sizeForRisk("long", 100, 97, { riskRs: 1000 + 1e-9 }).qty).toBe(t.qty);
  });

  it("skips a trade whose stop is on the wrong side of the fill", () => {
    const { trades, skipped } = run(flat(10), { 1: { side: "long", stop: 101 } });
    expect(trades).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("applies slippage to entries and market exits, not to target fills", () => {
    const bars = [...flat(2), [100, 102.5, 99.5, 102], ...flat(5, 102)];
    const { trades } = run(bars, { 1: { side: "long", stop: 99 } }, { targetR: 1 }, { slippagePct: 0.1 });
    expect(trades[0].entry).toBeCloseTo(100.1, 6);
    expect(trades[0].exit).toBeCloseTo(100.1 + (100.1 - 99), 6);
  });

  it("an exit signal closes at the next open", () => {
    const bars = [...flat(3), [100, 100.5, 99.8, 100.4], [100.6, 100.7, 100.5, 100.6], ...flat(5, 100.6)];
    const { trades } = run(bars, { 1: { side: "long", stop: 99 }, 3: { exit: true } }, { targetR: 0 });
    expect(trades[0]).toMatchObject({ reason: "signal", exit: 100.6 });
  });
});

describe("breakeven / trailing stop", () => {
  const off = { breakevenR: 0, trailType: "none", trailAtrMult: 2, trailSwingBars: 3 };

  it("is off by default: the stop never moves", () => {
    const bars = [...flat(2), [100, 101.5, 100, 101.5], [101.5, 101.5, 98.5, 99], ...flat(5, 99)];
    const { trades } = run(bars, { 1: { side: "long", stop: 99 } }, { ...off, targetR: 0 });
    expect(trades[0]).toMatchObject({ reason: "stop", exit: 99, stop: 99, initialStop: 99 });
  });

  it("moves the stop to entry after +1R, from the NEXT bar", () => {
    // Entry 100 at bar 2, stop 99 (R = 1). Bar 2 reaches 101 (+1R) → stop 100 from bar 3.
    const bars = [...flat(2), [100, 101, 100, 100.8], [100.8, 100.9, 99.5, 99.6], ...flat(5, 99.6)];
    const { trades } = run(bars, { 1: { side: "long", stop: 99 } }, { ...off, breakevenR: 1, targetR: 0 });
    expect(trades[0]).toMatchObject({ reason: "trail", exit: 100, stop: 100, initialStop: 99 });
    expect(trades[0].rGross).toBeCloseTo(0, 9); // R still measured from the first stop
  });

  it("the swing trail only tightens and ignores the bar it is computed on", () => {
    // Long from 100, stop 95. Lows rise 99 → 101 → 103, then a dip to 100.5.
    const bars = [
      ...flat(2),
      [100, 100.5, 99, 100.4],
      [100.4, 102, 101, 101.8],
      [101.8, 104, 103, 103.9],
      [103.9, 104, 100.5, 100.6], // bar 5 dips through the trailed stop
      ...flat(5, 100.6),
    ];
    const { trades } = run(bars, { 1: { side: "long", stop: 95 } }, { ...off, trailType: "swing", trailSwingBars: 2, targetR: 0 });
    // At bar 4 close the stop is min(low of bars 3,4) = 101; it must not be bar 5's own low.
    expect(trades[0]).toMatchObject({ reason: "trail", exit: 101 });
  });

  it("never loosens the stop for a short", () => {
    const bars = [...flat(2), [100, 100.2, 99, 99.2], [99.2, 101, 99.1, 100.9], ...flat(5, 100.9)];
    const { trades } = run(bars, { 1: { side: "short", stop: 102 } }, { ...off, trailType: "atr", trailAtrMult: 0.1, atrPeriod: 2, targetR: 0 });
    expect(trades[0].stop).toBeLessThanOrEqual(102);
    expect(trades[0].stop).toBeGreaterThan(trades[0].exit - 2); // sanity: a real level, not NaN
  });
});

describe("costs", () => {
  it("matches the broker's rate card for one round trip", () => {
    const c = tradeCosts(100000, 101000);
    const brokerage = 20 + 20; // 0.03% would be ₹30 / ₹30.3 → capped at ₹20 each
    const stt = 101000 * 0.00025; // sell side
    const exch = 201000 * 0.0000307;
    const sebi = (201000 * 10) / 1e7;
    const stamp = 100000 * 0.00003; // buy side
    const gst = (brokerage + exch + sebi) * 0.18;
    expect(c.total).toBeCloseTo(brokerage + stt + exch + sebi + stamp + gst, 6);
  });
  it("brokerage is 0.03% on small orders", () => {
    expect(tradeCosts(20000, 20000).brokerage).toBeCloseTo(6 + 6, 6);
  });
  it.each([["long", 500, 495], ["short", 500, 505]])("sizeForRisk: loss at the stop incl. charges + slippage fits the risk (%s)", (side, entry, stop) => {
    const opts = { riskRs: 2000, slippagePct: 0.05 };
    const s = sizeForRisk(side, entry, stop, opts);
    const fill = side === "long" ? stop * 0.9995 : stop * 1.0005;
    const lossAt = (q) => Math.abs(entry - fill) * q + (side === "long" ? tradeCosts(entry * q, fill * q) : tradeCosts(fill * q, entry * q)).total;
    expect(s.qty).toBeGreaterThan(0);
    expect(lossAt(s.qty)).toBeCloseTo(s.lossRs, 6);
    expect(s.lossRs).toBeLessThanOrEqual(2000);
    expect(lossAt(s.qty + 1)).toBeGreaterThan(2000); // the largest size that fits
    expect(s.charges).toBeGreaterThan(0);
  });
  it("sizeForRisk respects the position cap and refuses impossible sizes", () => {
    expect(sizeForRisk("long", 500, 495, { riskRs: 1e6, maxValue: 50000 }).qty).toBe(100);
    expect(sizeForRisk("long", 500, 400, { riskRs: 50 }).qty).toBe(0);
    expect(sizeForRisk("long", 500, 505, { riskRs: 1000 }).qty).toBe(0);
  });
});

describe("metrics", () => {
  const t = (net, outcome, r = net / 1000) => ({ net, gross: net + 50, costs: 50, rNet: r, rGross: r, outcome, entryTime: 1, exitTime: 2, bucket: "open" });
  it("a win is any trade that made money after charges, whatever the exit", () => {
    const m = metrics([{ ...t(500, "win"), reason: "target" }, { ...t(-1000, "loss"), reason: "stop" }, { ...t(200, "forced"), reason: "forced" }, { ...t(-100, "forced"), reason: "forced" }]);
    expect(m.wins).toBe(2);
    expect(m.winPct).toBe(50);
    expect(m.winPct + m.lossPct).toBeCloseTo(100);
    expect(m.forcedPct).toBe(50);
    expect(m.exits).toMatchObject({ target: 25, stop: 25, forced: 50, trail: 0, signal: 0 });
    // Avg win 350, avg loss 550 → need 550 / 900 = 61.1% to break even.
    expect(m.breakEvenWinPct).toBeCloseTo((550 / 900) * 100, 6);
    expect(m.winLow).toBeLessThan(50);
    expect(m.winHigh).toBeGreaterThan(50);
    expect(m.expectancyRs).toBeCloseTo((500 - 1000 + 200 - 100) / 4);
    expect(m.profitFactor).toBeCloseTo(700 / 1100);
    expect(m.maxDrawdown).toBeCloseTo(1000);
  });
});

describe("win range", () => {
  it("narrows as trades add up and stays inside 0–100", () => {
    const [a, b] = winRange(15, 30);
    const [c, d] = winRange(150, 300);
    expect(b - a).toBeGreaterThan(d - c);
    expect(a).toBeLessThan(50);
    expect(b).toBeGreaterThan(50);
    expect(winRange(0, 10)[0]).toBe(0);
    expect(winRange(10, 10)[1]).toBe(100);
    expect(winRange(0, 0)).toEqual([null, null]);
    // Known value: 50/100 → 40.4%–59.6%.
    expect(winRange(50, 100)[0]).toBeCloseTo(40.38, 1);
    expect(winRange(50, 100)[1]).toBeCloseTo(59.62, 1);
  });
});

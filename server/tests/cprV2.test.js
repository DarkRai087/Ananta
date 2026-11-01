// Unit tests for CPR Reversal v2's pure logic: CPR/width math (incl. BC/TC swap), width-regime
// percentile, closed-candle rejection rules, touch counting, and the pre-trade R check.
import { describe, it, expect } from "vitest";
import { cprOf, regimeOf, rejection, touchCount, passRR, weeklyCpr } from "../strategies/cprReversalV2.js";
import { pivots } from "../lab/indicators.js";

const P = { zoneAtr: 0.15, throughAtr: 1.0, useCandleQuality: true, rejectWick: true, reclaim: false };

describe("cprOf", () => {
  it("computes pivot / BC / TC with BC ≤ TC always", () => {
    const { pivot, bc, tc, widthPct } = cprOf({ high: 110, low: 90, close: 105 });
    expect(pivot).toBeCloseTo(101.6667, 3);
    expect(bc).toBeLessThanOrEqual(tc);
    expect(widthPct).toBeGreaterThan(0);
  });
  it("still returns BC ≤ TC when the raw BC comes out above TC (swap)", () => {
    // A low close pushes tc0 = 2P − bc0 below bc0; the swap must keep bc ≤ tc.
    const { bc, tc } = cprOf({ high: 100, low: 100, close: 80 });
    expect(bc).toBeLessThanOrEqual(tc);
  });
});

describe("pivots: Camarilla + floor levels (shared with v1/v2)", () => {
  it("computes Camarilla H3/H4/L3/L4 and keeps R/S ordered around the pivot", () => {
    const pv = pivots({ high: 110, low: 90, close: 105 });
    const rng = 110 - 90;
    expect(pv.h3).toBeCloseTo(105 + (1.1 * rng) / 4, 6);
    expect(pv.h4).toBeCloseTo(105 + (1.1 * rng) / 2, 6);
    expect(pv.l3).toBeCloseTo(105 - (1.1 * rng) / 4, 6);
    expect(pv.l4).toBeCloseTo(105 - (1.1 * rng) / 2, 6);
    expect(pv.h4).toBeGreaterThan(pv.h3);
    expect(pv.l4).toBeLessThan(pv.l3);
    expect(pv.bc).toBeLessThanOrEqual(pv.tc);
    expect(pv.s1 < pv.pivot && pv.pivot < pv.r1).toBe(true);
    expect(pv.s2 < pv.s1 && pv.r1 < pv.r2).toBe(true);
  });
});

describe("weeklyCpr", () => {
  it("builds a CPR from the last 5 daily bars, null under 5", () => {
    const d = Array.from({ length: 5 }, () => ({ high: 110, low: 90, close: 100 }));
    expect(weeklyCpr(d)).not.toBeNull();
    expect(weeklyCpr(d.slice(0, 4))).toBeNull();
  });
});

describe("regimeOf", () => {
  const bars = Array.from({ length: 20 }, (_, i) => ({ high: 100 + i, low: 100, close: 100 })); // widening CPRs
  const p = { widePct: 0.6, narrowPct: 0.3, regimeMinDays: 10 };
  it("tags a top-decile width WIDE and a bottom-decile width NARROW", () => {
    const widths = bars.map((b) => cprOf(b).widthPct);
    expect(regimeOf(Math.max(...widths), bars, p).tag).toBe("WIDE");
    expect(regimeOf(Math.min(...widths), bars, p).tag).toBe("NARROW");
  });
  it("falls back to NORMAL without enough history", () => {
    expect(regimeOf(1, bars.slice(0, 5), p).tag).toBe("NORMAL");
  });
});

describe("rejection", () => {
  const atr = 2;
  const L = 100;
  it("accepts a clean support bounce (tagged the zone, closed back above, strong lower wick)", () => {
    const bar = { open: 101, high: 102, low: 99.8, close: 101.5 };
    expect(rejection(bar, { close: 101 }, L, atr, "long", P)).not.toBeNull();
  });
  it("rejects when the candle closed inside the zone (no reclaim)", () => {
    const bar = { open: 100.1, high: 100.2, low: 99.8, close: 100.1 };
    expect(rejection(bar, { close: 100 }, L, atr, "long", P)).toBeNull();
  });
  it("rejects a clean slice-through (a breakdown, not a bounce)", () => {
    const bar = { open: 100, high: 100.1, low: 97, close: 97.5 }; // low below L − throughAtr·ATR
    expect(rejection(bar, { close: 100 }, L, atr, "long", P)).toBeNull();
  });
  it("rejects when the close is not in the rejection 40% of range", () => {
    const bar = { open: 100.5, high: 102, low: 99.9, close: 100.5 }; // closed mid-range
    expect(rejection(bar, { close: 100 }, L, atr, "long", P)).toBeNull();
  });
  it("mirrors for a short resistance rejection", () => {
    const bar = { open: 99, high: 100.2, low: 98, close: 98.3 };
    expect(rejection(bar, { close: 99 }, L, atr, "short", P)).not.toBeNull();
  });
});

describe("touchCount", () => {
  it("counts prior zone tags on the rejection side", () => {
    const atr = 2;
    const L = 100;
    const cs = [
      { high: 105, low: 104 }, // bar 0 (skipped, k starts at 1)
      { high: 101, low: 99.9 }, // tag 1
      { high: 103, low: 102 }, // no tag
      { high: 100.5, low: 100.1 }, // tag 2 (within +zone)
    ];
    expect(touchCount(cs, L, atr, 3, "long", P)).toBe(2);
  });
});

describe("passRR", () => {
  const p = { minRR: 1.3, costCushionPct: 0.12 };
  it("passes when reward ≥ 1.3× risk after the cost cushion", () => {
    expect(passRR(100, 99, 101.5, p)).toBe(true); // risk 1, reward ~1.38
  });
  it("fails a sub-1.3R target", () => {
    expect(passRR(100, 99, 101.1, p)).toBe(false);
  });
  it("fails a null target or non-positive risk", () => {
    expect(passRR(100, 99, null, p)).toBe(false);
    expect(passRR(100, 100, 102, p)).toBe(false);
  });
});

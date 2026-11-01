// Unit tests for Gap and Go v2's pure logic: gap metrics, classification + size buckets, relative
// gap, circuit room, and the gap-failure rule.
import { describe, it, expect } from "vitest";
import { gapMetrics, classifyGap, sizeBucket, relativeGap, circuitRoom, gapFailed } from "../strategies/gapAndGoV2.js";

const P = { smallAtr: 0.5, sweetMaxAtr: 1.5, largeMaxAtr: 2.5 };

describe("gapMetrics", () => {
  it("computes gap% and gapATR from the official-close proxy and daily ATR", () => {
    const { gapPct, gapAtr } = gapMetrics(103, 100, 2);
    expect(gapPct).toBeCloseTo(3, 6);
    expect(gapAtr).toBeCloseTo(1.5, 6); // (103−100)/2
  });
});

describe("classifyGap", () => {
  it("tags FULL vs PARTIAL on each side", () => {
    expect(classifyGap(112, 100, 110, 90)).toBe("FULL_UP"); // open above PDH
    expect(classifyGap(105, 100, 110, 90)).toBe("PARTIAL_UP"); // above close, inside PDH
    expect(classifyGap(88, 100, 110, 90)).toBe("FULL_DOWN");
    expect(classifyGap(95, 100, 110, 90)).toBe("PARTIAL_DOWN");
    expect(classifyGap(100, 100, 110, 90)).toBeNull(); // flat
  });
});

describe("sizeBucket", () => {
  it("buckets by ATR size", () => {
    expect(sizeBucket(0.3, P)).toBe("SMALL");
    expect(sizeBucket(1.0, P)).toBe("SWEET");
    expect(sizeBucket(2.0, P)).toBe("LARGE");
    expect(sizeBucket(3.0, P)).toBe("EXTREME");
  });
});

describe("relativeGap", () => {
  it("subtracts the market-driven part (beta × NIFTY gap)", () => {
    expect(relativeGap(2.0, 1.0, 1)).toBeCloseTo(1.0, 6);
    expect(relativeGap(2.0, 1.0, 1.5)).toBeCloseTo(0.5, 6);
    expect(relativeGap(2.0, null, 1)).toBeCloseTo(2.0, 6); // no NIFTY → stock gap as-is
  });
});

describe("circuitRoom", () => {
  it("returns ATR room to the band, or null when no band is configured", () => {
    expect(circuitRoom(100, 10, 2, "long")).toBeCloseTo(5, 6); // 10% of 100 = 10 pts = 5 ATR
    expect(circuitRoom(100, 0, 2, "long")).toBeNull();
    expect(circuitRoom(100, undefined, 2, "long")).toBeNull();
  });
});

describe("gapFailed", () => {
  const cs = [{ high: 106, low: 104 }, { high: 105, low: 103 }, { high: 104, low: 99 }];
  it("flags a long gap that traded back below support", () => {
    expect(gapFailed(cs, 100, "long", 2)).toBe(true); // bar 2 low 99 < 100
    expect(gapFailed(cs, 100, "long", 1)).toBe(false); // not yet by bar 1
    expect(gapFailed(cs, null, "long", 2)).toBe(false); // no support → never fails
  });
});

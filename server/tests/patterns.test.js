import { describe, it, expect } from "vitest";
import { makeCandles } from "./helpers.js";
import { DETECTOR_BY_ID as D } from "../patterns/index.js";
import { zigzag, pivotsAt } from "../patterns/zigzag.js";

const D0 = "2025-01-06";
const cs = (bars) => makeCandles(D0, bars);
// Mirror prices around 100 (turns a bullish setup into the bearish one).
const mirror = (bars) => bars.map(([o, h, l, c, v]) => [200 - o, 200 - l, 200 - h, 200 - c, v]);
const last = (bars) => bars.length - 1;

const DOWN3 = [[104, 104.1, 102.9, 103], [103, 103.1, 101.9, 102], [102, 102.1, 100.9, 101]];
const UP3 = [[96, 97.1, 95.9, 97], [97, 98.1, 96.9, 98], [98, 99.1, 97.9, 99]];

describe("single-bar patterns", () => {
  it("Hammer after a decline", () => {
    const bars = [...DOWN3, [99.8, 100.05, 99, 100]];
    expect(D.hammer.detect(cs(bars), 3)).toEqual({ name: "Hammer", direction: "long", index: 3 });
  });
  it("no Hammer after a rise", () => {
    expect(D.hammer.detect(cs([...UP3, [99.8, 100.05, 99, 100]]), 3)).toBeNull();
  });
  it("Inverted Hammer after a decline", () => {
    expect(D.invertedHammer.detect(cs([...DOWN3, [99.8, 101, 99.75, 100]]), 3)?.name).toBe("Inverted Hammer");
  });
  it("Shooting Star after a rise", () => {
    const h = D.shootingStar.detect(cs([...UP3, [100.2, 101.2, 99.95, 100]]), 3);
    expect(h).toEqual({ name: "Shooting Star", direction: "short", index: 3 });
  });
  it("no Shooting Star when the upper wick is short", () => {
    expect(D.shootingStar.detect(cs([...UP3, [100.2, 100.4, 99.95, 100]]), 3)).toBeNull();
  });
  it("Bullish / Bearish Marubozu", () => {
    expect(D.marubozu.detect(cs([[100, 101.02, 99.99, 101]]), 0)?.name).toBe("Bullish Marubozu");
    expect(D.marubozu.detect(cs([[101, 101.01, 99.98, 100]]), 0)?.name).toBe("Bearish Marubozu");
    expect(D.marubozu.detect(cs([[100, 102, 99, 101]]), 0)).toBeNull();
  });
  it("Doji, Gravestone and Dragonfly are separate", () => {
    const doji = [100, 100.5, 99.5, 100.02];
    const grave = [100, 101, 99.99, 100.02];
    const dragon = [100, 100.01, 99, 99.98];
    expect(D.doji.detect(cs([doji]), 0)?.direction).toBe("neutral");
    expect(D.doji.detect(cs([grave]), 0)).toBeNull();
    expect(D.gravestoneDoji.detect(cs([grave]), 0)).toEqual({ name: "Gravestone Doji", direction: "short", index: 0 });
    expect(D.dragonflyDoji.detect(cs([dragon]), 0)).toEqual({ name: "Dragonfly Doji", direction: "long", index: 0 });
    expect(D.gravestoneDoji.detect(cs([doji]), 0)).toBeNull();
  });
  it("ignores flat bars (range under minRangePct)", () => {
    expect(D.doji.detect(cs([[100, 100.01, 99.99, 100]]), 0)).toBeNull();
  });
});

describe("multi-bar patterns", () => {
  it("Bullish Engulfing after a decline", () => {
    const bars = [...DOWN3, [100, 100.1, 99.4, 99.5], [99.4, 100.4, 99.3, 100.3]];
    expect(D.engulfing.detect(cs(bars), 4)).toEqual({ name: "Bullish Engulfing", direction: "long", index: 4 });
    expect(D.engulfing.detect(cs(bars), 3)).toBeNull();
  });
  it("Bearish Engulfing after a rise", () => {
    const bars = [...UP3, [99, 99.6, 98.9, 99.5], [99.6, 99.7, 98.7, 98.8]];
    expect(D.engulfing.detect(cs(bars), 4)?.name).toBe("Bearish Engulfing");
  });
  it("Morning Star", () => {
    const bars = [...DOWN3, [101, 101.1, 99.4, 99.5], [99.4, 99.5, 99.2, 99.35], [99.4, 100.7, 99.3, 100.6]];
    expect(D.morningStar.detect(cs(bars), 5)).toEqual({ name: "Morning Star", direction: "long", index: 5 });
    // Third bar not closing past the midpoint → no pattern.
    const weak = [...bars.slice(0, 5), [99.4, 100, 99.3, 99.9]];
    expect(D.morningStar.detect(cs(weak), 5)).toBeNull();
  });
  it("Evening Star", () => {
    const bars = [...UP3, [99, 100.6, 98.9, 100.5], [100.6, 100.8, 100.5, 100.65], [100.6, 100.7, 99.3, 99.4]];
    expect(D.eveningStar.detect(cs(bars), 5)?.name).toBe("Evening Star");
  });
  it("Inside Bar", () => {
    expect(D.insideBar.detect(cs([[100, 102, 98, 101], [101, 101.5, 99, 100]]), 1)?.name).toBe("Inside Bar");
    expect(D.insideBar.detect(cs([[100, 102, 98, 101], [101, 102.5, 99, 100]]), 1)).toBeNull();
  });
});

// ── Swing-point (zigzag) patterns ──────────────────────────────────────────

const DOUBLE_TOP = [
  [100, 100.1, 99.9, 100],
  [100, 100.5, 99.95, 100.45],
  [100.45, 101, 100.4, 100.95], // H1 = 101
  [100.95, 100.96, 100.5, 100.55],
  [100.55, 100.6, 100.3, 100.35], // neckline 100.3
  [100.35, 100.7, 100.33, 100.65],
  [100.65, 101.02, 100.6, 100.95], // H2 = 101.02
  [100.95, 100.97, 100.6, 100.62],
  [100.62, 100.65, 100.4, 100.45],
  [100.45, 100.46, 100.1, 100.2], // first close below neckline → completes here
  [100.2, 100.25, 99.9, 99.95],
];

const ASC_TRIANGLE = [
  [100, 100.1, 99.9, 100],
  [100, 101, 99.95, 100.9], // H 101
  [100.9, 100.95, 100.4, 100.45], // L 100.4
  [100.45, 100.8, 100.42, 100.75],
  [100.75, 101.01, 100.7, 100.95], // H 101.01 (flat top)
  [100.95, 100.96, 100.6, 100.65], // L 100.6 (higher low)
  [100.65, 100.95, 100.62, 100.9],
  [100.9, 101.3, 100.88, 101.25], // close above the flat top → completes
];

const BULL_FLAG = [
  [100, 100.1, 99.9, 100],
  [100, 100.5, 99.95, 100.45],
  [100.45, 101, 100.4, 100.95],
  [100.95, 101.5, 100.9, 101.45], // pole top 101.5
  [101.45, 101.46, 101.1, 101.15],
  [101.15, 101.2, 101.0, 101.05],
  [101.05, 101.3, 101.02, 101.25],
  [101.25, 101.7, 101.2, 101.65], // breakout
];

// Only the completing bar fires; earlier bars (and the bar after) do not.
function onlyAt(det, bars, k) {
  const c = cs(bars);
  for (let i = 0; i < c.length; i++) {
    const h = det.detect(c, i);
    if (i === k) expect(h, `expected hit at ${i}`).not.toBeNull();
    else expect(h, `unexpected hit at ${i}`).toBeNull();
  }
}

describe("zigzag", () => {
  it("confirms pivots only after a reversal of zigzagPct", () => {
    const pv = zigzag(cs(DOUBLE_TOP), 0.3);
    expect(pv.map((p) => [p.type, p.index, p.confirmedAt])).toEqual([
      ["L", 0, 1],
      ["H", 2, 3],
      ["L", 4, 5],
      ["H", 6, 7],
    ]);
  });
  it("pivots known at bar i never change when later bars arrive", () => {
    const c = cs(DOUBLE_TOP);
    for (let i = 0; i < c.length; i++) expect(pivotsAt(c.slice(0, i + 1), i, 0.3)).toEqual(pivotsAt(c, i, 0.3));
  });
});

describe("chart patterns (same-session swings)", () => {
  it("Double Top completes on the first close below the neckline", () => {
    onlyAt(D.doubleTop, DOUBLE_TOP, 9);
    expect(D.doubleTop.detect(cs(DOUBLE_TOP), 9)).toEqual({ name: "Double Top", direction: "short", index: 9 });
  });
  it("no Double Top when the second high is too far from the first", () => {
    const bars = DOUBLE_TOP.map((b, k) => (k === 6 ? [100.65, 101.5, 100.6, 100.95] : b));
    expect(D.doubleTop.detect(cs(bars), 9)).toBeNull();
  });
  it("Double Bottom (mirror)", () => onlyAt(D.doubleBottom, mirror(DOUBLE_TOP), 9));
  it("Ascending Triangle completes on the breakout close", () => onlyAt(D.ascendingTriangle, ASC_TRIANGLE, 7));
  it("no Ascending Triangle when lows are not rising", () => {
    const bars = ASC_TRIANGLE.map((b, k) => (k === 5 ? [100.95, 100.96, 100.38, 100.45] : b));
    expect(D.ascendingTriangle.detect(cs(bars), 7)).toBeNull();
  });
  it("Descending Triangle (mirror)", () => onlyAt(D.descendingTriangle, mirror(ASC_TRIANGLE), 7));
  it("Bull Flag completes on the close above the pole high", () => onlyAt(D.bullFlag, BULL_FLAG, 7));
  it("no Bull Flag when the pullback retraces too much", () => {
    const bars = BULL_FLAG.map((b, k) => (k === 5 ? [101.15, 101.2, 100.5, 100.6] : b));
    expect(D.bullFlag.detect(cs(bars), 7)).toBeNull();
  });
  it("Bear Flag (mirror)", () => onlyAt(D.bearFlag, mirror(BULL_FLAG), 7));
});

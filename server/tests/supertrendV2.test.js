// Supertrend v2: indicator correctness (Wilder ATR, band ratcheting, close-based flips) and the
// checklist pipeline (MANDATORY stage-stop, SCORED score math), plus the TREND-family dedupe.
import { describe, it, expect } from "vitest";
import { supertrend, atr } from "../lab/indicators.js";
import { markTrendFamily, sideOf } from "../plans/arbiter.js";

// A synthetic series: flat, then a clean uptrend, then a sharp drop (to force a close-based flip).
const bars = (() => {
  const out = [];
  for (let k = 0; k < 15; k++) out.push({ high: 100 + k, low: 99 + k, close: 99.5 + k, open: 99.5 + k }); // rising
  for (let k = 0; k < 6; k++) out.push({ high: 114 - 3 * k, low: 112 - 3 * k, close: 112.2 - 3 * k, open: 114 - 3 * k }); // sharp drop
  return out;
})();

describe("ATR is Wilder's RMA (not SMA)", () => {
  it("seeds with the SMA of the first `period` TRs then applies the Wilder recursion", () => {
    const cs = bars.slice(0, 12);
    const period = 10;
    const tr = cs.map((c, k) => (k === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - cs[k - 1].close), Math.abs(c.low - cs[k - 1].close))));
    let seed = 0; for (let k = 0; k < period; k++) seed += tr[k]; seed /= period;
    const a = atr(cs, period);
    expect(a[period - 1]).toBeCloseTo(seed, 9);
    expect(a[period]).toBeCloseTo((seed * (period - 1) + tr[period]) / period, 9); // Wilder step, ≠ a fresh SMA
  });
});

describe("Supertrend bands + flips", () => {
  const { value, dir } = supertrend(bars, 10, 3);
  it("is in an uptrend through the rising section (line below price, dir 1)", () => {
    expect(dir[14]).toBe(1);
    expect(value[14]).toBeLessThan(bars[14].close);
  });
  it("flips to down on a CLOSE below the line during the drop", () => {
    expect(dir[dir.length - 1]).toBe(-1);
    expect(value[value.length - 1]).toBeGreaterThan(bars[bars.length - 1].close);
  });
  it("ratchets: the up-trend line never decreases while the trend holds", () => {
    for (let k = 11; k <= 14; k++) if (dir[k] === 1 && dir[k - 1] === 1) expect(value[k]).toBeGreaterThanOrEqual(value[k - 1] - 1e-9);
  });
});

describe("markTrendFamily — one combined TREND signal", () => {
  const sig = (id, side) => ({ id, status: "signal", setups: [{ side }], position: null });
  it("collapses same-direction Supertrend + EMA into one, tags the rest duplicateOf", () => {
    const ss = [sig("supertrendV2", "long"), sig("emaCross", "long"), sig("cprReversalV2", "long")];
    const n = markTrendFamily(ss);
    expect(n).toBe(1);
    expect(ss.find((s) => s.id === "emaCross").trendDuplicateOf).toBe("supertrendV2");
    expect(ss.find((s) => s.id === "cprReversalV2").trendDuplicateOf).toBeUndefined(); // not TREND family
  });
  it("leaves opposite-direction trend signals alone", () => {
    const ss = [sig("supertrendV2", "long"), sig("emaCross", "short")];
    expect(markTrendFamily(ss)).toBe(0);
  });
});

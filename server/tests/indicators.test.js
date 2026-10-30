import { describe, it, expect } from "vitest";
import * as I from "../lab/indicators.js";
import { makeCandles, randomSessions } from "./helpers.js";

const close = (a, b, eps = 1e-9) => expect(Math.abs(a - b)).toBeLessThan(eps);

describe("sma / ema", () => {
  it("sma averages the last N values", () => {
    expect(I.sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });
  it("ema is seeded with the SMA, then smooths", () => {
    const e = I.ema([1, 2, 3, 4, 5], 3);
    expect(e.slice(0, 2)).toEqual([null, null]);
    close(e[2], 2);
    close(e[3], 4 * 0.5 + 2 * 0.5);
    close(e[4], 5 * 0.5 + 3 * 0.5);
  });
});

describe("vwap", () => {
  it("is the volume-weighted typical price, cumulative within the session", () => {
    const cs = makeCandles("2025-01-06", [
      [10, 12, 8, 10, 100], // typical 10
      [10, 14, 10, 12, 300], // typical 12
    ]);
    const v = I.vwap(cs);
    close(v[0], 10);
    close(v[1], (10 * 100 + 12 * 300) / 400);
  });
  it("falls back to equal weights when there is no volume (indices)", () => {
    const cs = makeCandles("2025-01-06", [[10, 12, 8, 10, 0], [10, 14, 10, 12, 0]]);
    close(I.vwap(cs)[1], 11);
  });
});

describe("atr / true range", () => {
  it("first bar TR is high-low (no previous-day close)", () => {
    const cs = makeCandles("2025-01-06", [[10, 11, 9, 10], [10, 13, 10, 12], [12, 12.5, 11, 11.5]]);
    const tr = I.trueRange(cs);
    expect(tr).toEqual([2, 3, 1.5]);
    const a = I.atr(cs, 2);
    expect(a[0]).toBeNull();
    close(a[1], 2.5);
    close(a[2], (2.5 * 1 + 1.5) / 2);
  });
});

describe("rsi", () => {
  it("is 100 when every bar closes higher and 0 when every bar closes lower", () => {
    const up = Array.from({ length: 20 }, (_, k) => 100 + k);
    expect(I.rsi(up, 14)[14]).toBe(100);
    const dn = Array.from({ length: 20 }, (_, k) => 100 - k);
    close(I.rsi(dn, 14)[14], 0);
  });
  it("is 50 for equal average gains and losses", () => {
    const zig = Array.from({ length: 15 }, (_, k) => (k % 2 ? 101 : 100));
    close(I.rsi(zig, 14)[14], 50, 1e-6);
  });
});

describe("bollinger", () => {
  it("bands are mid ± k·σ (population σ)", () => {
    const v = [1, 2, 3, 4, 5];
    const bb = I.bollinger(v, 5, 2);
    close(bb.mid[4], 3);
    close(bb.upper[4], 3 + 2 * Math.sqrt(2));
    close(bb.lower[4], 3 - 2 * Math.sqrt(2));
  });
});

describe("supertrend", () => {
  it("flips down on a crash and up on a rally", () => {
    const bars = [];
    for (let k = 0; k < 15; k++) bars.push([100 + k, 101 + k, 99 + k, 100.5 + k]);
    for (let k = 0; k < 10; k++) bars.push([114 - k * 3, 115 - k * 3, 110 - k * 3, 111 - k * 3]);
    const st = I.supertrend(makeCandles("2025-01-06", bars), 10, 3);
    expect(st.dir[12]).toBe(1);
    expect(st.dir[24]).toBe(-1);
    expect(st.value[24]).toBeGreaterThan(makeCandles("2025-01-06", bars)[24].close);
  });
});

describe("openingRange", () => {
  const cs = makeCandles("2025-01-06", [[100, 101, 99, 100], [100, 103, 100, 102], [102, 102, 98, 99], [99, 110, 90, 105]]);
  it("covers 09:15–09:30 on 5m bars and completes at the 09:25 bar", () => {
    const or = I.openingRange(cs, 15, 5);
    expect(or).toEqual({ high: 103, low: 98, completeIndex: 2 });
  });
  it("is incomplete if the session stops inside the range", () => {
    expect(I.openingRange(cs.slice(0, 2), 15, 5).completeIndex).toBe(Infinity);
  });
  it("on bars bigger than the range uses the first bar", () => {
    const big = makeCandles("2025-01-06", [[100, 105, 95, 101], [101, 120, 80, 100]], 15);
    expect(I.openingRange(big, 5, 15)).toEqual({ high: 105, low: 95, completeIndex: 0 });
  });
});

describe("pivots / CPR", () => {
  it("uses the classic formulas", () => {
    const p = I.pivots({ high: 110, low: 90, close: 105 });
    close(p.pivot, 305 / 3);
    close(p.bc, 100);
    close(p.tc, 2 * (305 / 3) - 100);
    close(p.r1, 2 * (305 / 3) - 90);
    close(p.s1, 2 * (305 / 3) - 110);
    close(p.r2, 305 / 3 + 20);
    close(p.s2, 305 / 3 - 20);
  });
  it("is null without a previous day", () => expect(I.pivots(null)).toBeNull());
  it("adds Camarilla levels and CPR width", () => {
    const p = I.pivots({ high: 110, low: 90, close: 105 });
    close(p.h3, 105 + 5.5); // 1.1 × 20 / 4
    close(p.h4, 105 + 11); // 1.1 × 20 / 2
    close(p.l3, 105 - 5.5);
    close(p.l4, 105 - 11);
    close(p.cprWidthPct, ((p.tc - p.bc) / p.pivot) * 100);
  });
});

describe("vwap bands / keltner / daily ATR", () => {
  it("vwap bands = VWAP ± k × volume-weighted σ of typical price", () => {
    // Typical prices 100 and 110 with volumes 1 and 3 → mean 107.5, σ = sqrt(0.25·56.25 + 0.75·6.25) = 4.330…
    const cs = makeCandles("2025-01-06", [[100, 100, 100, 100, 1], [110, 110, 110, 110, 3]]);
    const b = I.vwapBands(cs, 2, 2);
    close(b.vwap[1], 107.5);
    close(b.upper[1], 107.5 + 2 * Math.sqrt(18.75));
    close(b.lower[1], 107.5 - 2 * Math.sqrt(18.75));
    expect(b.upper[0]).toBeNull(); // fewer than minBars
    expect(b.vwap).toEqual(I.vwap(cs));
  });
  it("vwap bands fall back to equal weights without volume (indices)", () => {
    const cs = makeCandles("2025-01-06", [[100, 100, 100, 100, 0], [110, 110, 110, 110, 0]]);
    const b = I.vwapBands(cs, 1, 2);
    close(b.vwap[1], 105);
    close(b.upper[1], 110);
  });
  it("keltner = EMA ± mult × ATR", () => {
    const cs = makeCandles("2025-01-06", randomSessions(1, 5)[0].bars);
    const k = I.keltner(cs, 20, 1.5);
    const e = I.ema(cs.map((c) => c.close), 20);
    const a = I.atr(cs, 20);
    close(k.upper[30], e[30] + 1.5 * a[30]);
    close(k.lower[30], e[30] - 1.5 * a[30]);
    expect(k.upper[10]).toBeNull();
  });
  it("daily ATR averages true range over the last n days", () => {
    const d = [
      { high: 105, low: 95, close: 100 },
      { high: 112, low: 104, close: 110 }, // TR = max(8, 12, 4) = 12
      { high: 111, low: 101, close: 102 }, // TR = 10
    ];
    close(I.dailyAtr(d, 2), 11);
    expect(I.dailyAtr(d, 4)).toBeNull();
  });
});

describe("causality: value at k depends only on bars 0..k", () => {
  const cs = makeCandles("2025-01-06", randomSessions(1, 3)[0].bars);
  const closes = cs.map((c) => c.close);
  const cases = {
    ema: (x) => I.ema(x.map((c) => c.close), 9),
    sma: (x) => I.sma(x.map((c) => c.close), 20),
    vwap: (x) => I.vwap(x),
    atr: (x) => I.atr(x, 14),
    rsi: (x) => I.rsi(x.map((c) => c.close), 14),
    bbUpper: (x) => I.bollinger(x.map((c) => c.close), 20, 2).upper,
    supertrend: (x) => I.supertrend(x, 10, 3).value,
    supertrendDir: (x) => I.supertrend(x, 10, 3).dir,
    vwapUpper: (x) => I.vwapBands(x, 2).upper,
    keltnerLower: (x) => I.keltner(x, 20, 1.5).lower,
  };
  for (const [name, f] of Object.entries(cases)) {
    it(name, () => {
      const full = f(cs);
      for (let k = 0; k < closes.length; k += 7) expect(f(cs.slice(0, k + 1))[k]).toEqual(full[k]);
    });
  }
});

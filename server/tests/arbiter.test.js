// Regime arbiter: CPR-width labelling and opposite-signal conflict resolution.
import { describe, it, expect } from "vitest";
import { markRegimeConflicts, sideOf, cprRegime, gapLabel, markGapRouting } from "../plans/arbiter.js";

const sig = (id, side) => ({ id, status: "signal", setups: [{ side, invalid: null, blocked: null }], position: null });

describe("sideOf", () => {
  it("reads a one-sided live signal, and null when two-way or ambiguous", () => {
    expect(sideOf(sig("x", "long"))).toBe("long");
    expect(sideOf({ id: "x", status: "signal", setups: [{ side: "long" }, { side: "short" }], position: null })).toBeNull();
    expect(sideOf({ id: "x", status: "signal", setups: [{ side: "long", invalid: "bad" }], position: null })).toBeNull();
  });
  it("prefers an open position's side", () => {
    expect(sideOf({ id: "x", status: "in_trade", setups: [], position: { side: "short" } })).toBe("short");
  });
});

describe("markRegimeConflicts", () => {
  it("WIDE keeps the reversal and stands down the opposite continuation signal", () => {
    const ss = [sig("cprReversalV2", "long"), sig("volumeBreakoutV2", "short")];
    const { conflicts } = markRegimeConflicts(ss, "WIDE");
    expect(conflicts).toHaveLength(1);
    expect(ss.find((s) => s.id === "volumeBreakoutV2").suppressed.by).toBe("cprReversalV2");
    expect(ss.find((s) => s.id === "cprReversalV2").suppressed).toBeUndefined();
  });
  it("NARROW keeps the continuation and stands down the opposite reversal signal", () => {
    const ss = [sig("cprReversalV2", "long"), sig("volumeBreakoutV2", "short")];
    markRegimeConflicts(ss, "NARROW");
    expect(ss.find((s) => s.id === "cprReversalV2").suppressed.by).toBe("volumeBreakoutV2");
    expect(ss.find((s) => s.id === "volumeBreakoutV2").suppressed).toBeUndefined();
  });
  it("does not touch same-side signals or anything under NORMAL", () => {
    const same = [sig("cprReversalV2", "long"), sig("volumeBreakoutV2", "long")];
    expect(markRegimeConflicts(same, "WIDE").conflicts).toHaveLength(0);
    const opp = [sig("cprReversalV2", "long"), sig("volumeBreakoutV2", "short")];
    expect(markRegimeConflicts(opp, "NORMAL").conflicts).toHaveLength(0);
    expect(opp.every((s) => !s.suppressed)).toBe(true);
  });
});

describe("gapLabel", () => {
  it("flags a GAP day past the ATR threshold with its direction", () => {
    expect(gapLabel(103, 100, 2).gap).toBe(true); // 1.5 ATR up
    expect(gapLabel(103, 100, 2).side).toBe("long");
    expect(gapLabel(99.5, 100, 2).gap).toBe(false); // 0.25 ATR — below 0.5
    expect(gapLabel(null, 100, 2).gap).toBe(false);
  });
});

describe("markGapRouting", () => {
  it("routes a GAP day to Gap and Go: duplicate PDH gap route + opposite CPR fade stood down", () => {
    const ss = [sig("gapAndGoV2", "long"), sig("pdhPdlV2", "long"), sig("cprReversalV2", "short"), sig("volumeBreakoutV2", "long")];
    const conflicts = markGapRouting(ss, { gap: true, side: "long" });
    expect(ss.find((s) => s.id === "pdhPdlV2").suppressed.by).toBe("gapAndGoV2"); // same-side PDH = duplicate
    expect(ss.find((s) => s.id === "cprReversalV2").suppressed.by).toBe("gapAndGoV2"); // opposite CPR fade
    expect(ss.find((s) => s.id === "volumeBreakoutV2").suppressed).toBeUndefined(); // volume not routed
    expect(ss.find((s) => s.id === "gapAndGoV2").suppressed).toBeUndefined();
    expect(conflicts).toHaveLength(2);
  });
  it("does nothing when Gap and Go is not live in the gap direction", () => {
    const ss = [sig("pdhPdlV2", "long"), sig("cprReversalV2", "short")];
    expect(markGapRouting(ss, { gap: true, side: "long" })).toHaveLength(0);
    expect(markGapRouting([sig("gapAndGoV2", "long")], { gap: false })).toHaveLength(0);
  });
});

describe("cprRegime", () => {
  it("labels a widening-width distribution and tolerates thin history", () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ high: 100 + i, low: 100, close: 100 }));
    expect(["WIDE", "NORMAL", "NARROW"]).toContain(cprRegime(5, bars).tag);
    expect(cprRegime(5, bars.slice(0, 3)).tag).toBe("NORMAL"); // < regimeMinDays
  });
});

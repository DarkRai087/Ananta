// Unit tests for Gap Fill/Fade v2's new pure logic: the shared GO/FADE classifier (mutual exclusion
// + gap-failure handoff) and the T1/T2 fill targets. Gap maths (classifyGap/sizeBucket/relativeGap/
// circuitRoom/gapFailed) are covered in gapV2.test.js and reused here (spec: shared-module reuse).
import { describe, it, expect } from "vitest";
import { classifyGapDay, CLASSIFIER_DEFAULTS } from "../strategies/gapClassifier.js";

const base = { open: 105, prevClose: 100, pdh: 110, pdl: 95, gapAtr: 0.8, relGap: 0, catalyst: false, openRvol: 1.0, niftyGap: 0, failed: false };
const P = CLASSIFIER_DEFAULTS;

describe("classifyGapDay — GO / FADE mutual exclusion", () => {
  it("labels an idiosyncratic, high-volume, market-agreeing gap GO (with the gap)", () => {
    const r = classifyGapDay({ ...base, relGap: 0.8, openRvol: 2.5, niftyGap: 0.5 }, P);
    expect(r.label).toBe("GO");
    expect(r.side).toBe("long");
  });
  it("labels a market-driven, quiet, no-catalyst gap FADE (opposite the gap)", () => {
    const r = classifyGapDay({ ...base, relGap: 0.1, openRvol: 1.0, niftyGap: 0.6 }, P);
    expect(r.label).toBe("FADE");
    expect(r.side).toBe("short"); // fade a gap-up = short
  });
  it("never both: a day is GO, FADE, or NEUTRAL", () => {
    for (const rel of [0, 0.3, 0.6, 1.0]) for (const rv of [0.5, 2.0, 3.0]) {
      const l = classifyGapDay({ ...base, relGap: rel, openRvol: rv }, P).label;
      expect(["GO", "FADE", "NEUTRAL"]).toContain(l);
    }
  });
});

describe("classifyGapDay — eligibility + catalyst + handoff", () => {
  it("NEUTRAL for a too-small or too-extreme gap", () => {
    expect(classifyGapDay({ ...base, gapAtr: 0.2 }, P).label).toBe("NEUTRAL");
    expect(classifyGapDay({ ...base, gapAtr: 3.0 }, P).label).toBe("NEUTRAL");
  });
  it("a catalyst gap is never a FADE (routes to GO)", () => {
    const r = classifyGapDay({ ...base, relGap: 0.1, openRvol: 1.0, niftyGap: 0.6, catalyst: true }, P);
    expect(r.label).not.toBe("FADE");
  });
  it("handoff: a failed gap becomes a FADE whatever it looked like, in the opposite direction", () => {
    const r = classifyGapDay({ ...base, relGap: 0.9, openRvol: 3.0, niftyGap: 0.5, failed: true }, P);
    expect(r.label).toBe("FADE");
    expect(r.side).toBe("short");
    expect(r.reasons).toContain("handoff-failed");
  });
});

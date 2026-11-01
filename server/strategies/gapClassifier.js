// Shared GO / FADE classifier (spec §13). Labels a gap stock-day from its type/size, relative gap,
// catalyst, opening RVOL, NIFTY context and early price action, so Gap and Go and Gap Fill/Fade are
// MUTUALLY EXCLUSIVE on a stock-day. Handoff: a GO day whose price trades back through prevClose/PDH
// (gap failure) flips to FADE. Pure — reuses gapAndGoV2's gap maths, no duplicate calc.
import { classifyGap, sizeBucket, relativeGap } from "./gapAndGoV2.js";

export const CLASSIFIER_DEFAULTS = {
  smallAtr: 0.3, extremeAtr: 2.5, // outside [small, extreme] → NEUTRAL (neither trades)
  relStrong: 0.5, relSmall: 0.4, // |relGap|: strong = idiosyncratic (GO), small = moved-with-market (FADE)
  rvolHigh: 2.0, // opening RVOL ≥ this supports GO; < this supports FADE
};

/**
 * inp: { open, prevClose, pdh, pdl, gapAtr, relGap, catalyst, openRvol, niftyGap, failed }
 *   relGap/openRvol/niftyGap may be null (degrade); failed = price traded back through support.
 * Returns { label: "GO"|"FADE"|"NEUTRAL", type, bucket, side, reasons[] }.
 */
export function classifyGapDay(inp, p = CLASSIFIER_DEFAULTS) {
  const { open, prevClose, pdh, pdl, gapAtr, relGap, catalyst, openRvol, niftyGap, failed } = inp;
  const type = classifyGap(open, prevClose, pdh, pdl);
  const reasons = [];
  if (!type) return { label: "NEUTRAL", type: null, bucket: null, side: null, reasons: ["no-gap"] };
  const side = type.endsWith("UP") ? "long" : "short"; // the GO direction (with the gap)
  const bucket = sizeBucket(Math.abs(gapAtr), { smallAtr: p.smallAtr, sweetMaxAtr: 1.5, largeMaxAtr: p.extremeAtr });
  if (bucket === "SMALL") return { label: "NEUTRAL", type, bucket, side, reasons: ["too-small"] };
  if (bucket === "EXTREME") return { label: "NEUTRAL", type, bucket, side, reasons: ["too-extreme"] };

  // Handoff: a gap that has already failed back through support is a FADE, whatever it looked like.
  if (failed) return { label: "FADE", type, bucket, side: side === "long" ? "short" : "long", reasons: ["handoff-failed"] };

  const absRel = relGap == null ? null : Math.abs(relGap);
  const niftyAgrees = niftyGap == null ? null : side === "long" ? niftyGap > 0 : niftyGap < 0;

  // GO: idiosyncratic strength + participation + market agreement (or a catalyst).
  let goScore = 0;
  if (catalyst) { goScore += 2; reasons.push("catalyst"); }
  if (absRel != null && absRel >= p.relStrong) { goScore++; reasons.push("rel-strong"); }
  if (openRvol != null && openRvol >= p.rvolHigh) { goScore++; reasons.push("rvol-high"); }
  if (niftyAgrees === true) { goScore++; reasons.push("nifty-agrees"); }

  // FADE: moved with the market, quiet open, no catalyst, NIFTY not confirming.
  let fadeScore = 0;
  if (!catalyst) fadeScore++;
  if (absRel != null && absRel <= p.relSmall) { fadeScore++; reasons.push("rel-small"); }
  if (openRvol != null && openRvol < p.rvolHigh) { fadeScore++; reasons.push("rvol-low"); }
  if (niftyAgrees === false) { fadeScore++; reasons.push("nifty-fades"); }
  if (catalyst) fadeScore = 0; // catalyst → never a fade

  if (goScore >= 2 && goScore > fadeScore) return { label: "GO", type, bucket, side, reasons };
  if (fadeScore >= 3 && fadeScore > goScore) return { label: "FADE", type, bucket, side: side === "long" ? "short" : "long", reasons };
  return { label: "NEUTRAL", type, bucket, side, reasons };
}

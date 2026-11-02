// Context tags for a detection: whether it sits AT a reference level, how its volume compares
// with the recent average, and which time-of-day bucket it falls in. All causal (bar ≤ i only).
import { SCANNER as CFG } from "../config/scanner.js";
import { vwap, openingRange, pivots, sma, volumes } from "../lab/indicators.js";
import { istMinute, hhmmToMin } from "../lab/time.js";

const BUCKETS = CFG.timeBuckets.map((b) => ({ ...b, s: hhmmToMin(b.start), e: hhmmToMin(b.end) }));

export function timeBucket(minute) {
  for (const b of BUCKETS) if (minute >= b.s && minute < b.e) return { id: b.id, label: b.label };
  return null;
}

// Round-number step in ₹, scaled to the price unless a fixed step is configured.
export function roundStepFor(price) {
  if (CFG.levels.roundStep) return CFG.levels.roundStep;
  if (price >= 2000) return 10;
  if (price >= 500) return 5;
  if (price >= 100) return 1;
  return 0.5;
}

/** Per-session reference levels, built once and reused for every bar of the session. */
export function levelContext(session, intervalMin) {
  const cs = session.candles;
  return {
    vwap: vwap(cs),
    or: openingRange(cs, CFG.levels.orMinutes, intervalMin),
    pivots: pivots(session.prev),
    pdh: session.prev?.high ?? null,
    pdl: session.prev?.low ?? null,
    volSma: sma(volumes(cs), CFG.volume.lookback),
  };
}

/**
 * Tags for the signal bar i.
 *   levels: human labels of every reference the close is within tolerance of (e.g. "VWAP")
 *   atLevel: levels.length > 0
 *   volumeRatio: this bar's volume ÷ the 20-bar average (null for indices / early bars)
 *   highVolume: volumeRatio ≥ configured multiple
 *   bucket: { id, label } time-of-day bucket, or null outside 09:15–15:15
 */
export function tagBar(cs, i, lc) {
  const price = cs[i].close;
  const tol = (price * CFG.levels.tolerancePct) / 100;
  const near = (lvl) => lvl != null && Math.abs(price - lvl) <= tol;
  const levels = [];
  if (near(lc.pdh)) levels.push("Prior-day high");
  if (near(lc.pdl)) levels.push("Prior-day low");
  if (near(lc.vwap[i])) levels.push("VWAP");
  if (lc.or && lc.or.completeIndex <= i) {
    if (near(lc.or.high)) levels.push("Opening-range high");
    if (near(lc.or.low)) levels.push("Opening-range low");
  }
  if (lc.pivots) {
    if (near(lc.pivots.pivot)) levels.push("CPR pivot");
    if (near(lc.pivots.tc)) levels.push("CPR top");
    if (near(lc.pivots.bc)) levels.push("CPR bottom");
  }
  const step = roundStepFor(price);
  const round = Math.round(price / step) * step;
  if (Math.abs(price - round) <= (price * CFG.levels.roundTolerancePct) / 100) levels.push(`Round ₹${round}`);

  const avgVol = lc.volSma[i];
  const vol = cs[i].volume || 0;
  const volumeRatio = avgVol ? vol / avgVol : null;
  return {
    levels,
    atLevel: levels.length > 0,
    volumeRatio,
    highVolume: volumeRatio != null && volumeRatio >= CFG.volume.highMult,
    bucket: timeBucket(istMinute(cs[i].time)),
  };
}

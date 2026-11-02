// The 20 candlestick patterns, each detected on COMPLETED candles only. A detector is called at
// bar i and may read only bars ≤ i (no look-ahead). It returns the hit at its COMPLETION bar:
//   { id, name, direction, index, span }   (span = how many candles the pattern covers)
// or null. `ctx` is the per-session precompute from geometry.sessionContext() (optional: the
// detectors also work standalone for unit tests).
import { SCANNER as CFG } from "../config/scanner.js";
import {
  range, body, upperWick, lowerWick, isBull, isBear, midBody, hasRange, bodyFloor, avgBodyAt, priorTrend,
} from "./geometry.js";

const hit = (id, name, direction, index, span) => ({ id, name, direction, index, span });
const insideBody = (c, ref) => Math.max(c.open, c.close) <= Math.max(ref.open, ref.close) && Math.min(c.open, c.close) >= Math.min(ref.open, ref.close);

// Shapes shared by hammer/hanging-man and shooting-star/inverted-hammer.
const isHammerShape = (c) => hasRange(c) && lowerWick(c) >= CFG.hammer.minLowerToBody * bodyFloor(c) && upperWick(c) / range(c) <= CFG.hammer.maxUpperPct;
const isStarShape = (c) => hasRange(c) && upperWick(c) >= CFG.shootingStar.minUpperToBody * bodyFloor(c) && lowerWick(c) / range(c) <= CFG.shootingStar.maxLowerPct;

// ── 1–4 single-candle reversals (shape + prior trend) ───────────────────────
function hammer(cs, i, ctx) {
  const c = cs[i];
  if (!isHammerShape(c)) return null;
  if (CFG.hammer.requireTrend && priorTrend(cs, i, 1, ctx) !== -1) return null;
  return hit("hammer", "Hammer", "long", i, 1);
}
function hangingMan(cs, i, ctx) {
  const c = cs[i];
  if (!isHammerShape(c)) return null;
  if (CFG.hammer.requireTrend && priorTrend(cs, i, 1, ctx) !== 1) return null;
  return hit("hangingMan", "Hanging Man", "short", i, 1);
}
function shootingStar(cs, i, ctx) {
  const c = cs[i];
  if (!isStarShape(c)) return null;
  if (CFG.shootingStar.requireTrend && priorTrend(cs, i, 1, ctx) !== 1) return null;
  return hit("shootingStar", "Shooting Star", "short", i, 1);
}
function invertedHammer(cs, i, ctx) {
  const c = cs[i];
  if (!isStarShape(c)) return null;
  if (CFG.shootingStar.requireTrend && priorTrend(cs, i, 1, ctx) !== -1) return null;
  return hit("invertedHammer", "Inverted Hammer", "long", i, 1);
}

// ── 5 Marubozu ──────────────────────────────────────────────────────────────
function marubozu(cs, i, ctx) {
  const c = cs[i];
  if (!hasRange(c) || body(c) / range(c) < CFG.marubozu.minBodyPct) return null;
  const avg = avgBodyAt(cs, i, ctx);
  if (avg == null || body(c) < avg * CFG.marubozu.minBodyToAvg) return null;
  return isBull(c) ? hit("marubozu", "Bullish Marubozu", "long", i, 1) : hit("marubozu", "Bearish Marubozu", "short", i, 1);
}

// ── 6–9 neutral / indecision ─────────────────────────────────────────────────
function doji(cs, i) {
  const c = cs[i];
  if (!hasRange(c) || body(c) / range(c) > CFG.doji.maxBodyPct) return null;
  if (CFG.doji.excludeDragonflyGravestone) {
    const r = range(c);
    const dragon = lowerWick(c) / r >= CFG.dragonflyDoji.minLowerPct && upperWick(c) / r <= CFG.dragonflyDoji.maxUpperPct;
    const grave = upperWick(c) / r >= CFG.gravestoneDoji.minUpperPct && lowerWick(c) / r <= CFG.gravestoneDoji.maxLowerPct;
    if (dragon || grave) return null;
  }
  return hit("doji", "Doji", "neutral", i, 1);
}
function dragonflyDoji(cs, i) {
  const c = cs[i];
  if (!hasRange(c) || body(c) / range(c) > CFG.dragonflyDoji.maxBodyPct) return null;
  const r = range(c);
  if (lowerWick(c) / r < CFG.dragonflyDoji.minLowerPct || upperWick(c) / r > CFG.dragonflyDoji.maxUpperPct) return null;
  return hit("dragonflyDoji", "Dragonfly Doji", "long", i, 1);
}
function gravestoneDoji(cs, i) {
  const c = cs[i];
  if (!hasRange(c) || body(c) / range(c) > CFG.gravestoneDoji.maxBodyPct) return null;
  const r = range(c);
  if (upperWick(c) / r < CFG.gravestoneDoji.minUpperPct || lowerWick(c) / r > CFG.gravestoneDoji.maxLowerPct) return null;
  return hit("gravestoneDoji", "Gravestone Doji", "short", i, 1);
}
function spinningTop(cs, i) {
  const c = cs[i];
  if (!hasRange(c)) return null;
  const b = body(c) / range(c);
  if (b < CFG.spinningTop.minBodyPct || b > CFG.spinningTop.maxBodyPct) return null;
  if (upperWick(c) <= body(c) || lowerWick(c) <= body(c)) return null;
  return hit("spinningTop", "Spinning Top", "neutral", i, 1);
}

// ── 10–11 Engulfing ──────────────────────────────────────────────────────────
function engulfing(cs, i, ctx) {
  if (i < 1) return null;
  const p = cs[i - 1];
  const c = cs[i];
  if (!hasRange(c) || body(p) === 0) return null;
  if (isBear(p) && isBull(c) && c.open <= p.close && c.close >= p.open) {
    if (CFG.engulfing.requireTrend && priorTrend(cs, i, 2, ctx) !== -1) return null;
    return hit("bullishEngulfing", "Bullish Engulfing", "long", i, 2);
  }
  if (isBull(p) && isBear(c) && c.open >= p.close && c.close <= p.open) {
    if (CFG.engulfing.requireTrend && priorTrend(cs, i, 2, ctx) !== 1) return null;
    return hit("bearishEngulfing", "Bearish Engulfing", "short", i, 2);
  }
  return null;
}

// ── 12 Inside Bar / Harami breakout ──────────────────────────────────────────
// A mother bar, a bar wholly inside it, then a CLOSE beyond the mother's high (long) or low
// (short). The break is the signal: it fires on the breakout bar, not the inside bar.
function insideBar(cs, i) {
  const k = CFG.insideBar;
  const c = cs[i];
  if (i < 2 || !hasRange(c)) return null;
  // Most recent inside bar p (mother at p−1).
  let p = -1;
  for (let q = i - 1; q >= Math.max(1, i - k.maxBarsSinceMother); q--) {
    const m = cs[q - 1];
    const ins = cs[q];
    if (hasRange(m) && ins.high <= m.high && ins.low >= m.low && (!k.requireHarami || insideBody(ins, m))) {
      p = q;
      break;
    }
  }
  if (p < 0) return null;
  const m = cs[p - 1];
  for (let t = p + 1; t <= i - 1; t++) if (cs[t].close > m.high || cs[t].close < m.low) return null; // already broke earlier
  if (c.close > m.high) return hit("insideBar", "Inside Bar ↑", "long", i, i - p + 2);
  if (c.close < m.low) return hit("insideBar", "Inside Bar ↓", "short", i, i - p + 2);
  return null;
}

// ── 13–14 Piercing Line / Dark Cloud Cover ────────────────────────────────────
function piercing(cs, i, ctx) {
  if (i < 1) return null;
  const p = cs[i - 1];
  const c = cs[i];
  const avg = avgBodyAt(cs, i, ctx);
  if (!hasRange(p) || !isBear(p) || (avg != null && body(p) < avg * CFG.piercing.minPrevBodyToAvg)) return null;
  if (!isBull(c) || c.open > p.close) return null; // opens at/below prev close
  if (c.close <= midBody(p) || c.close >= p.open) return null; // above prev body midpoint, below prev open
  if (CFG.piercing.requireTrend && priorTrend(cs, i, 2, ctx) !== -1) return null;
  return hit("piercing", "Piercing Line", "long", i, 2);
}
function darkCloud(cs, i, ctx) {
  if (i < 1) return null;
  const p = cs[i - 1];
  const c = cs[i];
  const avg = avgBodyAt(cs, i, ctx);
  if (!hasRange(p) || !isBull(p) || (avg != null && body(p) < avg * CFG.darkCloud.minPrevBodyToAvg)) return null;
  if (!isBear(c) || c.open < p.close) return null;
  if (c.close >= midBody(p) || c.close <= p.open) return null;
  if (CFG.darkCloud.requireTrend && priorTrend(cs, i, 2, ctx) !== 1) return null;
  return hit("darkCloud", "Dark Cloud Cover", "short", i, 2);
}

// ── 15 Tweezer Bottom / Top ───────────────────────────────────────────────────
function tweezer(cs, i, ctx) {
  if (i < 1) return null;
  const p = cs[i - 1];
  const c = cs[i];
  if (!hasRange(p) || !hasRange(c)) return null;
  const tol = (c.close * CFG.tweezer.tolerancePct) / 100;
  if (Math.abs(p.low - c.low) <= tol && isBear(p) && isBull(c)) {
    if (CFG.tweezer.requireTrend && priorTrend(cs, i, 2, ctx) !== -1) return null;
    return hit("tweezer", "Tweezer Bottom", "long", i, 2);
  }
  if (Math.abs(p.high - c.high) <= tol && isBull(p) && isBear(c)) {
    if (CFG.tweezer.requireTrend && priorTrend(cs, i, 2, ctx) !== 1) return null;
    return hit("tweezer", "Tweezer Top", "short", i, 2);
  }
  return null;
}

// ── 16–17 Morning / Evening Star ──────────────────────────────────────────────
function morningStar(cs, i, ctx) {
  if (i < 2) return null;
  const a = cs[i - 2];
  const b = cs[i - 1];
  const c = cs[i];
  const k = CFG.star;
  const avg = avgBodyAt(cs, i - 2, ctx);
  if (!hasRange(a) || !isBear(a) || (avg != null && body(a) < avg * k.minFirstBodyToAvg)) return null;
  if (body(b) > body(a) * k.maxMiddleBodyRatio) return null;
  if (!isBull(c) || c.close < a.close + body(a) * k.minPenetration) return null;
  if (k.requireTrend && priorTrend(cs, i, 3, ctx) !== -1) return null;
  return hit("morningStar", "Morning Star", "long", i, 3);
}
function eveningStar(cs, i, ctx) {
  if (i < 2) return null;
  const a = cs[i - 2];
  const b = cs[i - 1];
  const c = cs[i];
  const k = CFG.star;
  const avg = avgBodyAt(cs, i - 2, ctx);
  if (!hasRange(a) || !isBull(a) || (avg != null && body(a) < avg * k.minFirstBodyToAvg)) return null;
  if (body(b) > body(a) * k.maxMiddleBodyRatio) return null;
  if (!isBear(c) || c.close > a.close - body(a) * k.minPenetration) return null;
  if (k.requireTrend && priorTrend(cs, i, 3, ctx) !== 1) return null;
  return hit("eveningStar", "Evening Star", "short", i, 3);
}

// ── 18 Three White Soldiers / Three Black Crows ───────────────────────────────
function threeWhiteSoldiers(cs, i, ctx) {
  if (i < 2) return null;
  const a = cs[i - 2];
  const b = cs[i - 1];
  const c = cs[i];
  const k = CFG.threeSoldiers;
  if (![a, b, c].every((x) => isBull(x) && hasRange(x))) return null;
  if (!(a.close < b.close && b.close < c.close)) return null; // each closes beyond the last
  if (!(b.open >= Math.min(a.open, a.close) && b.open <= Math.max(a.open, a.close))) return null; // opens inside prior body
  if (!(c.open >= Math.min(b.open, b.close) && c.open <= Math.max(b.open, b.close))) return null;
  if (![a, b, c].every((x) => upperWick(x) / range(x) <= k.maxWickPct)) return null; // small wick in trend direction
  if (k.requireTrend && priorTrend(cs, i, 3, ctx) !== 1) return null;
  return hit("threeWhiteSoldiers", "Three White Soldiers", "long", i, 3);
}
function threeBlackCrows(cs, i, ctx) {
  if (i < 2) return null;
  const a = cs[i - 2];
  const b = cs[i - 1];
  const c = cs[i];
  const k = CFG.threeSoldiers;
  if (![a, b, c].every((x) => isBear(x) && hasRange(x))) return null;
  if (!(a.close > b.close && b.close > c.close)) return null;
  if (!(b.open >= Math.min(a.open, a.close) && b.open <= Math.max(a.open, a.close))) return null;
  if (!(c.open >= Math.min(b.open, b.close) && c.open <= Math.max(b.open, b.close))) return null;
  if (![a, b, c].every((x) => lowerWick(x) / range(x) <= k.maxWickPct)) return null;
  if (k.requireTrend && priorTrend(cs, i, 3, ctx) !== -1) return null;
  return hit("threeBlackCrows", "Three Black Crows", "short", i, 3);
}

// ── 19 Three Inside Up / Down ─────────────────────────────────────────────────
function threeInside(cs, i, ctx) {
  if (i < 2) return null;
  const a = cs[i - 2];
  const b = cs[i - 1];
  const c = cs[i];
  const avg = avgBodyAt(cs, i - 2, ctx);
  const large = (x) => avg == null || body(x) >= avg; // "large" first bar
  if (isBear(a) && large(a) && isBull(b) && insideBody(b, a) && c.close > a.open) {
    if (CFG.threeInside.requireTrend && priorTrend(cs, i, 3, ctx) !== -1) return null;
    return hit("threeInside", "Three Inside Up", "long", i, 3);
  }
  if (isBull(a) && large(a) && isBear(b) && insideBody(b, a) && c.close < a.open) {
    if (CFG.threeInside.requireTrend && priorTrend(cs, i, 3, ctx) !== 1) return null;
    return hit("threeInside", "Three Inside Down", "short", i, 3);
  }
  return null;
}

// Registry, in the catalog order of the spec.
export const DETECTORS = [
  hammer, shootingStar, invertedHammer, hangingMan, marubozu,
  doji, dragonflyDoji, gravestoneDoji, spinningTop,
  engulfing, insideBar, piercing, darkCloud, tweezer,
  morningStar, eveningStar, threeWhiteSoldiers, threeBlackCrows, threeInside,
];

// The 20 distinct reported patterns (Engulfing and the Soldiers/Crows split by direction).
export const CATALOG = [
  { id: "hammer", name: "Hammer", direction: "long" },
  { id: "shootingStar", name: "Shooting Star", direction: "short" },
  { id: "invertedHammer", name: "Inverted Hammer", direction: "long" },
  { id: "hangingMan", name: "Hanging Man", direction: "short" },
  { id: "marubozu", name: "Marubozu", direction: "both" },
  { id: "doji", name: "Doji", direction: "neutral" },
  { id: "dragonflyDoji", name: "Dragonfly Doji", direction: "long" },
  { id: "gravestoneDoji", name: "Gravestone Doji", direction: "short" },
  { id: "spinningTop", name: "Spinning Top", direction: "neutral" },
  { id: "bullishEngulfing", name: "Bullish Engulfing", direction: "long" },
  { id: "bearishEngulfing", name: "Bearish Engulfing", direction: "short" },
  { id: "insideBar", name: "Inside Bar / Harami", direction: "both" },
  { id: "piercing", name: "Piercing Line", direction: "long" },
  { id: "darkCloud", name: "Dark Cloud Cover", direction: "short" },
  { id: "tweezer", name: "Tweezer Bottom / Top", direction: "both" },
  { id: "morningStar", name: "Morning Star", direction: "long" },
  { id: "eveningStar", name: "Evening Star", direction: "short" },
  { id: "threeWhiteSoldiers", name: "Three White Soldiers", direction: "long" },
  { id: "threeBlackCrows", name: "Three Black Crows", direction: "short" },
  { id: "threeInside", name: "Three Inside Up / Down", direction: "both" },
];

// Every hit in a session (used by the historical-stats pass). `ctx` is reused across bars.
export function detectAll(cs, ctx) {
  const hits = [];
  for (let i = 0; i < cs.length; i++) {
    for (const d of DETECTORS) {
      const h = d(cs, i, ctx);
      if (h) hits.push(h);
    }
  }
  return hits;
}

// Every hit at one bar (used on the latest completed candle).
export function detectAt(cs, i, ctx) {
  const hits = [];
  for (const d of DETECTORS) {
    const h = d(cs, i, ctx);
    if (h) hits.push(h);
  }
  return hits;
}

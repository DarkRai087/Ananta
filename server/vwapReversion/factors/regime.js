// Factor 1 — market regime (20). Mean reversion wants a balanced, range-bound session; a strong
// directional trend that rides the outer band is the main way this strategy loses.
//
//   trend strength   6   ADX(14); efficiency ratio stands in (max 4) until ADX is ready
//   +DI / −DI        3   balanced best; pressure against the trade costs points
//   VWAP slope       4   flat best; steep against the trade = 0
//   EMA 20 / 50      3   intertwined best; EMA 20 slope stands in (max 2) until EMA 50 is ready
//   swing structure  2   mixed swings best; HH/HL or LH/LL against the trade = 0
//   volatility       2   stable / contracting ATR best; expanding = 0
//
// Hard gate: no fading a strong trend (ADX ≥ 30, or ER ≥ 0.55 before ADX is ready) whose
// pressure is against the trade while price rides the ±2σ band or VWAP slopes steeply.
import { ptsAtOrBelow, line, factor, gate, num, fmt } from "../../decision/util.js";
import { bandAt } from "../setup.js";

// Confirmed fractal swing highs / lows (side bars on each side), bars 0..i.
export function swings(bars, i, side) {
  const highs = [];
  const lows = [];
  for (let k = side; k + side <= i; k++) {
    let hi = true;
    let lo = true;
    for (let j = k - side; j <= k + side; j++) {
      if (j === k) continue;
      if (j < k ? bars[j].high >= bars[k].high : bars[j].high > bars[k].high) hi = false;
      if (j < k ? bars[j].low <= bars[k].low : bars[j].low < bars[k].low) lo = false;
    }
    if (hi) highs.push(bars[k].high);
    if (lo) lows.push(bars[k].low);
  }
  return { highs, lows };
}

const meanTR = (bars, from, to) => {
  let s = 0;
  let n = 0;
  for (let k = Math.max(1, from); k <= to; k++) {
    const c = bars[k];
    const p = bars[k - 1];
    s += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    n++;
  }
  return n ? s / n : null;
};

export function regimeFactor(D) {
  const { ctx, cfg, i, long, S } = D;
  const R = cfg.regime;
  const atr = D.atr.value;
  const lines = [];

  const dm = ctx.ind("adx", [R.adxPeriod]);
  const adx = dm?.adx ?? null;
  const pdi = dm?.plusDI ?? null;
  const mdi = dm?.minusDI ?? null;
  const er = ctx.ind("er", [R.erBars]);

  // a) Trend strength.
  if (num(adx)) {
    lines.push(line("strength", "Trend strength (ADX 14)", ptsAtOrBelow(R.adxPoints, adx), 6, fmt(adx, 1), adx < 20 ? "weak trend — suits mean reversion" : adx >= 25 ? "strong trend — mean reversion is risky" : "moderate trend"));
  } else if (num(er)) {
    lines.push(line("strength", "Trend strength", ptsAtOrBelow(R.erPoints, er), 6, `ER ${fmt(er, 2)}`, `ADX(14) needs ${2 * R.adxPeriod} bars; efficiency ratio (${R.erBars}) stands in, worth at most 4`, "substitute"));
  } else {
    lines.push(line("strength", "Trend strength", 0, 6, null, `needs at least ${R.erBars + 1} bars`, "missing"));
  }

  // b) Directional pressure.
  let diSpread = null;
  if (num(pdi) && num(mdi)) {
    diSpread = pdi - mdi;
    const against = long ? -diSpread : diSpread;
    const balanced = Math.abs(diSpread) <= R.diBalanced;
    const pts = balanced ? 3 : against < 0 ? 2 : against <= R.diAgainstMax ? 1 : 0;
    const who = diSpread > 0 ? "buyers" : "sellers";
    lines.push(line("di", "+DI / −DI", pts, 3, `${fmt(pdi, 1)} / ${fmt(mdi, 1)}`, balanced ? "balanced" : `${who} in control${against > 0 ? " — against the trade" : ""}`));
  } else {
    lines.push(line("di", "+DI / −DI", 0, 3, null, `needs ${R.adxPeriod + 1} bars`, "missing"));
  }

  // c) VWAP slope, in ATRs per bar.
  let slope = null;
  const kb = i - R.slopeBars;
  if (kb >= 0 && num(S.vwap[kb]) && num(atr) && atr > 0) slope = (S.vwap[i] - S.vwap[kb]) / (R.slopeBars * atr);
  if (num(slope)) {
    const against = long ? -slope : slope;
    const mag = Math.abs(slope);
    const pts = mag <= R.slopeFlat ? 4 : mag <= R.slopeSteep ? (against > 0 ? 2 : 3) : against > 0 ? 0 : 2;
    const words = mag <= R.slopeFlat ? "flat" : `${mag > R.slopeSteep ? "steep" : "mild"} ${slope > 0 ? "rise" : "fall"}${against > 0 ? " against the trade" : ""}`;
    lines.push(line("slope", "VWAP slope", pts, 4, `${slope >= 0 ? "+" : ""}${fmt(slope, 3)} ATR/bar`, words));
  } else {
    lines.push(line("slope", "VWAP slope", 0, 4, null, `needs ${R.slopeBars + 1} bars and an ATR`, "missing"));
  }

  // d) EMA structure.
  const e20 = ctx.ind("ema", [R.emaFast]);
  const e50 = ctx.ind("ema", [R.emaSlow]);
  if (num(e20) && num(e50) && atr > 0) {
    const gap = (e20 - e50) / atr;
    const against = long ? -gap : gap;
    const pts = Math.abs(gap) <= R.emaFlatGap ? 3 : against < 0 ? 2 : against <= R.emaAgainstMax ? 1 : 0;
    const words = Math.abs(gap) <= R.emaFlatGap ? "intertwined (no trend)" : `EMA ${R.emaFast} ${gap > 0 ? "above" : "below"} EMA ${R.emaSlow} by ${fmt(Math.abs(gap), 1)} ATR${against > 0 ? " — trend against the trade" : ""}`;
    lines.push(line("ema", `EMA ${R.emaFast} / ${R.emaSlow}`, pts, 3, `${fmt(e20)} / ${fmt(e50)}`, words));
  } else {
    const e20b = ctx.ind("ema", [R.emaFast], R.ema20SlopeBars);
    if (num(e20) && num(e20b) && atr > 0) {
      const s = (e20 - e20b) / (R.ema20SlopeBars * atr);
      const against = long ? -s : s;
      const pts = Math.abs(s) <= R.ema20FlatSlope ? 2 : against < 0 ? 1 : 0;
      lines.push(line("ema", `EMA ${R.emaFast} / ${R.emaSlow}`, pts, 3, `EMA ${R.emaFast} ${fmt(e20)}`, `EMA ${R.emaSlow} needs ${R.emaSlow} bars; EMA ${R.emaFast} slope (${s >= 0 ? "+" : ""}${fmt(s, 3)} ATR/bar) stands in, worth at most 2`, "substitute"));
    } else {
      lines.push(line("ema", `EMA ${R.emaFast} / ${R.emaSlow}`, 0, 3, null, `EMA ${R.emaFast} needs ${R.emaFast + R.ema20SlopeBars} bars`, "missing"));
    }
  }

  // e) Swing structure.
  const sw = swings(S.bars, i, R.swingSide);
  let structure = null;
  if (sw.highs.length >= 2 && sw.lows.length >= 2) {
    const [h1, h2] = sw.highs.slice(-2);
    const [l1, l2] = sw.lows.slice(-2);
    const up = h2 > h1 && l2 > l1;
    const down = h2 < h1 && l2 < l1;
    structure = up ? "up" : down ? "down" : "mixed";
    const pts = structure === "mixed" ? 2 : (long ? up : down) ? 1 : 0;
    const words = up ? "higher highs and higher lows" : down ? "lower highs and lower lows" : "mixed swings (range)";
    lines.push(line("structure", "Swing structure", pts, 2, words, (long ? down : up) ? "trend against the trade" : ""));
  } else {
    lines.push(line("structure", "Swing structure", 0, 2, null, "needs two confirmed swing highs and lows", "missing"));
  }

  // f) Volatility expansion / contraction.
  let volRatio = null;
  const atrPrev = ctx.ind("atr", [14], R.volBars);
  const atrNow = ctx.ind("atr", [14]);
  if (num(atrNow) && num(atrPrev) && atrPrev > 0) volRatio = atrNow / atrPrev;
  else if (i >= 2 * R.volBars) {
    const a = meanTR(S.bars, i - R.volBars + 1, i);
    const b = meanTR(S.bars, i - 2 * R.volBars + 1, i - R.volBars);
    if (num(a) && num(b) && b > 0) volRatio = a / b;
  }
  if (num(volRatio)) {
    const pts = volRatio <= R.volStable ? 2 : volRatio <= R.volExpanding ? 1 : 0;
    lines.push(line("vol", "Volatility", pts, 2, `ATR ×${fmt(volRatio, 2)} vs ${R.volBars} bars ago`, volRatio <= R.volStable ? (volRatio < 0.95 ? "contracting" : "stable") : volRatio <= R.volExpanding ? "expanding a little" : "expanding — breakout risk"));
  } else {
    lines.push(line("vol", "Volatility", 0, 2, null, `needs ${2 * R.volBars} bars`, "missing"));
  }

  // Regime, bias, band ride, and the strong-trend gate.
  const m = cfg.setup.band;
  let rideUp = 0;
  let rideDown = 0;
  for (let k = Math.max(0, i - R.ridingBars + 1); k <= i; k++) {
    const up = bandAt(S, k, m, "short");
    const dn = bandAt(S, k, m, "long");
    if (up != null && S.bars[k].close > up) rideUp++;
    if (dn != null && S.bars[k].close < dn) rideDown++;
  }
  const trendDir = num(diSpread) && Math.abs(diSpread) > R.diBalanced ? Math.sign(diSpread) : num(slope) && Math.abs(slope) > R.slopeFlat ? Math.sign(slope) : 0;
  const strong = num(adx) ? adx >= R.strongAdx : num(er) ? er >= R.strongEr : false;
  const weak = num(adx) ? adx < 20 : num(er) ? er < 0.3 : null;
  const flat = num(slope) && Math.abs(slope) <= R.slopeFlat;
  const expanding = num(volRatio) && volRatio > R.volExpanding;
  let regime;
  if (strong) regime = trendDir > 0 ? "Trending up (strong)" : trendDir < 0 ? "Trending down (strong)" : "Strong directional move";
  else if (weak && (flat || slope == null)) regime = "Range-bound / balanced";
  else if (trendDir) regime = trendDir > 0 ? "Mild uptrend" : "Mild downtrend";
  else regime = "Balanced";
  if (expanding) regime += ", volatility expanding";
  const bias = trendDir > 0 ? "bullish" : trendDir < 0 ? "bearish" : "neutral";
  const riding = long ? rideDown : rideUp;
  const against = long ? trendDir < 0 : trendDir > 0;
  const steepAgainst = num(slope) && Math.abs(slope) > R.slopeSteep && (long ? slope < 0 : slope > 0);
  const blocked = strong && against && (riding >= R.ridingMin || steepAgainst);
  const gates = [
    gate(
      "trend",
      "Not fading a strong trend",
      !blocked,
      blocked
        ? `${long ? "Buying" : "Shorting"} into a strong ${long ? "down" : "up"}trend (${num(adx) ? `ADX ${fmt(adx, 1)}` : `ER ${fmt(er, 2)}`}${riding >= R.ridingMin ? `, ${riding} of the last ${R.ridingBars} closes beyond the ${long ? "−" : "+"}${m}σ band` : ", VWAP sloping steeply against"})`
        : strong && against
          ? "Strong trend against the trade, but price isn't riding the band — penalised in the score"
          : "No strong trend against the trade",
    ),
  ];

  const pts = lines.reduce((s, l) => s + l.points, 0);
  const observation = `${regime}; ${num(adx) ? `ADX ${fmt(adx, 1)}` : num(er) ? `ER ${fmt(er, 2)} (ADX warming up)` : "trend strength unknown"}; VWAP ${num(slope) ? (flat ? "flat" : slope > 0 ? "rising" : "falling") : "slope unknown"}${riding ? `; ${riding} recent closes beyond the band` : ""}`;
  return factor("regime", "Market regime", 20, lines, observation, {
    gates,
    details: { regime, bias, adx, plusDI: pdi, minusDI: mdi, er, slope, ema20: e20, ema50: e50, structure, volRatio, rideUp, rideDown, strong, trendDir, scoreForT3: pts },
  });
}

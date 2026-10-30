// The σ-band series and the setup state machine, from bars 0..i only (read through ctx).
//
// LONG (SHORT is the mirror image):
//   1. band test      a bar's low reaches the −2σ band          → that bar is the rejection candle
//                     (the latest such bar in the lookback window)
//   2. back inside    a completed candle closes above −2σ
//   3. trigger        a later completed candle closes above the rejection candle's high (and
//                     inside the band) → enter at the next bar's open
//
// States: none · stretched (tested, no close back inside yet) · armed (inside, waiting for the
// trigger) · triggered (trigger on THIS bar) · fired (trigger on an earlier bar) · stale (too
// many bars since the rejection candle) · failed (new extreme after the test, inside a widening band).

export const STATE_RANK = { triggered: 6, armed: 5, stretched: 4, fired: 3, stale: 2, failed: 1, none: 0 };

// Bars, VWAP and σ for bars from..i (earlier slots stay empty). σ is null while the bands warm up.
export function bandSeries(ctx, minBars, from = 0) {
  const i = ctx.i;
  const n = i + 1;
  ctx.bar(i); // lookahead guard: nothing past i is read below
  const cs = ctx.sd.candles;
  const vb = ctx.sd.get("vwapBands", 1);
  const bars = new Array(n);
  const vwap = new Array(n).fill(null);
  const sigma = new Array(n).fill(null);
  for (let k = Math.max(0, from); k <= i; k++) {
    bars[k] = cs[k];
    vwap[k] = vb.vwap[k];
    sigma[k] = vb.upper[k] == null || k + 1 < minBars ? null : vb.upper[k] - vb.vwap[k];
  }
  return { bars, vwap, sigma };
}

export const bandAt = (S, k, m, side) => (S.sigma[k] == null ? null : side === "long" ? S.vwap[k] - m * S.sigma[k] : S.vwap[k] + m * S.sigma[k]);

/**
 * The setup on one side at bar i. Returns
 * { side, state, t, t0, extIdx, extreme, triggerLevel, triggerIdx, insideIdx, barsSince, note }
 */
export function findSetup(S, side, i, cfg) {
  const long = side === "long";
  const m = cfg.band;
  const out = { side, state: "none", t: -1, t0: -1, extIdx: -1, extreme: null, triggerLevel: null, triggerIdx: -1, insideIdx: -1, barsSince: null, note: "" };
  const start = Math.max(cfg.minBars - 1, i - cfg.lookback + 1);
  const touched = (k) => {
    const b = bandAt(S, k, m, side);
    return b != null && (long ? S.bars[k].low <= b : S.bars[k].high >= b);
  };
  for (let k = i; k >= start; k--) {
    if (!touched(k)) continue;
    if (out.t < 0) out.t = k;
    out.t0 = k;
  }
  if (out.t < 0) return out;
  const { t, t0 } = out;

  // Swing extreme of the excursion (stop goes beyond it).
  let ext = long ? Infinity : -Infinity;
  for (let k = t0; k <= i; k++) {
    const x = long ? S.bars[k].low : S.bars[k].high;
    if (long ? x < ext : x > ext) {
      ext = x;
      out.extIdx = k;
    }
  }
  out.extreme = ext;
  out.barsSince = i - t;
  if (out.extIdx > t) {
    out.state = "failed";
    out.note = `made a new ${long ? "low" : "high"} after the band test while the band widened — repricing, not a stretch`;
    return out;
  }

  out.triggerLevel = long ? S.bars[t].high : S.bars[t].low;
  const inside = (k) => {
    const b = bandAt(S, k, m, side);
    return b != null && (long ? S.bars[k].close > b : S.bars[k].close < b);
  };
  for (let k = t; k <= i; k++) {
    if (out.insideIdx < 0 && inside(k)) out.insideIdx = k;
    if (k > t && out.triggerIdx < 0 && inside(k) && (long ? S.bars[k].close > out.triggerLevel : S.bars[k].close < out.triggerLevel)) out.triggerIdx = k;
  }

  if (out.triggerIdx >= 0) {
    if (out.triggerIdx - t > cfg.maxBarsToConfirm) out.state = "stale";
    else out.state = out.triggerIdx === i ? "triggered" : "fired";
  } else if (i - t >= cfg.maxBarsToConfirm) {
    out.state = "stale";
  } else {
    out.state = out.insideIdx >= 0 ? "armed" : "stretched";
  }
  return out;
}

// The side to report: the more advanced setup; both empty → the side nearer a band.
export function primarySetup(long, short, z) {
  const rl = STATE_RANK[long.state];
  const rs = STATE_RANK[short.state];
  if (rl === 0 && rs === 0) return z != null && z > 0 ? short : long;
  if (rl !== rs) return rl > rs ? long : short;
  return long.t >= short.t ? long : short;
}

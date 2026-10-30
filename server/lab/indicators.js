// Session indicators. Every function takes ONE session's candles (or values) and returns
// an array of the same length. The value at k uses only bars 0..k (causal), and nothing
// from previous sessions: EMAs, ATR, RSI etc. all restart at 09:15. null = not enough bars yet.
import { istMinute, OPEN_MIN } from "./time.js";

export const closes = (cs) => cs.map((c) => c.close);
export const volumes = (cs) => cs.map((c) => c.volume || 0);

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let k = 0; k < values.length; k++) {
    sum += values[k];
    if (k >= period) sum -= values[k - period];
    if (k >= period - 1) out[k] = sum / period;
  }
  return out;
}

// EMA seeded with the SMA of the first `period` values.
export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const a = 2 / (period + 1);
  let prev = 0;
  for (let k = 0; k < period; k++) prev += values[k];
  prev /= period;
  out[period - 1] = prev;
  for (let k = period; k < values.length; k++) {
    prev = values[k] * a + prev * (1 - a);
    out[k] = prev;
  }
  return out;
}

export function rollingStd(values, period) {
  const out = new Array(values.length).fill(null);
  for (let k = period - 1; k < values.length; k++) {
    let m = 0;
    for (let j = k - period + 1; j <= k; j++) m += values[j];
    m /= period;
    let v = 0;
    for (let j = k - period + 1; j <= k; j++) v += (values[j] - m) ** 2;
    out[k] = Math.sqrt(v / period);
  }
  return out;
}

// Session VWAP, reset at 09:15. Indices have no volume → equal-weighted typical price.
export function vwap(cs) {
  const out = new Array(cs.length);
  let pv = 0;
  let vol = 0;
  let tp = 0;
  for (let k = 0; k < cs.length; k++) {
    const c = cs[k];
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * (c.volume || 0);
    vol += c.volume || 0;
    tp += typical;
    out[k] = vol > 0 ? pv / vol : tp / (k + 1);
  }
  return out;
}

// VWAP ± mult × the volume-weighted standard deviation of typical price, reset at 09:15.
// Uses equal weights while there is no volume (indices), like vwap(). Bands are null for
// the first `minBars` bars, while the deviation is still meaningless.
export function vwapBands(cs, mult = 2, minBars = 3) {
  const n = cs.length;
  const out = { vwap: new Array(n).fill(null), upper: new Array(n).fill(null), lower: new Array(n).fill(null) };
  let pv = 0, pv2 = 0, vol = 0, tp = 0, tp2 = 0;
  for (let k = 0; k < n; k++) {
    const c = cs[k];
    const typical = (c.high + c.low + c.close) / 3;
    const v = c.volume || 0;
    pv += typical * v;
    pv2 += typical * typical * v;
    vol += v;
    tp += typical;
    tp2 += typical * typical;
    const mean = vol > 0 ? pv / vol : tp / (k + 1);
    const sq = vol > 0 ? pv2 / vol : tp2 / (k + 1);
    const sd = Math.sqrt(Math.max(0, sq - mean * mean));
    out.vwap[k] = mean;
    if (k + 1 >= minBars) {
      out.upper[k] = mean + mult * sd;
      out.lower[k] = mean - mult * sd;
    }
  }
  return out;
}

// True range inside the session (the first bar has no previous close → high − low).
export function trueRange(cs) {
  return cs.map((c, k) =>
    k === 0 ? c.high - c.low : Math.max(c.high - c.low, Math.abs(c.high - cs[k - 1].close), Math.abs(c.low - cs[k - 1].close))
  );
}

// Wilder ATR.
export function atr(cs, period) {
  const tr = trueRange(cs);
  const out = new Array(cs.length).fill(null);
  if (cs.length < period) return out;
  let prev = 0;
  for (let k = 0; k < period; k++) prev += tr[k];
  prev /= period;
  out[period - 1] = prev;
  for (let k = period; k < cs.length; k++) {
    prev = (prev * (period - 1) + tr[k]) / period;
    out[k] = prev;
  }
  return out;
}

/**
 * Wilder's directional movement system: { plusDI, minusDI, adx }.
 * +DI / −DI are first known at index `period` (they need `period` bar-to-bar moves, and the
 * first bar of the session has none); ADX, the Wilder average of DX, at index 2 × period − 1.
 * On 5m bars with period 14 that is 10:25 for the DIs and 11:30 for ADX.
 */
export function adx(cs, period = 14) {
  const n = cs.length;
  const out = { plusDI: new Array(n).fill(null), minusDI: new Array(n).fill(null), adx: new Array(n).fill(null) };
  if (n <= period) return out;
  let tr = 0;
  let pdm = 0;
  let mdm = 0;
  let dxSum = 0;
  let adxPrev = null;
  for (let k = 1; k < n; k++) {
    const c = cs[k];
    const p = cs[k - 1];
    const up = c.high - p.high;
    const down = p.low - c.low;
    const plus = up > down && up > 0 ? up : 0;
    const minus = down > up && down > 0 ? down : 0;
    const t = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    if (k <= period) {
      tr += t;
      pdm += plus;
      mdm += minus;
      if (k < period) continue;
    } else {
      tr = tr - tr / period + t;
      pdm = pdm - pdm / period + plus;
      mdm = mdm - mdm / period + minus;
    }
    const pdi = tr > 0 ? (100 * pdm) / tr : 0;
    const mdi = tr > 0 ? (100 * mdm) / tr : 0;
    out.plusDI[k] = pdi;
    out.minusDI[k] = mdi;
    const dx = pdi + mdi > 0 ? (100 * Math.abs(pdi - mdi)) / (pdi + mdi) : 0;
    if (k < 2 * period - 1) {
      dxSum += dx;
    } else if (k === 2 * period - 1) {
      adxPrev = (dxSum + dx) / period;
      out.adx[k] = adxPrev;
    } else {
      adxPrev = (adxPrev * (period - 1) + dx) / period;
      out.adx[k] = adxPrev;
    }
  }
  return out;
}

// MACD: EMA(fast) − EMA(slow), its EMA(signal), and the histogram (macd − signal). The line is
// first known at index slow − 1, the signal and histogram at slow + signal − 2 (on 5m bars with
// 12/26/9 that is 11:20 and 12:00).
export function macd(values, fast = 12, slow = 26, signal = 9) {
  const n = values.length;
  const f = ema(values, fast);
  const sl = ema(values, slow);
  const line = values.map((_, k) => (f[k] == null || sl[k] == null ? null : f[k] - sl[k]));
  const sig = new Array(n).fill(null);
  const first = slow - 1;
  if (n > first) {
    const s2 = ema(line.slice(first), signal);
    for (let k = 0; k < s2.length; k++) sig[first + k] = s2[k];
  }
  return { macd: line, signal: sig, hist: line.map((v, k) => (v == null || sig[k] == null ? null : v - sig[k])) };
}

// Kaufman efficiency ratio over `n` bars: |net move| ÷ sum of |bar moves|, in [0, 1].
// Near 0 = choppy / balanced, near 1 = one-way trend. First value at index n.
export function efficiencyRatio(values, n = 10) {
  const out = new Array(values.length).fill(null);
  for (let k = n; k < values.length; k++) {
    let path = 0;
    for (let j = k - n + 1; j <= k; j++) path += Math.abs(values[j] - values[j - 1]);
    out[k] = path > 0 ? Math.abs(values[k] - values[k - n]) / path : 0;
  }
  return out;
}

// Wilder RSI. First value at index `period`.
export function rsi(values, period = 14) {
  const out = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let k = 1; k <= period; k++) {
    const d = values[k] - values[k - 1];
    if (d > 0) gain += d;
    else loss -= d;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let k = period + 1; k < values.length; k++) {
    const d = values[k] - values[k - 1];
    gain = (gain * (period - 1) + Math.max(d, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    out[k] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const sd = rollingStd(values, period);
  return {
    mid,
    upper: mid.map((m, k) => (m == null ? null : m + mult * sd[k])),
    lower: mid.map((m, k) => (m == null ? null : m - mult * sd[k])),
  };
}

// Keltner channel: EMA(close) ± mult × ATR, both over `period` bars.
export function keltner(cs, period = 20, mult = 1.5) {
  const mid = ema(closes(cs), period);
  const a = atr(cs, period);
  return {
    mid,
    upper: mid.map((m, k) => (m == null || a[k] == null ? null : m + mult * a[k])),
    lower: mid.map((m, k) => (m == null || a[k] == null ? null : m - mult * a[k])),
  };
}

// Supertrend. dir: 1 = up (line below price), -1 = down (line above price).
export function supertrend(cs, period = 10, mult = 3) {
  const a = atr(cs, period);
  const n = cs.length;
  const value = new Array(n).fill(null);
  const dir = new Array(n).fill(null);
  let upper = null;
  let lower = null;
  let d = 1;
  for (let k = 0; k < n; k++) {
    if (a[k] == null) continue;
    const hl2 = (cs[k].high + cs[k].low) / 2;
    const bu = hl2 + mult * a[k];
    const bl = hl2 - mult * a[k];
    const prevClose = k > 0 ? cs[k - 1].close : cs[k].close;
    if (upper == null) {
      upper = bu;
      lower = bl;
      d = cs[k].close >= hl2 ? 1 : -1;
    } else {
      upper = bu < upper || prevClose > upper ? bu : upper;
      lower = bl > lower || prevClose < lower ? bl : lower;
      if (d === 1 && cs[k].close < lower) d = -1;
      else if (d === -1 && cs[k].close > upper) d = 1;
    }
    dir[k] = d;
    value[k] = d === 1 ? lower : upper;
  }
  return { value, dir };
}

/**
 * Opening range over the first `minutes` of the session (from 09:15).
 * Returns { high, low, completeIndex }: the range is known at the CLOSE of completeIndex.
 * If the bar size is larger than the range, the first bar is the range.
 */
export function openingRange(cs, minutes, intervalMin) {
  if (!cs.length) return null;
  const end = OPEN_MIN + Math.max(minutes, intervalMin);
  let high = -Infinity;
  let low = Infinity;
  let last = -1;
  for (let k = 0; k < cs.length; k++) {
    const m = istMinute(cs[k].time);
    if (m >= end) break;
    if (cs[k].high > high) high = cs[k].high;
    if (cs[k].low < low) low = cs[k].low;
    last = k;
  }
  if (last < 0) return null;
  // Complete once the last bar inside the range has closed at/after the range end.
  const complete = istMinute(cs[last].time) + intervalMin >= end;
  return { high, low, completeIndex: complete ? last : Infinity };
}

// Classic floor pivots + CPR from the previous session's high/low/close.
export function pivots(prev) {
  if (!prev) return null;
  const { high: H, low: L, close: C } = prev;
  const P = (H + L + C) / 3;
  const bc0 = (H + L) / 2;
  const tc0 = 2 * P - bc0;
  return {
    pivot: P,
    bc: Math.min(bc0, tc0),
    tc: Math.max(bc0, tc0),
    r1: 2 * P - L,
    s1: 2 * P - H,
    r2: P + (H - L),
    s2: P - (H - L),
    r3: H + 2 * (P - L),
    s3: L - 2 * (H - P),
    // CPR width as % of the pivot. Narrow CPR often comes before a trending day.
    cprWidthPct: (Math.abs(tc0 - bc0) / P) * 100,
    // Camarilla levels.
    h3: C + (1.1 * (H - L)) / 4,
    h4: C + (1.1 * (H - L)) / 2,
    l3: C - (1.1 * (H - L)) / 4,
    l4: C - (1.1 * (H - L)) / 2,
  };
}

// Daily ATR: simple mean true range of the last `n` daily bars (oldest first, all before
// today). Each bar's previous close is the bar before it; the first has none (high − low).
// null if there are fewer than `n` bars.
export function dailyAtr(daily, n = 14) {
  if (!daily || daily.length < n) return null;
  let sum = 0;
  for (let k = daily.length - n; k < daily.length; k++) {
    const d = daily[k];
    const pc = k > 0 ? daily[k - 1].close : null;
    sum += pc == null ? d.high - d.low : Math.max(d.high - d.low, Math.abs(d.high - pc), Math.abs(d.low - pc));
  }
  return sum / n;
}

export function highest(cs, from, to, field = "high") {
  let v = -Infinity;
  for (let k = Math.max(0, from); k <= to; k++) if (cs[k][field] > v) v = cs[k][field];
  return v;
}

export function lowest(cs, from, to, field = "low") {
  let v = Infinity;
  for (let k = Math.max(0, from); k <= to; k++) if (cs[k][field] < v) v = cs[k][field];
  return v;
}

// Small causal helpers for prediction models. Every function reads only the END of the
// arrays it is given; the runners hand models data that stops at "now", so nothing here can
// see the future.

export const closesOf = (bars) => bars.map((b) => b.close);
export const last = (a, ago = 0) => a[a.length - 1 - ago];
export const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);
export const clamp = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x));
export const squash = (x) => Math.tanh(x);
export const pct = (x, digits = 2) => `${x >= 0 ? "+" : ""}${(x * 100).toFixed(digits)}%`;

// Simple average of the last n values, `ago` values back. null if there aren't enough.
export function smaLast(values, n, ago = 0) {
  const end = values.length - ago;
  if (end < n || n <= 0) return null;
  let s = 0;
  for (let k = end - n; k < end; k++) s += values[k];
  return s / n;
}

// Return over the last n steps.
export function roc(values, n) {
  if (values.length <= n) return null;
  return values[values.length - 1] / values[values.length - 1 - n] - 1;
}

// Standard deviation of the last n one-step returns.
export function returnVol(values, n) {
  if (values.length <= n) return null;
  const r = [];
  for (let k = values.length - n; k < values.length; k++) r.push(values[k] / values[k - 1] - 1);
  const m = mean(r);
  return Math.sqrt(r.reduce((s, x) => s + (x - m) ** 2, 0) / Math.max(1, r.length - 1));
}

// Cutler's RSI (simple averages) over the last n changes.
export function rsiLast(values, n) {
  if (values.length <= n) return null;
  let up = 0;
  let dn = 0;
  for (let k = values.length - n; k < values.length; k++) {
    const d = values[k] - values[k - 1];
    if (d > 0) up += d;
    else dn -= d;
  }
  if (up + dn === 0) return 50;
  return (100 * up) / (up + dn);
}

// Highest high / lowest low over the last n bars.
export function channel(bars, n) {
  if (bars.length < n) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let k = bars.length - n; k < bars.length; k++) {
    if (bars[k].high > hi) hi = bars[k].high;
    if (bars[k].low < lo) lo = bars[k].low;
  }
  return { high: hi, low: lo };
}

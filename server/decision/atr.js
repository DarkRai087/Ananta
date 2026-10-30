// A typical bar range at each bar k, from bars 0..k only: ATR(14) once it is ready, before that
// the mean true range of the session so far, before that a slice of the 14-day daily ATR.
// Each value depends only on bars ≤ k, so a decision made at bar k never changes later.
export function atrSeries(ctx, i) {
  const out = new Array(i + 1).fill(null);
  const src = new Array(i + 1).fill(null);
  let trSum = 0;
  for (let k = 0; k <= i; k++) {
    const c = ctx.bar(k);
    if (k > 0) {
      const p = ctx.bar(k - 1);
      trSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    const a = ctx.ind("atr", [14], i - k);
    if (a > 0) {
      out[k] = a;
      src[k] = "ATR(14)";
    } else if (k >= 3 && trSum > 0) {
      out[k] = trSum / k;
      src[k] = `mean true range of ${k} bars (ATR 14 not ready)`;
    } else if (ctx.ref.atrDaily) {
      out[k] = ctx.ref.atrDaily * 0.15;
      src[k] = "15% of the 14-day daily ATR (too few bars)";
    } else {
      out[k] = c.close * 0.003;
      src[k] = "0.3% of price (no ATR yet)";
    }
  }
  return { value: out, source: src };
}

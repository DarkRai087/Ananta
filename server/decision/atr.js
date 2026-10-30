// A typical bar range at each bar k, from bars 0..k only: ATR(14) once it is ready, before that
// the mean true range of the session so far, before that a slice of the 14-day daily ATR.
// Each value depends only on bars ≤ k, so the series is built once per session and cut at i.
export function atrSeries(ctx, i) {
  const full = ctx.sd.memo("atrSeries", () => build(ctx.sd, ctx.ref.atrDaily));
  return { value: full.value.slice(0, i + 1), source: full.source.slice(0, i + 1) };
}

function build(sd, atrDaily) {
  const cs = sd.candles;
  const a14 = sd.get("atr", 14);
  const value = new Array(cs.length);
  const source = new Array(cs.length);
  let trSum = 0;
  for (let k = 0; k < cs.length; k++) {
    const c = cs[k];
    if (k > 0) {
      const p = cs[k - 1];
      trSum += Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    if (a14[k] > 0) {
      value[k] = a14[k];
      source[k] = "ATR(14)";
    } else if (k >= 3 && trSum > 0) {
      value[k] = trSum / k;
      source[k] = `mean true range of ${k} bars (ATR 14 not ready)`;
    } else if (atrDaily) {
      value[k] = atrDaily * 0.15;
      source[k] = "15% of the 14-day daily ATR (too few bars)";
    } else {
      value[k] = c.close * 0.003;
      source[k] = "0.3% of price (no ATR yet)";
    }
  }
  return { value, source };
}

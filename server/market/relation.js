// How closely a stock follows an index: correlation, beta, and how often they close the
// same way. These describe the SAME day (both moves known only at the close); whether the
// index's move so far predicts the stock's rest of day is tested in the prediction module.
import { istMinute } from "../lab/time.js";

const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;

function corrBeta(xs, ys) {
  // ys on xs: beta = cov / var(x).
  const n = xs.length;
  if (n < 10) return { corr: null, beta: null, n };
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let k = 0; k < n; k++) {
    sxy += (xs[k] - mx) * (ys[k] - my);
    sxx += (xs[k] - mx) ** 2;
    syy += (ys[k] - my) ** 2;
  }
  return { corr: sxx && syy ? sxy / Math.sqrt(sxx * syy) : null, beta: sxx ? sxy / sxx : null, n };
}

/**
 * Daily: stock and index daily bars (oldest first, time = date key). Uses the last `days`
 * days both have. Returns { corr, beta, n, downWhenDown, upWhenUp, indexDownDays, indexUpDays }.
 */
export function dailyRelation(stock, index, days = 250) {
  const ix = new Map(index.map((b, k) => [b.time, k]));
  const xs = [];
  const ys = [];
  for (let k = 1; k < stock.length; k++) {
    const j = ix.get(stock[k].time);
    const jp = ix.get(stock[k - 1].time);
    if (j == null || jp == null || j !== jp + 1) continue;
    xs.push(index[j].close / index[jp].close - 1);
    ys.push(stock[k].close / stock[k - 1].close - 1);
  }
  const x = xs.slice(-days);
  const y = ys.slice(-days);
  const downIdx = x.map((v, k) => [v, y[k]]).filter(([v]) => v < 0);
  const upIdx = x.map((v, k) => [v, y[k]]).filter(([v]) => v > 0);
  return {
    ...corrBeta(x, y),
    indexDownDays: downIdx.length,
    indexUpDays: upIdx.length,
    downWhenDown: downIdx.length ? downIdx.filter(([, s]) => s < 0).length / downIdx.length : null,
    upWhenUp: upIdx.length ? upIdx.filter(([, s]) => s > 0).length / upIdx.length : null,
  };
}

/**
 * Intraday: bar-by-bar returns of matching bars (same start time) over the last `sessions`
 * sessions both have. Returns { corr, beta, n, sessions }.
 */
export function intradayRelation(stockSessions, indexSessions, sessions = 60) {
  const ixByDate = new Map(indexSessions.map((s) => [s.date, s]));
  const xs = [];
  const ys = [];
  let used = 0;
  for (const s of stockSessions.slice(-sessions)) {
    const ix = ixByDate.get(s.date);
    if (!ix) continue;
    used++;
    const byTime = new Map(ix.candles.map((c) => [c.time, c]));
    for (let k = 1; k < s.candles.length; k++) {
      const a = byTime.get(s.candles[k].time);
      const b = byTime.get(s.candles[k - 1].time);
      if (!a || !b || istMinute(s.candles[k].time) < 9 * 60 + 20) continue;
      xs.push(a.close / b.close - 1);
      ys.push(s.candles[k].close / s.candles[k - 1].close - 1);
    }
  }
  return { ...corrBeta(xs, ys), sessions: used };
}

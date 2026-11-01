// Trade-list statistics. All money figures are AFTER costs unless named gross.
// A win is a trade that made money after all charges (net > 0), whatever the exit — target,
// stop, trailing stop, exit signal or the 15:15 square-off. How trades ended is in `exits`.
import { TIME_BUCKETS } from "../lab/time.js";

const mean = (a) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : null);

/**
 * 95% range for a win rate of k out of n (Wilson score interval), in percent. With few trades
 * the true rate can be far from what was measured; this shows how far.
 */
export function winRange(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n;
  const z2 = z * z;
  const den = 1 + z2 / n;
  const mid = (p + z2 / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / den;
  return [Math.max(0, mid - half) * 100, Math.min(1, mid + half) * 100];
}

// How trades ended (the engine's trade.reason).
const EXIT_TYPES = ["target", "stop", "trail", "signal", "forced"];

export function metrics(trades, { withEquity = false } = {}) {
  const n = trades.length;
  const wins = trades.filter((t) => t.net > 0);
  const losses = trades.filter((t) => !(t.net > 0));
  const forced = trades.filter((t) => t.reason === "forced");
  const pos = trades.reduce((s, t) => s + (t.net > 0 ? t.net : 0), 0);
  const neg = trades.reduce((s, t) => s + (t.net < 0 ? -t.net : 0), 0);

  // Equity / drawdown in time order.
  const sorted = [...trades].sort((a, b) => a.exitTime - b.exitTime || a.entryTime - b.entryTime);
  let eq = 0;
  let peak = 0;
  let maxDd = 0;
  const equity = [];
  for (const t of sorted) {
    eq += t.net;
    if (eq > peak) peak = eq;
    if (peak - eq > maxDd) maxDd = peak - eq;
    if (withEquity) equity.push({ time: t.exitTime, value: eq });
  }

  const byBucket = {};
  for (const b of TIME_BUCKETS) {
    const bt = trades.filter((t) => t.bucket === b.id);
    byBucket[b.id] = {
      label: b.label,
      trades: bt.length,
      winPct: bt.length ? (bt.filter((t) => t.net > 0).length / bt.length) * 100 : null,
      expectancyR: mean(bt.map((t) => t.rNet)),
      netPnl: bt.reduce((s, t) => s + t.net, 0),
    };
  }

  const [winLow, winHigh] = winRange(wins.length, n);
  const avgWinRs = mean(wins.map((t) => t.net));
  const avgLossRs = mean(losses.map((t) => t.net));
  const out = {
    trades: n,
    wins: wins.length,
    losses: losses.length,
    forced: forced.length,
    // Win % = made money after charges; lossPct = 100 − winPct. forcedPct = closed at 15:15.
    winPct: n ? (wins.length / n) * 100 : null,
    winLow,
    winHigh,
    lossPct: n ? (losses.length / n) * 100 : null,
    forcedPct: n ? (forced.length / n) * 100 : null,
    // Win % needed to break even with these average win and loss sizes.
    breakEvenWinPct: avgWinRs > 0 && avgLossRs < 0 ? (-avgLossRs / (avgWinRs - avgLossRs)) * 100 : null,
    exits: Object.fromEntries(EXIT_TYPES.map((k) => [k, n ? (trades.filter((t) => t.reason === k).length / n) * 100 : null])),
    avgWinR: mean(wins.map((t) => t.rNet)),
    avgLossR: mean(losses.map((t) => t.rNet)),
    avgWinRs,
    avgLossRs,
    avgForcedR: mean(forced.map((t) => t.rNet)),
    avgHoldMin: mean(trades.map((t) => (t.exitTime - t.entryTime) / 60)),
    expectancyRs: mean(trades.map((t) => t.net)),
    expectancyR: mean(trades.map((t) => t.rNet)),
    grossExpectancyR: mean(trades.map((t) => t.rGross)),
    profitFactor: neg > 0 ? pos / neg : pos > 0 ? Infinity : null,
    maxDrawdown: maxDd,
    grossPnl: trades.reduce((s, t) => s + t.gross, 0),
    netPnl: trades.reduce((s, t) => s + t.net, 0),
    totalCosts: trades.reduce((s, t) => s + t.costs, 0),
    byBucket,
  };
  if (withEquity) out.equity = equity;
  return out;
}

// Walk-forward verdict from in-sample vs out-of-sample metrics.
export function walkForwardFlag(is, oos, minTrades = 1) {
  if (!is.trades || !oos.trades || oos.trades < minTrades) return { id: "insufficient", label: "Not enough trades to judge" };
  const isPos = is.expectancyR > 0;
  const oosPos = oos.expectancyR > 0;
  if (isPos && oosPos) return { id: "holds", label: "Holds out-of-sample" };
  if (isPos && !oosPos) return { id: "is-only", label: "Works in-sample only" };
  if (!isPos && oosPos) return { id: "oos-only", label: "Positive only out-of-sample (unstable)" };
  return { id: "none", label: "No edge in either period" };
}

import { closesOf, last, smaLast, roc, pct } from "../../features.js";

export default {
  id: "indexTrend",
  name: "Index trend",
  kind: "daily",
  needsIndex: true,
  description: "The trend of the share's own index (its sector index, else NIFTY 50): index above its 20 and 50-day averages, 20-day average rising, 10-day return positive. Index trending up → bullish for the share.",
  params: { fast: 20, slow: 50, slopeDays: 5, momDays: 10 },
  lookback: () => 1,
  indexLookback: (p) => p.slow + p.slopeDays + 1,
  predict(_bars, p, ctx) {
    const ib = ctx?.index?.bars;
    if (!ib || ib.length < p.slow + p.slopeDays) return null;
    const c = closesOf(ib);
    const px = last(c);
    const f = smaLast(c, p.fast);
    const s = smaLast(c, p.slow);
    const fPrev = smaLast(c, p.fast, p.slopeDays);
    const m = roc(c, p.momDays);
    const n = ctx.index.name;
    const votes = [
      [px > f, `${n} ${px > f ? "above" : "below"} its ${p.fast}-day average`],
      [px > s, `${n} ${px > s ? "above" : "below"} its ${p.slow}-day average`],
      [f > fPrev, `${n} ${p.fast}-day average ${f > fPrev ? "rising" : "falling"}`],
      [m > 0, `${n} ${pct(m)} over ${p.momDays} days`],
    ];
    return { score: votes.reduce((a, [up]) => a + (up ? 1 : -1), 0) / votes.length, reasons: votes.map(([, r]) => r) };
  },
};

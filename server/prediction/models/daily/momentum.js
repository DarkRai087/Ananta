import { closesOf, roc, returnVol, squash, pct } from "../../features.js";

export default {
  id: "momentum",
  name: "Momentum",
  kind: "daily",
  description: "The 20-day and 60-day returns, scaled by the stock's own volatility. Strong recent gains → bullish (momentum tends to persist for weeks).",
  params: { short: 20, long: 60, volDays: 20 },
  lookback: (p) => Math.max(p.long, p.volDays) + 2,
  predict(bars, p) {
    const c = closesOf(bars);
    const vol = returnVol(c, p.volDays);
    const r1 = roc(c, p.short);
    const r2 = roc(c, p.long);
    if (!vol || r1 == null || r2 == null) return null;
    const z1 = r1 / (vol * Math.sqrt(p.short));
    const z2 = r2 / (vol * Math.sqrt(p.long));
    return {
      score: 0.5 * squash(z1) + 0.5 * squash(z2),
      reasons: [`${p.short}-day return ${pct(r1)} (${z1.toFixed(1)}σ)`, `${p.long}-day return ${pct(r2)} (${z2.toFixed(1)}σ)`],
    };
  },
};

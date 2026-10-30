import { closesOf, roc, returnVol, rsiLast, squash, pct } from "../../features.js";

export default {
  id: "meanReversion",
  name: "Short-term reversal",
  kind: "daily",
  description: "Contrarian: a sharp 3-day drop (oversold) → bullish bounce expected; a sharp 3-day rise → bearish pullback. Short-term reversal is strongest over 1–5 days.",
  params: { days: 3, volDays: 20, rsiDays: 3 },
  lookback: (p) => Math.max(p.volDays, p.days, p.rsiDays) + 2,
  predict(bars, p) {
    const c = closesOf(bars);
    const vol = returnVol(c, p.volDays);
    const r = roc(c, p.days);
    const rsi = rsiLast(c, p.rsiDays);
    if (!vol || r == null || rsi == null) return null;
    const z = r / (vol * Math.sqrt(p.days));
    return {
      score: -squash(0.8 * z),
      reasons: [`${p.days}-day move ${pct(r)} (${z.toFixed(1)}σ)`, `RSI(${p.rsiDays}) ${rsi.toFixed(0)}${rsi < 20 ? " — oversold" : rsi > 80 ? " — overbought" : ""}`],
    };
  },
};

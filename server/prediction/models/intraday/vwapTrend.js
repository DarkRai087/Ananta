import { vwap, dailyAtr } from "../../../lab/indicators.js";
import { last, squash } from "../../features.js";

export default {
  id: "vwapTrend",
  name: "VWAP trend",
  kind: "intraday",
  description: "Price above a rising VWAP → bullish for the rest of the day; below a falling VWAP → bearish. Distance is measured in units of the daily ATR.",
  params: { slopeBars: 6, atrDays: 14, atrFraction: 0.25 },
  minBars: 3,
  predict(v, p) {
    const { bars } = v;
    if (bars.length < 3) return null;
    const vw = vwap(bars);
    const now = last(vw);
    const then = vw[Math.max(0, vw.length - 1 - p.slopeBars)];
    const px = last(bars).close;
    const atr = dailyAtr(v.daily, p.atrDays);
    const unit = atr ? atr * p.atrFraction : px * 0.003;
    const dist = (px - now) / unit;
    const slope = Math.sign(now - then);
    return {
      score: 0.7 * squash(dist) + 0.3 * slope,
      reasons: [`price ${px >= now ? "above" : "below"} VWAP ${now.toFixed(2)} (${dist.toFixed(1)} units)`, `VWAP ${slope > 0 ? "rising" : slope < 0 ? "falling" : "flat"}`],
    };
  },
};

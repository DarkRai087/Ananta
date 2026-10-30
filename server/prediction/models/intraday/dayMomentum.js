import { dailyAtr } from "../../../lab/indicators.js";
import { last, squash, pct } from "../../features.js";

export default {
  id: "dayMomentum",
  name: "Intraday momentum",
  kind: "intraday",
  description: "The move from yesterday's close to now, in daily-ATR units. Research on index futures finds the early-day move tends to continue into the close.",
  params: { atrDays: 14, scale: 0.5 },
  minBars: 1,
  predict(v, p) {
    const pdc = v.prev?.close;
    if (!pdc || !v.bars.length) return null;
    const px = last(v.bars).close;
    const atr = dailyAtr(v.daily, p.atrDays) ?? pdc * 0.012;
    const move = (px - pdc) / atr;
    return { score: squash(move / p.scale), reasons: [`${pct(px / pdc - 1)} vs previous close (${move.toFixed(2)}× daily ATR)`] };
  },
};

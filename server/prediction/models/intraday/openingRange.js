import { openingRange } from "../../../lab/indicators.js";
import { last, clamp } from "../../features.js";

export default {
  id: "openingRange",
  name: "Opening range position",
  kind: "intraday",
  description: "Above the opening-range high → bullish; below the low → bearish; inside → a weak lean toward the nearer edge. No call until the range completes.",
  params: { orMinutes: 15 },
  minBars: 1,
  predict(v, p) {
    const or = openingRange(v.bars, p.orMinutes, v.intervalMin);
    if (!or || !Number.isFinite(or.completeIndex)) return null;
    const w = or.high - or.low;
    if (!(w > 0)) return null;
    const px = last(v.bars).close;
    const where = `opening range ${or.low.toFixed(2)}–${or.high.toFixed(2)}`;
    if (px > or.high) return { score: clamp(0.5 + (px - or.high) / w), reasons: [`price above the ${where}`] };
    if (px < or.low) return { score: clamp(-0.5 - (or.low - px) / w), reasons: [`price below the ${where}`] };
    const pos = (px - or.low) / w;
    return { score: (pos - 0.5) * 0.6, reasons: [`price inside the ${where} (${(pos * 100).toFixed(0)}% up)`] };
  },
};

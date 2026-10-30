import { vwap } from "../../../lab/indicators.js";
import { last, squash, pct } from "../../features.js";

export default {
  id: "indexTrend",
  name: "Index direction",
  kind: "intraday",
  needsIndex: true,
  description: "Is the share's own index (its sector index, else NIFTY 50) up or down so far today? Index above its VWAP and above yesterday's close → bullish for the share's rest of day.",
  params: { vwapUnitPct: 0.15, moveUnitPct: 0.5 },
  minBars: 1,
  predict(v, p) {
    const ix = v.index;
    if (!ix?.bars?.length || !ix.prev?.close) return null;
    const px = last(ix.bars).close;
    const vw = last(vwap(ix.bars));
    const a = ((px / vw - 1) * 100) / p.vwapUnitPct;
    const b = ((px / ix.prev.close - 1) * 100) / p.moveUnitPct;
    return {
      score: 0.5 * squash(a) + 0.5 * squash(b),
      reasons: [`${ix.name} ${pct(px / ix.prev.close - 1)} on the day`, `${ix.name} ${px >= vw ? "above" : "below"} its VWAP`],
    };
  },
};

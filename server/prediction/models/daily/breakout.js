import { closesOf, last, channel, clamp } from "../../features.js";

export default {
  id: "breakout",
  name: "Range position (Donchian)",
  kind: "daily",
  description: "Where the price sits in its 20-day high–low range. Near the top or at a new high → bullish; near the bottom → bearish.",
  params: { days: 20 },
  lookback: (p) => p.days + 1,
  predict(bars, p) {
    const ch = channel(bars, p.days);
    if (!ch || ch.high <= ch.low) return null;
    const px = last(closesOf(bars));
    const pos = (px - ch.low) / (ch.high - ch.low);
    const reasons = [`price at ${(pos * 100).toFixed(0)}% of the ${p.days}-day range (${ch.low.toFixed(2)}–${ch.high.toFixed(2)})`];
    if (last(bars).high >= ch.high) reasons.push(`made a new ${p.days}-day high`);
    if (last(bars).low <= ch.low) reasons.push(`made a new ${p.days}-day low`);
    return { score: clamp(2 * pos - 1), reasons };
  },
};

// Candle shape metrics shared by the decision engines.

// Body / wick / close-position metrics of one candle, for a long (long = true) or a short.
//   closePos       from the low for a long (1 = closed at the high), from the high for a short
//   wickPct        the wick on the far side (long: lower) — a reversal's rejection wick
//   againstWickPct the wick on the near side (long: upper) — selling into a breakout
export function candleMetrics(c, long) {
  const range = c.high - c.low;
  if (!(range > 0)) return { range: 0, bodyPct: 0, upperWickPct: 0, lowerWickPct: 0, closePos: 0.5, wickPct: 0, againstWickPct: 0, bull: false, bear: false };
  const top = Math.max(c.open, c.close);
  const bot = Math.min(c.open, c.close);
  const upperWickPct = (c.high - top) / range;
  const lowerWickPct = (bot - c.low) / range;
  return {
    range,
    body: top - bot,
    bodyPct: (top - bot) / range,
    upperWickPct,
    lowerWickPct,
    // Wick on the far side of a long (lower) — the rejection wick for a reversal setup.
    wickPct: long ? lowerWickPct : upperWickPct,
    // Wick on the near side of a long (upper) — selling into a breakout.
    againstWickPct: long ? upperWickPct : lowerWickPct,
    closePos: long ? (c.close - c.low) / range : (c.high - c.close) / range,
    bull: c.close > c.open,
    bear: c.close < c.open,
  };
}

// Factor 4 — breakout candle strength (15). The candle that closed beyond ORH / ORL.
//
//   body ratio         4   |close − open| ÷ range, and the right colour
//   closing position   4   long: (close − low) ÷ range
//   rejection wick     3   long: upper wick ÷ range (selling into the breakout), small best
//   size vs ATR        2   0.7–2 ATR decisive; feeble or climactic (> 3 ATR) = 0
//   clear of the level 2   close 0.1–0.6 ATR beyond the level; barely through or extended less
import { ptsAtOrAbove, ptsAtOrBelow, line, factor, fmt, rs } from "../../decision/util.js";
import { candleMetrics } from "../../decision/candle.js";

const inRange = (x, [lo, hi]) => x >= lo && x <= hi;

export function candleFactor(D) {
  const { setup, cfg, long, S, atr, timeOf } = D;
  const K = cfg.candle;
  const lines = [];
  const b = setup.b;
  if (b < 0) {
    for (const [k, l, m] of [["body", "Body ratio", 4], ["close", "Closing position", 4], ["wick", "Rejection wick", 3], ["size", "Size vs ATR", 2], ["clear", "Clear of the level", 2]]) lines.push(line(k, l, 0, m, null, "no breakout candle yet", "na"));
    return factor("candle", "Breakout candle", 15, lines, "No breakout candle yet", { details: null });
  }
  const c = S[b];
  const m = candleMetrics(c, long);
  const a = atr[b];
  const rightColour = long ? m.bull : m.bear;
  const sizeAtr = a > 0 ? m.range / a : null;
  const distAtr = a > 0 ? (long ? c.close - setup.level : setup.level - c.close) / a : null;

  lines.push(line("body", "Body ratio", rightColour ? ptsAtOrAbove(K.bodyPoints, m.bodyPct) : 0, 4, `${fmt(m.bodyPct * 100, 0)}% of the range`, rightColour ? "" : `${long ? "red" : "green"} candle — wrong colour for the breakout`));
  lines.push(line("close", "Closing position", ptsAtOrAbove(K.closePoints, m.closePos), 4, `${fmt(m.closePos * 100, 0)}% toward the ${long ? "high" : "low"}`, m.closePos < 0.5 ? "closed in the weak half" : ""));
  lines.push(line("wick", "Rejection wick", ptsAtOrBelow(K.wickPoints, m.againstWickPct), 3, `${long ? "upper" : "lower"} wick ${fmt(m.againstWickPct * 100, 0)}% of the range`, m.againstWickPct > 0.3 ? `${long ? "sellers" : "buyers"} pushed back at the highs` : ""));
  const sp = sizeAtr == null ? 0 : inRange(sizeAtr, K.sizeGoodAtr) ? 2 : inRange(sizeAtr, K.sizeOkAtr) ? 1 : 0;
  lines.push(line("size", "Size vs ATR", sp, 2, sizeAtr == null ? null : `${fmt(sizeAtr, 2)} ATR`, sizeAtr == null ? "" : sizeAtr > K.sizeOkAtr[1] ? "abnormally extended candle — chasing risk" : sizeAtr < K.sizeOkAtr[0] ? "feeble candle" : ""));
  const cp = distAtr == null ? 0 : inRange(distAtr, K.clearGoodAtr) ? 2 : distAtr > cfg.setup.maxExtensionAtr ? 0 : 1;
  lines.push(line("clear", "Clear of the level", cp, 2, distAtr == null ? null : `closed ${fmt(distAtr, 2)} ATR ${long ? "above ORH" : "below ORL"}`, distAtr == null ? "" : distAtr < K.clearGoodAtr[0] ? "barely through" : distAtr > K.clearGoodAtr[1] ? "already far from the level" : ""));

  const score = lines.reduce((s, l) => s + l.points, 0);
  const cls = score >= 12 ? "Strong" : score >= 8 ? "Moderate" : score >= 5 ? "Weak" : "Poor";
  return factor("candle", "Breakout candle", 15, lines, `${cls} ${timeOf(b)} candle: body ${fmt(m.bodyPct * 100, 0)}%, close ${fmt(m.closePos * 100, 0)}%, wick ${fmt(m.againstWickPct * 100, 0)}%`, {
    details: { index: b, time: timeOf(b), candle: c, metrics: m, sizeAtr, distAtr, classification: cls, closeText: rs(c.close) },
  });
}

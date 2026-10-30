import { closesOf, last, smaLast } from "../../features.js";

export default {
  id: "trend",
  name: "Trend (moving averages)",
  kind: "daily",
  description: "Five votes: price vs the 20, 50 and 200-day averages, the 50-day vs the 200-day, and whether the 20-day is rising. All up = +1, all down = −1.",
  params: { fast: 20, mid: 50, slow: 200, slopeDays: 5 },
  lookback: (p) => p.slow + p.slopeDays + 1,
  predict(bars, p) {
    const c = closesOf(bars);
    const px = last(c);
    const f = smaLast(c, p.fast);
    const m = smaLast(c, p.mid);
    const s = smaLast(c, p.slow);
    const fPrev = smaLast(c, p.fast, p.slopeDays);
    if ([f, m, s, fPrev].some((x) => x == null)) return null;
    const votes = [
      [px > f, `price ${px > f ? "above" : "below"} the ${p.fast}-day average (${f.toFixed(2)})`],
      [px > m, `price ${px > m ? "above" : "below"} the ${p.mid}-day average (${m.toFixed(2)})`],
      [px > s, `price ${px > s ? "above" : "below"} the ${p.slow}-day average (${s.toFixed(2)})`],
      [m > s, `${p.mid}-day average ${m > s ? "above" : "below"} the ${p.slow}-day`],
      [f > fPrev, `${p.fast}-day average ${f > fPrev ? "rising" : "falling"}`],
    ];
    return { score: votes.reduce((a, [up]) => a + (up ? 1 : -1), 0) / votes.length, reasons: votes.map(([, r]) => r) };
  },
};

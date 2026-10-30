// Factor 4 — volume and order flow (15). Does volume say "exhaustion" or "continuation"?
// High volume is not a reversal by itself: it scores only with a rejection close.
//
//   rejection-bar volume   4   high volume AND closed back up its range (4); high volume closing
//                              at the extreme = continuation (0); normal (2); quiet test (1)
//   trigger-bar volume     3   relative volume of the confirmation candle
//   pressure since test    3   volume-weighted close position of the bars since the rejection
//   into the extreme       2   volume drying up (or a climax rejection) = 2; accelerating = 0
//   live order book        3   total bid qty ÷ total ask qty from the live quote (live only)
//
// Relative volume = volume ÷ average volume of the previous 20 candles (this session only).
// True cumulative volume delta and absorption need tick data the feed doesn't provide: always
// listed as missing, never estimated.
import { line, factor, num, fmt } from "../../decision/util.js";
import { candleMetrics } from "./priceAction.js";

export function volumeFactor(D) {
  const { S, i, setup, cfg, long, quote, timeOf } = D;
  const V = cfg.volume;
  const lines = [];
  const notes = [];
  const hasVol = S.bars.some((b) => b.volume > 0);
  const avgPrev = (k) => {
    const from = Math.max(0, k - V.avgBars);
    const n = k - from;
    if (n < V.minAvgBars) return { avg: null, n };
    let s = 0;
    for (let j = from; j < k; j++) s += S.bars[j].volume || 0;
    return { avg: s / n, n };
  };
  const cur = S.bars[i].volume || 0;
  const { avg, n: avgN } = avgPrev(i);
  const rvol = num(avg) && avg > 0 ? cur / avg : null;
  const avgNote = avgN < V.avgBars ? ` (avg of ${avgN} bars — fewer than ${V.avgBars} so far)` : "";
  const extra = ["Cumulative volume delta: needs tick-by-tick trade data, which the feed doesn't provide", "Absorption: needs order-book / tape data, not inferred from candles"];

  if (!hasVol) {
    for (const [key, label, max] of [["rejVol", "Rejection-bar volume", 4], ["trigVol", "Trigger-bar volume", 3], ["pressure", "Pressure since the test", 3], ["fade", "Volume into the extreme", 2], ["book", "Live order book", 3]]) {
      lines.push(line(key, label, 0, max, null, "no volume data (index)", "missing"));
    }
    return factor("volume", "Volume / order flow", 15, lines, "No volume data", { details: { volume: cur, avgVolume: null, rvol: null }, extraMissing: extra });
  }

  const tested = setup.t >= 0 && setup.state !== "failed";
  let rvolR = null;
  let climaxRejection = false;
  if (tested) {
    const r = S.bars[setup.t];
    const a = avgPrev(setup.t).avg;
    rvolR = num(a) && a > 0 ? r.volume / a : null;
    const cp = candleMetrics(r, long).closePos;
    if (rvolR == null) {
      lines.push(line("rejVol", "Rejection-bar volume", 0, 4, null, `needs ${V.minAvgBars} earlier bars`, "missing"));
    } else if (rvolR >= V.climaxRvol) {
      climaxRejection = cp >= 0.5;
      const pts = climaxRejection ? 4 : cp < 0.33 ? 0 : 2;
      lines.push(line("rejVol", "Rejection-bar volume", pts, 4, `${fmt(rvolR, 2)}× avg`, climaxRejection ? "high-volume rejection (candle-based)" : cp < 0.33 ? `heavy volume closing near the ${long ? "low" : "high"} — continuation volume` : "high volume, middling close"));
    } else {
      lines.push(line("rejVol", "Rejection-bar volume", rvolR >= V.normalRvol ? 2 : 1, 4, `${fmt(rvolR, 2)}× avg`, rvolR >= V.normalRvol ? "normal" : "quiet test — little information"));
    }

    // Trigger bar.
    if (setup.triggerIdx >= 0) {
      const a2 = avgPrev(setup.triggerIdx).avg;
      const rv = num(a2) && a2 > 0 ? S.bars[setup.triggerIdx].volume / a2 : null;
      const pts = rv == null ? 0 : rv >= V.confirmRvol ? 3 : rv >= V.normalRvol ? 2 : rv >= V.weakRvol ? 1 : 0;
      lines.push(line("trigVol", "Trigger-bar volume", pts, 3, rv == null ? null : `${fmt(rv, 2)}× avg (${timeOf(setup.triggerIdx)})`, rv == null ? "not enough earlier bars" : rv < V.normalRvol ? "low-volume confirmation" : "", rv == null ? "missing" : "ok"));
    } else {
      lines.push(line("trigVol", "Trigger-bar volume", 0, 3, null, "no trigger yet", "na"));
    }

    // Volume-weighted close position since the rejection candle, in [−1, 1] (+ = buyers).
    let sv = 0;
    let sp = 0;
    for (let k = setup.t; k <= i; k++) {
      const b = S.bars[k];
      const rng = b.high - b.low;
      if (!(rng > 0)) continue;
      sv += b.volume;
      sp += b.volume * ((2 * (b.close - b.low)) / rng - 1);
    }
    const press = sv > 0 ? sp / sv : null;
    const dp = num(press) ? (long ? press : -press) : null;
    const pts = dp == null ? 0 : dp >= V.pressureStrong ? 3 : dp >= V.pressureFair ? 2 : dp >= -V.pressureFair ? 1 : 0;
    lines.push(line("pressure", "Pressure since the test", pts, 3, num(press) ? `${press >= 0 ? "+" : ""}${fmt(press, 2)} (buy + / sell −)` : null, dp == null ? "" : dp >= V.pressureFair ? `${long ? "buying" : "selling"} pressure building` : dp < -V.pressureFair ? `${long ? "selling" : "buying"} pressure still dominant` : "balanced", dp == null ? "missing" : "ok"));
    D.pressure = press;

    // Volume into the extreme: the fadeBars bars up to the rejection candle vs the ones before.
    const a0 = setup.t - 2 * V.fadeBars + 1;
    if (a0 >= 0) {
      let last = 0;
      let before = 0;
      for (let k = setup.t - V.fadeBars + 1; k <= setup.t; k++) last += S.bars[k].volume;
      for (let k = a0; k <= setup.t - V.fadeBars; k++) before += S.bars[k].volume;
      const ratio = before > 0 ? last / before : null;
      const pts = climaxRejection ? 2 : ratio == null ? 0 : ratio <= V.fadeDry ? 2 : ratio <= V.fadeRising ? 1 : 0;
      const words = climaxRejection ? "climax volume, then rejection" : ratio == null ? "" : ratio <= V.fadeDry ? `${long ? "selling" : "buying"} drying up into the extreme (divergence)` : ratio > V.fadeRising ? `volume accelerating into the extreme — continuation risk` : "steady";
      lines.push(line("fade", "Volume into the extreme", pts, 2, ratio == null ? null : `×${fmt(ratio, 2)} vs the ${V.fadeBars} bars before`, words, ratio == null && !climaxRejection ? "missing" : "ok"));
    } else {
      lines.push(line("fade", "Volume into the extreme", 0, 2, null, `needs ${2 * V.fadeBars} bars before the rejection candle`, "missing"));
    }
  } else {
    lines.push(line("rejVol", "Rejection-bar volume", 0, 4, null, "no band test", "na"));
    lines.push(line("trigVol", "Trigger-bar volume", 0, 3, null, "no band test", "na"));
    lines.push(line("pressure", "Pressure since the test", 0, 3, null, "no band test", "na"));
    lines.push(line("fade", "Volume into the extreme", 0, 2, null, "no band test", "na"));
  }

  // Live order book.
  if (quote?.fresh && quote.totBuy > 0 && quote.totSell > 0) {
    const ratio = long ? quote.totBuy / quote.totSell : quote.totSell / quote.totBuy;
    const pts = ratio >= V.bookStrong ? 3 : ratio >= V.bookFair ? 1 : 0;
    lines.push(line("book", "Live order book", pts, 3, `bids ${quote.totBuy.toLocaleString("en-IN")} / asks ${quote.totSell.toLocaleString("en-IN")}`, `${long ? "bid/ask" : "ask/bid"} ${fmt(ratio, 2)} — resting orders only, can be pulled`));
  } else {
    lines.push(line("book", "Live order book", 0, 3, null, quote ? "quote too old" : "bid/ask imbalance needs a live SmartAPI quote (never in backtests)", "missing"));
  }

  if (num(rvol)) notes.push(`current candle ${fmt(rvol, 2)}× the previous-${avgN} average${avgNote}`);
  const observation = tested
    ? `Rejection bar ${rvolR != null ? `${fmt(rvolR, 2)}×` : "n/a"}, now ${rvol != null ? `${fmt(rvol, 2)}×` : "n/a"} avg; ${climaxRejection ? "climax rejection" : "no climax"}`
    : `Relative volume ${rvol != null ? `${fmt(rvol, 2)}×` : "n/a"}; no band test`;
  return factor("volume", "Volume / order flow", 15, lines, observation, {
    details: { volume: cur, avgVolume: avg, avgBars: avgN, rvol, rvolRejection: rvolR, pressure: D.pressure ?? null, climaxRejection, notes },
    extraMissing: extra,
  });
}

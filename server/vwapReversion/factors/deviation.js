// Factor 2 — VWAP and standard deviation (15). Is price genuinely stretched, or is the market
// repricing? A deep stretch is not a reversal probability: past 3.5σ scores LESS, and a long
// stay outside the band or a fast-widening σ scores 0.
//
//   stretch depth     5   z of the excursion's extreme (bell-shaped: 2.5–3σ best)
//   time outside      4   closes beyond ±2σ in this excursion (a quick spike best)
//   σ behaviour       3   σ stable best; widening fast = directional repricing
//   room to VWAP      3   z at the expected entry (enough distance left to earn the trade)
//
// σ is the volume-weighted standard deviation of typical price around session VWAP (resets
// 09:15), the same σ the chart's VWAP bands use.
import { ptsBelow, ptsAtOrBelow, ptsAtOrAbove, line, factor, num, fmt } from "../../decision/util.js";
import { bandAt } from "../setup.js";

export function deviationFactor(D) {
  const { S, i, setup, cfg, long, side, levels, intervalMin } = D;
  const V = cfg.deviation;
  const m = cfg.setup.band;
  const sigma = S.sigma[i];
  const vwap = S.vwap[i];
  const close = S.bars[i].close;
  const z = (close - vwap) / sigma;
  const zPrev = num(S.sigma[i - 1]) && S.sigma[i - 1] > 0 ? (S.bars[i - 1].close - S.vwap[i - 1]) / S.sigma[i - 1] : null;
  const bands = { p3: vwap + 3 * sigma, p2: vwap + 2 * sigma, p1: vwap + sigma, vwap, m1: vwap - sigma, m2: vwap - 2 * sigma, m3: vwap - 3 * sigma };

  // Nearest band and how far.
  const named = [["+3σ", bands.p3], ["+2σ", bands.p2], ["+1σ", bands.p1], ["VWAP", vwap], ["−1σ", bands.m1], ["−2σ", bands.m2], ["−3σ", bands.m3]];
  const nearest = named.reduce((a, b) => (Math.abs(b[1] - close) < Math.abs(a[1] - close) ? b : a));

  // Excursion stats.
  const tested = setup.t >= 0;
  const from = tested ? setup.t0 : Math.max(0, i - cfg.setup.lookback + 1);
  let peakZ = null;
  let outside = 0;
  for (let k = from; k <= i; k++) {
    if (!num(S.sigma[k]) || S.sigma[k] <= 0) continue;
    const zz = ((long ? S.bars[k].low : S.bars[k].high) - S.vwap[k]) / S.sigma[k];
    if (peakZ == null || (long ? zz < peakZ : zz > peakZ)) peakZ = zz;
    const b = bandAt(S, k, m, side);
    if (tested && b != null && (long ? S.bars[k].close < b : S.bars[k].close > b)) outside++;
  }
  let sessionOutside = 0;
  let sessionOutsideOther = 0;
  for (let k = 0; k <= i; k++) {
    const b = bandAt(S, k, m, side);
    const o = bandAt(S, k, m, long ? "short" : "long");
    if (b != null && (long ? S.bars[k].close < b : S.bars[k].close > b)) sessionOutside++;
    if (o != null && (long ? S.bars[k].close > o : S.bars[k].close < o)) sessionOutsideOther++;
  }
  const kb = i - V.sigmaBars;
  const sigmaRatio = kb >= 0 && num(S.sigma[kb]) && S.sigma[kb] > 0 ? sigma / S.sigma[kb] : null;
  const entryZ = levels?.entry != null ? (levels.entry - vwap) / sigma : z;

  const lines = [];
  const bandAtr = D.atr.value > 0 ? (m * sigma) / D.atr.value : null;
  const noise = num(bandAtr) && bandAtr < V.minBandAtr;
  if (tested) {
    const depth = Math.abs(peakZ);
    const note = noise ? `the ±${m}σ band is only ${fmt(bandAtr, 2)} ATR from VWAP — inside one bar of noise, not a real stretch` : depth >= 3.5 ? "beyond 3.5σ: more often news / repricing than a stretch" : depth >= 2.5 ? "deep, clean stretch" : "just past the band";
    lines.push(line("depth", "Stretch depth", depth < m || noise ? 0 : ptsBelow(V.depthPoints, depth), 5, `${fmt(peakZ, 2)}σ at the extreme`, note));
    const trendDay = sessionOutside >= V.trendDayCloses;
    lines.push(line("duration", "Time outside ±2σ", trendDay ? 0 : ptsAtOrBelow(V.durationPoints, outside), 4, `${outside} close${outside === 1 ? "" : "s"} (${outside * intervalMin} min) this excursion · ${sessionOutside} today`, trendDay ? `${sessionOutside} closes beyond the band today — a trend day` : outside <= 1 ? "quick spike and rejection" : outside >= 5 ? "sustained — repricing, not a stretch" : ""));
  } else {
    lines.push(line("depth", "Stretch depth", 0, 5, `${fmt(peakZ, 2)}σ (no ±${m}σ test)`, "no band test in the lookback window", "na"));
    lines.push(line("duration", "Time outside ±2σ", 0, 4, `${sessionOutside} closes today`, "no band test", "na"));
  }
  if (num(sigmaRatio)) {
    const pts = sigmaRatio <= V.sigmaStable ? 3 : sigmaRatio <= V.sigmaExpanding ? 1 : 0;
    lines.push(line("sigma", "σ behaviour", pts, 3, `σ ×${fmt(sigmaRatio, 2)} vs ${V.sigmaBars} bars ago`, sigmaRatio <= V.sigmaStable ? (sigmaRatio < 0.97 ? "contracting" : "stable") : sigmaRatio <= V.sigmaExpanding ? "widening" : "widening fast — directional repricing"));
  } else {
    lines.push(line("sigma", "σ behaviour", 0, 3, null, `needs ${V.sigmaBars} bars of bands`, "missing"));
  }
  const roomOk = tested && (long ? entryZ < 0 : entryZ > 0);
  lines.push(line("room", "Room to VWAP", roomOk ? ptsAtOrAbove(V.roomPoints, Math.abs(entryZ)) : 0, 3, `${fmt(entryZ, 2)}σ at ${levels?.entry != null ? "the entry" : "the last close"}`, !tested ? "no band test" : roomOk ? "" : "entry is already past VWAP", tested ? "ok" : "na"));

  const az = Math.abs(z);
  let cls = az >= 3 ? "Extreme (beyond 3σ)" : az >= 2 ? "Extended (2–3σ)" : az >= 1 ? "Moderate (1–2σ)" : "Near VWAP (within 1σ)";
  const repricing = tested && (outside >= 5 || sessionOutside >= V.trendDayCloses || (num(sigmaRatio) && sigmaRatio > V.sigmaExpanding));
  if (repricing) cls += " — sustained repricing risk";
  else if (tested && Math.abs(peakZ) >= m && az < Math.abs(peakZ)) cls += `, snapping back from ${fmt(peakZ, 2)}σ`;
  const trend = zPrev == null ? "unknown" : Math.abs(az - Math.abs(zPrev)) < 0.05 ? "flat" : az > Math.abs(zPrev) ? "increasing" : "decreasing";

  const observation = tested
    ? `Extreme ${fmt(peakZ, 2)}σ, ${outside} close${outside === 1 ? "" : "s"} outside; now ${fmt(z, 2)}σ (${trend}); σ ${num(sigmaRatio) ? `×${fmt(sigmaRatio, 2)}` : "n/a"}`
    : `No ±${m}σ test; price at ${fmt(z, 2)}σ`;
  return factor("deviation", "VWAP and deviation", 15, lines, observation, {
    details: { bands, sigma, bandAtr, z, zPrev, trend, peakZ, outside, timeOutsideMin: outside * intervalMin, sessionOutside, sessionOutsideOther, sigmaRatio, classification: cls, repricing, distance: close - vwap, distancePct: ((close - vwap) / vwap) * 100, nearest: { label: nearest[0], price: nearest[1], distance: close - nearest[1] }, entryZ },
  });
}

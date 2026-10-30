// Factor 6 — liquidity and execution quality (10). The displayed price is not the fill.
//
//   traded value / min   3   ₹ traded per minute over the last 20 bars
//   participation        2   our quantity ÷ the average bar volume
//   cost drag            2   charges + entry slippage ÷ gross reward at T2
//   spread and depth     3   live bid-ask spread (2) + top-5 depth on the side we trade into
//                            covers our quantity 3× (1). Live quote only.
//
// Hard gates: traded value per minute, 20-day average daily traded value, participation, and
// (live) the spread and the distance to a circuit limit.
import { ptsAtOrAbove, ptsAtOrBelow, line, factor, gate, num, fmt, inr } from "../../decision/util.js";

const lakh = (x) => (num(x) ? (x >= 1e7 ? `₹${(x / 1e7).toFixed(2)} cr` : `₹${(x / 1e5).toFixed(2)} L`) : "—");

export function liquidityFactor(D) {
  const { S, i, cfg, ctx, levels, quote, intervalMin, long } = D;
  const L = cfg.liquidity;
  const lines = [];
  const gates = [];
  const hasVol = S.bars.some((b) => b.volume > 0);

  const from = Math.max(0, i - L.valueBars + 1);
  let value = 0;
  let vol = 0;
  for (let k = from; k <= i; k++) {
    value += S.bars[k].close * (S.bars[k].volume || 0);
    vol += S.bars[k].volume || 0;
  }
  const nb = i - from + 1;
  const perMin = hasVol ? value / (nb * intervalMin) : null;
  const avgBarVol = hasVol ? vol / nb : null;
  const daily = (ctx.ref.daily || []).filter((d) => d.volume > 0);
  const dailyValue = daily.length ? daily.reduce((s, d) => s + d.close * d.volume, 0) / daily.length : null;

  if (num(perMin)) {
    lines.push(line("value", "Traded value", ptsAtOrAbove(L.valuePerMinPoints, perMin), 3, `${lakh(perMin)} / min (last ${nb} bars)`, dailyValue ? `20-day average ${lakh(dailyValue)} / day` : ""));
    gates.push(gate("value", "Enough traded value now", perMin >= L.minValuePerMin, `${lakh(perMin)} per minute (minimum ${lakh(L.minValuePerMin)})`));
  } else {
    lines.push(line("value", "Traded value", 0, 3, null, "no volume data", "missing"));
  }
  if (num(dailyValue)) gates.push(gate("daily", "Liquid stock", dailyValue >= L.minDailyValue, `20-day average ${lakh(dailyValue)} / day (minimum ${lakh(L.minDailyValue)})`));

  const qty = levels?.qty ?? 0;
  if (levels && qty > 0 && avgBarVol > 0) {
    const part = qty / avgBarVol;
    lines.push(line("participation", "Participation", ptsAtOrBelow(L.participationPoints, part), 2, `${fmt(part * 100, 2)}% of an average bar`, `${inr(qty)} shares vs ${inr(Math.round(avgBarVol))} per bar`));
    gates.push(gate("participation", "Size fits the market", part <= L.maxParticipation, `${fmt(part * 100, 1)}% of an average bar's volume (limit ${L.maxParticipation * 100}%)`));
  } else {
    lines.push(line("participation", "Participation", 0, 2, null, !levels ? "no trade levels yet" : !hasVol ? "no volume data" : "no quantity", !levels || qty === 0 ? "na" : "missing"));
  }

  if (levels && num(levels.costDrag)) {
    lines.push(line("costs", "Cost drag", ptsAtOrBelow(L.costDragPoints, levels.costDrag), 2, `${fmt(levels.costDrag * 100, 1)}% of the gross reward`, `charges ₹${fmt(levels.chargesAtT2, 0)} + entry slippage at ${levels.slippagePct}%`));
  } else {
    lines.push(line("costs", "Cost drag", 0, 2, null, "no trade levels yet", "na"));
  }

  let spreadPct = null;
  let depthSide = null;
  if (quote?.fresh && num(quote.bid) && num(quote.ask) && quote.ask > quote.bid) {
    spreadPct = quote.spreadPct;
    const sp = ptsAtOrBelow(L.spreadPoints, spreadPct);
    depthSide = long ? quote.askDepth : quote.bidDepth;
    const dp = qty > 0 && depthSide >= L.depthCover * qty ? 1 : 0;
    lines.push(line("spread", "Spread and depth", sp + dp, 3, `bid ${fmt(quote.bid)} / ask ${fmt(quote.ask)} (${fmt(spreadPct, 3)}%)`, `top-5 ${long ? "ask" : "bid"} depth ${inr(depthSide)}${qty > 0 ? ` vs our ${inr(qty)}` : ""}`));
    gates.push(gate("spread", "Spread acceptable", spreadPct <= L.maxSpreadPct, `spread ${fmt(spreadPct, 3)}% (limit ${L.maxSpreadPct}%)`));
  } else {
    lines.push(line("spread", "Spread and depth", 0, 3, null, quote ? "quote too old" : "bid / ask / depth need a live SmartAPI quote (never in backtests)", "missing"));
  }
  if (quote?.fresh && num(quote.ltp) && (num(quote.upperCircuit) || num(quote.lowerCircuit))) {
    const toUpper = num(quote.upperCircuit) && quote.upperCircuit > 0 ? ((quote.upperCircuit - quote.ltp) / quote.ltp) * 100 : Infinity;
    const toLower = num(quote.lowerCircuit) && quote.lowerCircuit > 0 ? ((quote.ltp - quote.lowerCircuit) / quote.ltp) * 100 : Infinity;
    const near = Math.min(toUpper, toLower);
    gates.push(gate("circuit", "Clear of circuit limits", near > L.circuitBufferPct, `${fmt(toLower, 1)}% above the lower circuit ${fmt(quote.lowerCircuit)}, ${fmt(toUpper, 1)}% below the upper ${fmt(quote.upperCircuit)}`));
  }

  const observation = [num(perMin) ? `${lakh(perMin)}/min` : "no volume", num(spreadPct) ? `spread ${fmt(spreadPct, 3)}%` : "spread n/a", levels && num(levels.costDrag) ? `costs ${fmt(levels.costDrag * 100, 0)}% of reward` : null].filter(Boolean).join("; ");
  return factor("liquidity", "Liquidity / execution", 10, lines, observation, {
    gates,
    details: { valuePerMin: perMin, avgBarVolume: avgBarVol, dailyValue, bid: quote?.fresh ? quote.bid : null, ask: quote?.fresh ? quote.ask : null, spread: quote?.fresh && num(quote.bid) ? quote.ask - quote.bid : null, spreadPct, depthSide, upperCircuit: quote?.upperCircuit ?? null, lowerCircuit: quote?.lowerCircuit ?? null, slippagePct: D.risk.slippagePct, slippageSource: D.risk.slippageSource },
  });
}

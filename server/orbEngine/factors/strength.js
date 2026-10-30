// Factor 7 — relative strength and liquidity (5).
//
//   vs NIFTY 50       2   stock return since the open minus NIFTY's, in the trade's favour
//   vs sector         1   the same against the sector index
//   traded value      1   ₹ traded per minute over the last 20 bars
//   live spread       1   bid-ask spread (live only)
// Industry peers: not available (only the sector index) — listed as missing.
// Hard gates: traded value per minute, 20-day average daily value, participation, and (live)
// the spread and the distance to a circuit limit.
import { line, factor, gate, num, fmt } from "../../decision/util.js";

const lakh = (x) => (num(x) ? (x >= 1e7 ? `₹${(x / 1e7).toFixed(2)} cr` : `₹${(x / 1e5).toFixed(2)} L`) : "—");
const signed = (x) => (num(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(2)}%` : "—");

export function strengthFactor(D) {
  const { ctx, cfg, long, S, i, quote, levels, intervalMin } = D;
  const L = cfg.liquidity;
  const want = long ? 1 : -1;
  const lines = [];
  const gates = [];
  const stockOpenPct = (S[i].close / S[0].open - 1) * 100;
  const rsOf = (role) => {
    const x = ctx.market(role);
    return x && x.dayOpen ? stockOpenPct - (x.close / x.dayOpen - 1) * 100 : null;
  };
  const rsN = rsOf("nifty");
  const rsS = rsOf("sector");
  if (num(rsN)) {
    const d = rsN * want;
    lines.push(line("rsNifty", "RS vs NIFTY 50", d >= L.rsStrongPct ? 2 : d >= 0 ? 1 : 0, 2, `${signed(rsN)} since the open`, d >= L.rsStrongPct ? `${long ? "out" : "under"}performing` : d < 0 ? `${long ? "lagging" : "outperforming"} the index` : "in line"));
  } else {
    lines.push(line("rsNifty", "RS vs NIFTY 50", 0, 2, null, "no NIFTY 50 bars", "missing"));
  }
  if (num(rsS)) lines.push(line("rsSector", "RS vs sector", rsS * want >= 0 ? 1 : 0, 1, `${signed(rsS)} vs ${ctx.market("sector").name}`));
  else lines.push(line("rsSector", "RS vs sector", 0, 1, null, "no sector index", "missing"));

  const from = Math.max(0, i - 19);
  let value = 0;
  let vol = 0;
  for (let k = from; k <= i; k++) {
    value += S[k].close * (S[k].volume || 0);
    vol += S[k].volume || 0;
  }
  const nb = i - from + 1;
  const perMin = vol > 0 ? value / (nb * intervalMin) : null;
  const avgBarVol = vol > 0 ? vol / nb : null;
  const daily = (ctx.ref.daily || []).filter((d) => d.volume > 0);
  const dailyValue = daily.length ? daily.reduce((s, d) => s + d.close * d.volume, 0) / daily.length : null;
  if (num(perMin)) {
    lines.push(line("value", "Traded value", perMin >= L.valuePerMin ? 1 : 0, 1, `${lakh(perMin)} / min`, dailyValue ? `20-day average ${lakh(dailyValue)} / day` : ""));
    gates.push(gate("value", "Enough traded value now", perMin >= L.minValuePerMin, `${lakh(perMin)} per minute (minimum ${lakh(L.minValuePerMin)})`));
  } else {
    lines.push(line("value", "Traded value", 0, 1, null, "no volume data", "missing"));
  }
  if (num(dailyValue)) gates.push(gate("daily", "Liquid stock", dailyValue >= L.minDailyValue, `20-day average ${lakh(dailyValue)} / day (minimum ${lakh(L.minDailyValue)})`));
  if (levels?.qty > 0 && avgBarVol > 0) {
    const part = levels.qty / avgBarVol;
    gates.push(gate("participation", "Size fits the market", part <= L.maxParticipation, `${fmt(part * 100, 1)}% of an average bar's volume (limit ${L.maxParticipation * 100}%)`));
  }

  let spreadPct = null;
  if (quote?.fresh && num(quote.spreadPct)) {
    spreadPct = quote.spreadPct;
    lines.push(line("spread", "Live spread", spreadPct <= L.spreadGood ? 1 : 0, 1, `bid ${fmt(quote.bid)} / ask ${fmt(quote.ask)} (${fmt(spreadPct, 3)}%)`, `top-5 depth: ${quote.bidDepth.toLocaleString("en-IN")} bid / ${quote.askDepth.toLocaleString("en-IN")} ask`));
    gates.push(gate("spread", "Spread acceptable", spreadPct <= L.maxSpreadPct, `spread ${fmt(spreadPct, 3)}% (limit ${L.maxSpreadPct}%)`));
  } else {
    lines.push(line("spread", "Live spread", 0, 1, null, quote ? "quote too old" : "bid / ask need a live SmartAPI quote (never in backtests)", "missing"));
  }
  if (quote?.fresh && num(quote.ltp) && (num(quote.upperCircuit) || num(quote.lowerCircuit))) {
    const toUpper = quote.upperCircuit ? ((quote.upperCircuit - quote.ltp) / quote.ltp) * 100 : Infinity;
    const toLower = quote.lowerCircuit ? ((quote.ltp - quote.lowerCircuit) / quote.ltp) * 100 : Infinity;
    gates.push(gate("circuit", "Clear of circuit limits", Math.min(toUpper, toLower) > L.circuitBufferPct, `${fmt(toLower, 1)}% above the lower circuit ${fmt(quote.lowerCircuit)}, ${fmt(toUpper, 1)}% below the upper ${fmt(quote.upperCircuit)}`));
  }

  const liq = num(perMin) ? (perMin >= L.valuePerMin ? "High" : perMin >= L.minValuePerMin ? "Adequate" : "Thin") : "Unknown";
  return factor("strength", "Relative strength / liquidity", 5, lines, `RS ${signed(rsN)} vs NIFTY; liquidity ${liq.toLowerCase()}${num(spreadPct) ? `; spread ${fmt(spreadPct, 3)}%` : ""}`, {
    gates,
    details: { rsNifty: rsN, rsSector: rsS, stockOpenPct, valuePerMin: perMin, avgBarVolume: avgBarVol, dailyValue, spreadPct, liquidity: liq },
    extraMissing: ["Industry peers: no peer data beyond the sector index"],
  });
}

// Factor 7 — risk-reward and position sizing (10).
//
//   net reward / risk   6   to T2 (VWAP), after every charge and slippage: 3:1 → 6 … 1.5:1 → 2
//   stop distance       2   0.5–2 ATR beyond the entry (not noise-tight, not too wide)
//   size feasibility    2   at least one share inside the risk budget, not capped by position value
//
// Hard gates: net R:R ≥ 1.5, quantity ≥ 1, ≤ 3 trades a day, today's loss under 1% of capital.
import { ptsAtOrAbove, line, factor, gate, num, fmt } from "../../decision/util.js";

export function riskFactor(D) {
  const { levels, cfg, risk, atr, extras } = D;
  const R = cfg.risk;
  const lines = [];
  const gates = [];
  const tradesToday = extras.tradesToday ?? D.ctx.tradesToday ?? 0;
  const dayPnl = extras.dayPnlRs ?? 0;

  gates.push(gate("trades", "Trades today within limit", tradesToday < risk.maxTradesPerDay, `${tradesToday} of ${risk.maxTradesPerDay} trades used today`));
  gates.push(gate("dayLoss", "Daily loss within limit", dayPnl > -risk.maxDailyLossRs, `today's result ₹${Math.round(dayPnl).toLocaleString("en-IN")} (stop at −₹${Math.round(risk.maxDailyLossRs).toLocaleString("en-IN")}, ${R.maxDailyLossPct}% of capital)`));

  if (!levels) {
    lines.push(line("rr", "Net reward / risk", 0, 6, null, "no trade levels yet", "na"));
    lines.push(line("stop", "Stop distance", 0, 2, null, "no trade levels yet", "na"));
    lines.push(line("size", "Size feasibility", 0, 2, null, "no trade levels yet", "na"));
    return factor("risk", "Risk-reward / sizing", 10, lines, "No setup to size", { gates, details: null });
  }

  const rr = levels.netRR;
  lines.push(line("rr", "Net reward / risk", ptsAtOrAbove(R.netRRPoints, rr), 6, num(rr) ? `${fmt(rr, 2)} : 1 net (gross ${fmt(levels.grossRR, 2)} : 1)` : levels.valid ? "—" : "no reward: VWAP is not beyond the entry", "to T2 (VWAP), after charges and slippage"));
  if (levels.valid) gates.push(gate("rr", `Net reward / risk ≥ ${R.minNetRR}`, num(rr) && rr >= R.minNetRR, num(rr) ? `${fmt(rr, 2)} : 1 net to VWAP` : "can't be sized"));
  else gates.push(gate("rr", `Net reward / risk ≥ ${R.minNetRR}`, false, "VWAP is not beyond the entry — nothing to revert to"));

  const a = atr.value;
  const dist = a > 0 ? levels.riskPerShare / a : null;
  const inRange = (x, [lo, hi]) => x >= lo && x <= hi;
  const sp = !num(dist) ? 0 : inRange(dist, R.stopAtrGood) ? 2 : inRange(dist, R.stopAtrOk) ? 1 : 0;
  lines.push(line("stop", "Stop distance", sp, 2, num(dist) ? `${fmt(dist, 2)} ATR (₹${fmt(levels.riskPerShare)} / share)` : null, !num(dist) ? "" : dist < R.stopAtrOk[0] ? "too tight — inside normal noise" : dist > R.stopAtrOk[1] ? "very wide" : "", num(dist) ? "ok" : "missing"));

  const q = levels.qty;
  lines.push(line("size", "Size feasibility", q > 0 ? (levels.capped ? 1 : 2) : 0, 2, q > 0 ? `${q.toLocaleString("en-IN")} shares, ₹${Math.round(levels.exposure).toLocaleString("en-IN")}` : "0 shares", q === 0 ? "one share loses more than the risk budget" : levels.capped ? "capped by the max position value" : `risk ₹${fmt(risk.riskRs, 0)} (${risk.riskPct}% of ₹${risk.capital.toLocaleString("en-IN")})`));
  gates.push(gate("qty", "Position can be sized", q > 0, q > 0 ? `${q} shares, max loss ₹${fmt(levels.maxLossRs, 0)} incl. charges` : "even one share risks more than the budget"));

  const observation = `${num(rr) ? `${fmt(rr, 2)}:1 net` : "no R:R"}; stop ${num(dist) ? `${fmt(dist, 2)} ATR` : "n/a"}; ${q} shares${levels.conditional ? " (conditional)" : ""}`;
  return factor("risk", "Risk-reward / sizing", 10, lines, observation, { gates, details: { stopAtr: dist } });
}

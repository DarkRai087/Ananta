// Factor 8 — risk-reward and volatility (10).
//
//   net reward / risk   5   to the primary target, after every charge and slippage
//   room left           3   distance to the volatility cap (the day's extreme + one typical daily
//                           range), in R — how much of the usual move is still available
//   stop quality        2   0.5–2 ATR from the entry
//
// Hard gates: net R:R ≥ 1.5, a logical stop, at least one share, the day's volatility not already
// spent, ≤ 3 trades a day, today's loss under 1% of capital.
import { ptsAtOrAbove, line, factor, gate, num, fmt, rs, inr } from "../../decision/util.js";

const inRange = (x, [lo, hi]) => x >= lo && x <= hi;

export function riskFactor(D) {
  const { levels, cfg, risk, extras, ctx, atr, i } = D;
  const R = cfg.risk;
  const lines = [];
  const gates = [];
  const tradesToday = extras.tradesToday ?? ctx.tradesToday ?? 0;
  const dayPnl = extras.dayPnlRs ?? 0;
  gates.push(gate("trades", "Trades today within limit", tradesToday < risk.maxTradesPerDay, `${tradesToday} of ${risk.maxTradesPerDay} trades used today`));
  gates.push(gate("dayLoss", "Daily loss within limit", dayPnl > -risk.maxDailyLossRs, `today's result ₹${inr(Math.round(dayPnl))} (stop at −₹${inr(Math.round(risk.maxDailyLossRs))}, ${R.maxDailyLossPct}% of capital)`));
  if (num(D.consumed)) gates.push(gate("consumed", "Daily range not used up", D.consumed < R.maxConsumed, `today's range is ${fmt(D.consumed * 100, 0)}% of the 14-day ATR (limit ${R.maxConsumed * 100}%)`));

  if (!levels) {
    for (const [k, l, m] of [["rr", "Net reward / risk", 5], ["room", "Room left in the day's range", 3], ["stop", "Stop quality", 2]]) lines.push(line(k, l, 0, m, null, "no trade levels yet", "na"));
    return factor("risk", "Risk-reward / volatility", 10, lines, "No setup to size", { gates, details: null });
  }

  const rr = levels.netRR;
  lines.push(line("rr", "Net reward / risk", ptsAtOrAbove(R.netRRPoints, rr), 5, num(rr) ? `${fmt(rr, 2)} : 1 net to ${levels.primaryName} (gross ${fmt(levels.grossRR, 2)} : 1)` : "—", "after charges and slippage"));
  gates.push(gate("stopOk", "Logical stop", levels.valid, levels.valid ? `stop ${rs(levels.stop)} below ${levels.stopBasis}` : "the stop or target would sit on the wrong side of the entry"));
  if (levels.valid) gates.push(gate("rr", `Net reward / risk ≥ ${R.minNetRR}`, num(rr) && rr >= R.minNetRR, num(rr) ? `${fmt(rr, 2)} : 1 net to ${levels.primaryName} ${rs(levels.primary)}` : "can't be sized"));
  gates.push(gate("qty", "Position can be sized", levels.qty > 0, levels.qty > 0 ? `${levels.qty} shares, max loss ₹${fmt(levels.maxLossRs, 0)} incl. charges` : "even one share risks more than the budget"));

  const roomR = num(levels.room) && levels.riskPerShare > 0 ? levels.room / levels.riskPerShare : null;
  lines.push(line("room", "Room left in the day's range", num(roomR) ? ptsAtOrAbove(R.roomPoints, roomR) : 0, 3, num(roomR) ? `${fmt(roomR, 2)} R to the volatility cap ${rs(levels.volCap)}` : null, num(D.consumed) ? `${fmt(D.consumed * 100, 0)}% of a typical day's range already used` : "", num(roomR) ? "ok" : "missing"));

  const a = atr[i];
  const dist = a > 0 ? levels.riskPerShare / a : null;
  const sp = !num(dist) ? 0 : inRange(dist, R.stopAtrGood) ? 2 : inRange(dist, R.stopAtrOk) ? 1 : 0;
  lines.push(line("stop", "Stop quality", sp, 2, num(dist) ? `${fmt(dist, 2)} ATR (₹${fmt(levels.riskPerShare)} / share)` : null, levels.stopNote || (num(dist) && dist > R.stopAtrOk[1] ? "very wide stop" : "")));

  return factor("risk", "Risk-reward / volatility", 10, lines, `${num(rr) ? `${fmt(rr, 2)}:1 net` : "no R:R"}; ${num(roomR) ? `${fmt(roomR, 1)} R of room` : "room n/a"}; ${levels.qty} shares${levels.conditional ? " (conditional)" : ""}`, { gates, details: { stopAtr: dist, roomR } });
}

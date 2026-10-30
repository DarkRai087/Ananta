// Position sizing and net reward / risk after every charge, shared by the decision engines.
// Sizing is the backtest's own rule (backtest/costs.js sizeForRisk): the most shares whose loss at
// the stop — price move, stop slippage and every charge — stays within the risk per trade.
import { sizeForRisk, tradeCosts } from "../backtest/costs.js";
import { LAB } from "../config/lab.js";
import { num } from "./util.js";

/**
 * Risk budget from the account, held inside the strategy's band (R: { capital, riskPct,
 * minRiskPct, maxRiskPct, maxDailyLossPct, maxTradesPerDay, leverage }). A stricter account
 * setting is kept; a looser one is capped and the cap is reported. Slippage is the backtest's
 * model, or half the live spread when that is wider.
 */
export function resolveRisk(R, account = null, quote = null) {
  const notes = [];
  const capital = account?.capital > 0 ? account.capital : R.capital;
  let riskPct = account?.riskPct > 0 ? account.riskPct : R.riskPct;
  if (riskPct > R.maxRiskPct) {
    notes.push(`Risk capped at ${R.maxRiskPct}% of capital (your setting: ${riskPct}%) — the strategy's limit`);
    riskPct = R.maxRiskPct;
  } else if (riskPct < R.minRiskPct) {
    notes.push(`Risk ${riskPct}% is below the strategy's usual ${R.minRiskPct}–${R.maxRiskPct}% range — kept as you set it`);
  }
  const modelSlip = LAB.backtest.slippagePct;
  const halfSpread = quote?.fresh && num(quote.spreadPct) ? quote.spreadPct / 2 : null;
  const slippagePct = Math.max(modelSlip, halfSpread ?? 0);
  return {
    capital,
    riskPct,
    riskRs: (capital * riskPct) / 100,
    maxPositionValue: account?.maxPosition > 0 ? account.maxPosition : account ? capital * (account.leverage || 1) : capital * R.leverage,
    maxDailyLossRs: (capital * R.maxDailyLossPct) / 100,
    maxTradesPerDay: R.maxTradesPerDay,
    slippagePct,
    slippageSource: halfSpread != null && halfSpread > modelSlip ? `half the live spread (${halfSpread.toFixed(3)}%)` : `the backtest's ${modelSlip}% model`,
    notes,
  };
}

// Net ₹ for `qty` shares from entry to exit after every charge. slipPct worsens the exit fill
// (stops are market orders; targets are limit orders and fill at the price).
export function netAt(long, entry, exit, qty, slipPct = 0) {
  if (!(qty > 0) || !num(exit)) return { net: null, charges: null, gross: null };
  const fill = long ? exit * (1 - slipPct / 100) : exit * (1 + slipPct / 100);
  const gross = (long ? fill - entry : entry - fill) * qty;
  const charges = (long ? tradeCosts(entry * qty, fill * qty) : tradeCosts(fill * qty, entry * qty)).total;
  return { net: gross - charges, charges, gross };
}

/**
 * Size and net reward / risk for an entry at e with this stop and target: entry slippage on the
 * fill, stop slippage and every charge in the loss. Returns { valid, fill, qty, lossRs, charges,
 * netAtTarget, chargesAtTarget, netRR, capped }.
 */
export function sizeAt(long, e, stop, target, risk) {
  const valid = num(e) && num(stop) && num(target) && (long ? stop < e && e < target : stop > e && e > target);
  if (!valid) return { valid: false, fill: e, qty: 0, lossRs: null, charges: null, netAtTarget: null, chargesAtTarget: null, netRR: null, capped: false };
  const side = long ? "long" : "short";
  const slip = risk.slippagePct;
  const fill = long ? e * (1 + slip / 100) : e * (1 - slip / 100);
  const size = sizeForRisk(side, fill, stop, { riskRs: risk.riskRs, maxValue: risk.maxPositionValue, slippagePct: slip });
  const at = netAt(long, fill, target, size.qty);
  // Capped = the position-value limit, not the risk budget, decided the size.
  const capped = size.qty > 0 && risk.maxPositionValue > 0 && sizeForRisk(side, fill, stop, { riskRs: risk.riskRs, maxValue: 0, slippagePct: slip }).qty > size.qty;
  return {
    valid: true,
    fill,
    qty: size.qty,
    lossRs: size.lossRs,
    charges: size.charges,
    netAtTarget: at.net,
    chargesAtTarget: at.charges,
    netRR: size.qty > 0 && size.lossRs > 0 && at.net != null ? at.net / size.lossRs : null,
    capped,
  };
}

/**
 * Chase limit: the worst entry (highest for a long, lowest for a short) between `best` and
 * `worst` whose net R:R still reaches minRR. rrOf(e) → net R:R (or null) for an entry at e;
 * net R:R must fall as the entry moves from best to worst. null = even `best` fails.
 */
export function chaseLimit(long, best, worst, rrOf, minRR, tick, roundTick) {
  const ok = (e) => (rrOf(e) ?? -Infinity) >= minRR;
  if (!num(best) || !num(worst) || !ok(best)) return null;
  if (ok(worst)) return roundTick(worst, tick, long ? "down" : "up");
  let a = best; // passes
  let b = worst; // fails
  for (let k = 0; k < 40 && Math.abs(b - a) > tick / 4; k++) {
    const mid = (a + b) / 2;
    if (ok(mid)) a = mid;
    else b = mid;
  }
  return roundTick(a, tick, long ? "down" : "up");
}

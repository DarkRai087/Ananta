// Round-trip intraday equity costs for one trade (one buy order + one sell order), and the
// position size that keeps a stopped-out trade's loss — charges included — within your risk.
import { COSTS } from "../config/costs.js";

function brokerage(orderValue, c) {
  if (c.brokeragePctCap == null) return c.brokeragePerOrder;
  return Math.min(c.brokeragePerOrder, (orderValue * c.brokeragePctCap) / 100);
}

export function tradeCosts(buyValue, sellValue, c = COSTS) {
  const turnover = buyValue + sellValue;
  const parts = {
    brokerage: brokerage(buyValue, c) + brokerage(sellValue, c),
    stt: (sellValue * c.sttSellPct) / 100,
    exchange: (turnover * c.exchangeTxnPct) / 100,
    sebi: (turnover * c.sebiPerCrore) / 1e7,
    stamp: (buyValue * c.stampBuyPct) / 100,
  };
  const gstBase = c.gstOn.reduce((s, k) => s + (parts[k] || 0), 0);
  parts.gst = (gstBase * c.gstPct) / 100;
  parts.total = parts.brokerage + parts.stt + parts.exchange + parts.sebi + parts.stamp + parts.gst;
  return parts;
}

/**
 * The most shares whose loss if the stop is hit — the price move, slippage on the stop fill
 * and every charge — stays within riskRs, with qty × entry within maxValue (0 = no cap).
 * Returns { qty, lossRs, charges }: lossRs = that net loss (> 0), charges = its charges part.
 * qty 0 = even one share loses more than riskRs (or the stop is on the wrong side).
 */
export function sizeForRisk(side, entry, stop, { riskRs, maxValue = 0, slippagePct = 0 }, c = COSTS) {
  const long = side === "long";
  const none = { qty: 0, lossRs: null, charges: null };
  if (!(entry > 0) || !(riskRs > 0) || !Number.isFinite(stop) || (long ? stop >= entry : stop <= entry)) return none;
  const fill = long ? stop * (1 - slippagePct / 100) : stop * (1 + slippagePct / 100);
  const move = Math.abs(entry - fill);
  const at = (q) => {
    const charges = (long ? tradeCosts(entry * q, fill * q, c) : tradeCosts(fill * q, entry * q, c)).total;
    return { lossRs: move * q + charges, charges };
  };
  // The loss grows with qty, so binary-search the largest qty that fits.
  let hi = Math.floor(riskRs / move);
  if (maxValue > 0) hi = Math.min(hi, Math.floor(maxValue / entry));
  let lo = 0;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (at(mid).lossRs <= riskRs) lo = mid;
    else hi = mid - 1;
  }
  return lo >= 1 ? { qty: lo, ...at(lo) } : none;
}

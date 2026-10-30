// The trader's account inputs → backtest / plan settings.
//
//   capital    ₹ to trade with
//   riskPct    % of capital lost if a trade hits its stop, NET: charges and stop slippage
//              included (backtest/costs.js sizeForRisk)          → riskPerTrade
//   profitPct  % of capital to take as profit per trade, NET of all charges
//                                                                → profitTarget (0 = strategy's own target)
//   leverage   position value allowed per ₹ of capital (MIS ≈ 5×) → maxPositionValue
//
// The daily loss stop is 3 losing trades. Anything missing or out of range falls back to the
// backtest defaults in config/lab.js.
const num = (v) => (v === "" || v == null ? null : Number(v));
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

export function accountSettings(input = {}) {
  const capital = num(input.capital);
  const riskPct = num(input.riskPct);
  if (!(capital > 0) || !(riskPct > 0)) return { account: null, settings: {} };
  const a = {
    capital: clamp(capital, 1000, 1e10),
    riskPct: clamp(riskPct, 0.01, 20),
    profitPct: clamp(num(input.profitPct) || 0, 0, 100),
    leverage: clamp(num(input.leverage) || 1, 1, 10),
    indexFilter: ["sector", "market"].includes(input.indexFilter) ? input.indexFilter : "off",
  };
  a.riskRs = (a.capital * a.riskPct) / 100;
  a.profitRs = a.profitPct > 0 ? (a.capital * a.profitPct) / 100 : null;
  a.targetR = a.profitRs ? a.profitRs / a.riskRs : null;
  a.maxPosition = a.capital * a.leverage;
  a.maxDailyLoss = 3 * a.riskRs;
  return {
    account: a,
    settings: { riskPerTrade: a.riskRs, maxPositionValue: a.maxPosition, maxDailyLoss: a.maxDailyLoss, profitTarget: a.profitRs || 0, indexFilter: a.indexFilter },
  };
}

// Stable string for cache / job keys.
export const accountKey = (a) => (a ? `${a.capital}|${a.riskPct}|${a.profitPct}|${a.leverage}|${a.indexFilter}` : "default");

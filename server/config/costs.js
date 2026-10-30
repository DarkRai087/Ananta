// Intraday (MIS) equity charges — your broker's rate card. Percentages are in percent
// (0.025 = 0.025%). Edit here when the rates change; every backtest, position size and
// trade plan uses these.
export const COSTS = {
  brokeragePerOrder: 20, // ₹ per executed order (entry and exit are one order each)…
  brokeragePctCap: 0.03, // …or 0.03% of the order value, whichever is lower. null = always ₹20.
  sttSellPct: 0.025, // STT, intraday, sell side only
  exchangeTxnPct: 0.00307, // NSE transaction charge, both sides
  sebiPerCrore: 10, // SEBI turnover fee, ₹10 per crore, both sides
  stampBuyPct: 0.003, // stamp duty, buy side only
  gstPct: 18, // GST…
  gstOn: ["brokerage", "exchange", "sebi"], // …on brokerage + exchange + SEBI charges
};

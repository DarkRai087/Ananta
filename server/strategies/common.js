// Parameters every strategy has. Strategy files add their own on top.
//
// A strategy is { id, name, description, params, spec, warmup(params, intervalMin), onBar(ctx) },
// plus, optionally: levels (today's level keys drawn when its Top 3 card is clicked, see
// ranking/today.js LEVEL_LABELS), plan(ctx) (strategies/planKit.js) and decision (a decision
// engine: { evaluate, configFor, build, vix, report }, where report names the client's
// report view, e.g. "orb"). Everything about a strategy lives in its own file.
// onBar runs at the CLOSE of bar ctx.i and returns:
//   { side: "long" | "short", stop?, target?, reason }   to enter at the NEXT bar's open
//   { exit: true, reason }                               to exit an open position at the next open
//   null                                                 to do nothing
// `stop` is the structure stop (used when stopType = "structure"). `target` is a
// strategy target (used only when targetR = 0).
export const COMMON_DEFAULTS = {
  allowLong: true,
  allowShort: true, // MIS allows intraday shorts
  entryStart: "09:15",
  entryEnd: "14:45",
  stopType: "structure", // structure | atr | percent
  atrPeriod: 14, // session ATR on the chart interval (needs this many bars first)
  atrMult: 1.5,
  stopPct: 0.5,
  targetR: 2, // target at N × risk. 0 = no R target (strategy target, exit signal or 15:15)
  // Stop management after entry (all off by default). Checked at each bar's close.
  breakevenR: 0, // move the stop to entry once price has gone N × risk in favour. 0 = off
  trailType: "none", // none | atr | vwap | swing
  trailAtrMult: 2, // atr: stop trails the close by N × ATR
  trailSwingBars: 3, // swing: stop trails the low (short: high) of the last N bars
};

export const COMMON_SPEC = [
  { key: "allowLong", label: "Long trades", type: "bool" },
  { key: "allowShort", label: "Short trades", type: "bool" },
  { key: "entryStart", label: "Entry window from", type: "time" },
  { key: "entryEnd", label: "Entry window to", type: "time" },
  { key: "stopType", label: "Stop", type: "select", options: ["structure", "atr", "percent"] },
  { key: "atrPeriod", label: "ATR period (bars)", type: "number", step: 1 },
  { key: "atrMult", label: "ATR multiple", type: "number", step: 0.1 },
  { key: "stopPct", label: "Stop %", type: "number", step: 0.05 },
  { key: "targetR", label: "Target (R, 0 = none)", type: "number", step: 0.25 },
  { key: "breakevenR", label: "Breakeven at (R, 0 = off)", type: "number", step: 0.25 },
  { key: "trailType", label: "Trailing stop", type: "select", options: ["none", "atr", "vwap", "swing"] },
  { key: "trailAtrMult", label: "Trail ATR multiple", type: "number", step: 0.1 },
  { key: "trailSwingBars", label: "Trail swing bars", type: "number", step: 1 },
];

export function defineStrategy(def) {
  return {
    ...def,
    params: { ...COMMON_DEFAULTS, ...def.params },
    spec: [...def.spec, ...COMMON_SPEC],
  };
}

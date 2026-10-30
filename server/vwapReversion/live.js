// The VWAP σ-reversion decision report: the shared live loader (decision/live.js) with this engine.
import { decisionReport, syncForReport } from "../decision/live.js";

export { syncForReport };
export const vwapReport = (opts) => decisionReport({ ...opts, strategy: "vwapBands" });

// Worker thread for heavy jobs (backtests, pattern stats, Today ranking). Reads SQLite only.
import "../env.js";
import { parentPort, workerData } from "node:worker_threads";
import { loadHolidays } from "../data/holidays.js";
import { runLabBacktest, loadSessions } from "./run.js";
import { patternStats } from "../patterns/stats.js";
import { computeToday } from "../ranking/today.js";
import { LAB } from "../config/lab.js";

loadHolidays();

let last = 0;
const progress = (done, total, message) => {
  const t = Date.now();
  if (t - last < 150 && done < total) return;
  last = t;
  parentPort.postMessage({ type: "progress", phase: "compute", done, total, message });
};

try {
  const { kind, input } = workerData;
  let result;
  if (kind === "backtest") {
    result = runLabBacktest({ ...input, onProgress: (d, t) => progress(d, t, "Backtesting sessions") });
  } else if (kind === "patterns") {
    const sessionsBySymbol = input.symbols.map((symbol) => ({
      symbol,
      sessions: loadSessions(symbol, input.interval, { from: input.from, to: input.to }).filter(
        (s) => (!input.from || s.date >= input.from) && (!input.to || s.date <= input.to)
      ),
    }));
    result = {
      kind: "patterns",
      symbols: input.symbols,
      interval: input.interval,
      from: input.from,
      to: input.to,
      sessions: sessionsBySymbol.reduce((n, x) => n + x.sessions.length, 0),
      ...patternStats(sessionsBySymbol, {
        intervalMin: LAB.intervals[input.interval],
        patternIds: input.patternIds?.length ? input.patternIds : null,
        horizons: input.horizons,
        onProgress: (d, t) => progress(d, t, "Scanning sessions"),
      }),
    };
  } else if (kind === "today") {
    result = { kind: "today", ...computeToday({ ...input, onProgress: (d, t) => progress(d, t, "Backtesting all strategies") }) };
  } else {
    throw new Error(`Unknown job kind ${kind}`);
  }
  parentPort.postMessage({ type: "result", result });
} catch (err) {
  parentPort.postMessage({ type: "error", error: err.message, stack: err.stack });
}

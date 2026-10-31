// Runs a strategy's entry rule over the real past sessions, exiting by the simulation's rules.
import { slotOf } from "./time.js";
import { hit } from "./simulate.js";

export function runHistory(sessions, findEntry, params) {
  const endSlot = slotOf(params.until ?? "15:15");
  const trades = [];
  for (const { date, bars } of sessions) {
    const e = findEntry(bars, params);
    if (!e) continue;
    let h = 0;
    for (let k = e.slot + 1; k < endSlot && !h; k++) h = hit(bars[k].o, bars[k].h, bars[k].l, e.stop, e.target);
    const risk = e.entry - e.stop;
    const R = h > 0 ? (e.target - e.entry) / risk : h < 0 ? -1 : (bars[endSlot - 1].c - e.entry) / risk;
    trades.push({ date, ...e, outcome: h > 0 ? "target" : h < 0 ? "stop" : "neither", R });
  }
  const target = trades.filter((t) => t.outcome === "target").length;
  const stop = trades.filter((t) => t.outcome === "stop").length;
  return {
    sessions: sessions.length,
    fired: trades.length,
    notFired: sessions.length - trades.length,
    target,
    stop,
    neither: trades.length - target - stop,
    winRate: target + stop ? target / (target + stop) : null,
    avgR: trades.length ? trades.reduce((a, t) => a + t.R, 0) / trades.length : 0,
    trades,
  };
}

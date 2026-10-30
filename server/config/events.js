// Scheduled events that block new trades, shared by the decision engines (VWAP σ reversion, ORB).
// Market-wide events apply to every symbol, in backtests too; symbol events only where the
// symbol is known (the decision reports). No trades from `before` minutes before `time` to
// `after` minutes after it; allDay blocks the whole session.
//   { date: "2026-11-12", label: "Q2 results", symbols: ["RELIANCE"], allDay: true }
export const EVENTS = [
  // RBI MPC decisions, from the 2026-27 schedule on rbi.org.in (statement at 10:00 IST).
  { date: "2026-12-04", time: "10:00", before: 30, after: 60, label: "RBI monetary policy decision" },
  { date: "2027-02-05", time: "10:00", before: 30, after: 60, label: "RBI monetary policy decision" },
];

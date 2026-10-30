// NSE cash-market session rules. Times are IST, "HH:MM".
export const MARKET = {
  istOffsetSec: 5.5 * 3600,

  // Regular session. A candle is kept if its START time is in [open, close).
  open: "09:15",
  close: "15:30",

  // Intraday rules shared by the backtester, pattern stats and the Top 3 panel.
  squareOff: "15:15", // forced exit, before the broker's MIS auto square-off
  entryCutoff: "14:45", // no new entries at or after this time
  forwardReturnCap: "15:15", // pattern forward returns never measure past this

  // NSE equity tick sizes by price (used when the instrument master's tick isn't known).
  // Rows: [price below, tick].
  ticks: [[250, 0.01], [1000, 0.05], [5000, 0.1], [10000, 0.5], [20000, 1], [Infinity, 5]],

  // Time-of-day buckets used in every breakdown.
  timeBuckets: [
    { id: "open", label: "09:15–10:30", start: "09:15", end: "10:30" },
    { id: "morning", label: "10:30–11:30", start: "10:30", end: "11:30" },
    { id: "midday", label: "11:30–13:30", start: "11:30", end: "13:30" },
    { id: "late", label: "13:30–15:15", start: "13:30", end: "15:15" },
  ],

  // Special sessions (Muhurat etc.) are kept as their own short "day" with this window,
  // flagged special, and excluded from backtests and prior-day levels by default.
  // Add new ones when NSE announces them. A holiday NSE marks with "*" (Diwali) is also
  // treated as special even if it isn't listed here (whole day kept).
  specialSessions: {
    "2023-11-12": { start: "18:15", end: "19:15", label: "Muhurat trading" },
    "2024-11-01": { start: "18:00", end: "19:00", label: "Muhurat trading" },
    "2025-10-21": { start: "13:45", end: "14:45", label: "Muhurat trading" },
  },

  // Used only if NSE's holiday API can't be reached. Source: NSE holiday master (CM segment).
  fallbackHolidays: [
    "2026-01-15", "2026-01-26", "2026-03-03", "2026-03-26", "2026-03-31", "2026-04-03",
    "2026-04-14", "2026-05-01", "2026-05-28", "2026-06-26", "2026-09-14", "2026-10-02",
    "2026-10-20", "2026-11-10", "2026-11-24", "2026-12-25",
  ],
};

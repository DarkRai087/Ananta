export const fmtPrice = (n) =>
  n == null || !Number.isFinite(n) ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const fmtRs = (n, digits = 0) =>
  n == null || !Number.isFinite(n)
    ? "—"
    : `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const fmtR = (n) => (n == null || !Number.isFinite(n) ? "—" : `${n < 0 ? "−" : n > 0 ? "+" : ""}${Math.abs(n).toFixed(2)}R`);

export const fmtPct = (n, digits = 0) => (n == null || !Number.isFinite(n) ? "—" : `${n.toFixed(digits)}%`);

export const fmtNum = (n, digits = 2) => (n == null ? "—" : n === Infinity ? "∞" : Number.isFinite(n) ? n.toFixed(digits) : "—");

// Daily-style times are IST-date keys (00:00 UTC); intraday times are real epochs shown in IST.
export function fmtTime(t, intraday) {
  const opts = intraday
    ? { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }
    : { timeZone: "UTC", day: "2-digit", month: "short", year: "numeric" };
  return new Date(t * 1000).toLocaleString("en-IN", opts);
}

export const fmtHHMM = (t) =>
  new Date(t * 1000).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false });

// Current IST date ("YYYY-MM-DD") and minute of day.
export function istNow() {
  const t = Date.now() / 1000 + 5.5 * 3600;
  const d = new Date(t * 1000);
  return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes(), weekday: d.getUTCDay() };
}

// NSE cash session (weekdays 09:15–15:30 IST), plus one minute to pick up the final bar.
export function isMarketOpen() {
  const n = istNow();
  return n.weekday >= 1 && n.weekday <= 5 && n.minute >= 9 * 60 + 15 && n.minute <= 15 * 60 + 31;
}

export const fmtSignedPct = (n, digits = 2) => (n == null || !Number.isFinite(n) ? "—" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}%`);

export const isoDaysAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

export const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v == null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage unavailable */
    }
  },
};

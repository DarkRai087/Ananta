// Request checks shared by the routes: each returns the clean value or throws a 400.
import { LAB } from "../config/lab.js";
import { AppError } from "../errors.js";

const bad = (msg) => new AppError(400, "BAD_REQUEST", msg);

// NSE symbol, index or universe id: letters, digits and & - _ . (e.g. M&M, BAJAJ-AUTO, NIFTY50).
export function symbolOf(v, what = "symbol") {
  const s = String(v ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9&_.-]{1,30}$/.test(s)) throw bad(`${what} required (an NSE symbol such as RELIANCE)`);
  return s;
}

export function intervalOf(v) {
  const iv = v || LAB.defaultInterval;
  if (!LAB.intervals[iv]) throw bad(`interval must be one of ${Object.keys(LAB.intervals).join(", ")}`);
  return iv;
}

// "YYYY-MM-DD"; optional dates may be missing (null).
export function dateOf(v, what = "date", { optional = false } = {}) {
  if (optional && (v == null || v === "")) return null;
  const s = String(v ?? "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw bad(`${what} must be a date (YYYY-MM-DD)`);
  return s;
}

export const listOf = (v) => String(v || "").split(",").filter(Boolean);

// Small helpers shared by the decision engines (vwapReversion/, orbEngine/): scored lines,
// factors, gates, tick rounding and number formatting.
import { MARKET } from "../config/market.js";

// rows: [[limit, points], …]. First row whose test passes wins; none → 0.
export const ptsAtOrBelow = (rows, x) => (x == null || !Number.isFinite(x) ? 0 : (rows.find(([lim]) => x <= lim)?.[1] ?? 0));
export const ptsBelow = (rows, x) => (x == null || !Number.isFinite(x) ? 0 : (rows.find(([lim]) => x < lim)?.[1] ?? 0));
export const ptsAtOrAbove = (rows, x) => (x == null || !Number.isFinite(x) ? 0 : (rows.find(([lim]) => x >= lim)?.[1] ?? 0));

export const num = (x) => x != null && Number.isFinite(x);
export const r2 = (x) => (num(x) ? Math.round(x * 100) / 100 : null);
export const pct = (a, b) => (num(a) && num(b) && b !== 0 ? (a / b - 1) * 100 : null);
export const fmt = (x, d = 2) => (num(x) ? x.toFixed(d) : "—");
// Reused formatters: toLocaleString("en-IN") builds a new one per call (~25× slower).
const INR = new Intl.NumberFormat("en-IN");
const INR2 = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const inr = (x) => INR.format(x);
export const rs = (x) => (num(x) ? `₹${INR2.format(x)}` : "—");

// NSE tick for a price (config table), unless the instrument's own tick is known.
export function tickFor(price, tick = null) {
  if (num(tick) && tick > 0) return tick;
  return MARKET.ticks.find(([below]) => price < below)?.[1] ?? 0.05;
}

// Round to the tick: "up", "down" or nearest. Tidies float noise (0.1 + 0.2).
export function roundTick(x, tick, mode = "near") {
  if (!num(x)) return null;
  const q = x / tick;
  const n = mode === "up" ? Math.ceil(q - 1e-9) : mode === "down" ? Math.floor(q + 1e-9) : Math.round(q);
  return Number((n * tick).toFixed(4));
}

/**
 * One scored line inside a factor.
 * status: "ok" (measured) | "missing" (data unavailable → 0) | "substitute" (a stand-in measure
 *         while the standard one warms up; worth less) | "na" (doesn't apply to this setup)
 */
export const line = (key, label, points, max, value, note = "", status = "ok") => ({ key, label, points, max, value, note, status });

// Factor result from its lines. Lines marked "missing" still count in max (they cost points),
// and are listed so the report can say what data was absent.
export function factor(id, name, max, lines, observation, extra = {}) {
  const score = lines.reduce((s, l) => s + (l.points || 0), 0);
  const missingMax = lines.filter((l) => l.status === "missing").reduce((s, l) => s + l.max, 0);
  return {
    id,
    name,
    score: Math.round(score * 10) / 10,
    max,
    maxAvailable: max - missingMax,
    lines,
    observation,
    missing: lines.filter((l) => l.status === "missing").map((l) => `${name}: ${l.label}${l.note ? ` — ${l.note}` : ""}`),
    ...extra,
  };
}

export const gate = (id, label, pass, reason, { hard = true, pending = false } = {}) => ({ id, label, pass, reason, hard, pending });

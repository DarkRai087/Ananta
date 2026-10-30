// Helpers for a strategy's optional plan(ctx) hook.
//
// plan(ctx) runs at the close of the LAST COMPLETED bar of today's session (ctx.i; -1 before
// the first bar) while the strategy has no position. It describes what would make the
// strategy enter on a coming bar, as prices:
//
//   { status, note, setups: [{ side, trigger, when, stop?, target?, cross?, approx?, atMarket? }] }
//
//   status   "watching" (levels known) | "armed" (first condition met, one more close needed)
//            | "waiting" (not enough of the day yet) | "off" (setup doesn't apply today)
//   trigger  the price that sets it off (entry is assumed near it: next bar's open)
//   when     plain words, e.g. "5m close above OR high"
//   stop     the strategy's structure stop (the plan applies stopType / targetR on top)
//   target   the strategy's own target (used when targetR = 0)
//   cross    true = needs a fresh cross: price must be on the other side first
//   approx   true = stop/trigger estimated (e.g. the breakout candle's low isn't known yet)
//   atMarket true = enters at the current price as soon as the window opens
//
// Plans are for display only; the backtest never calls them.
import { OPEN_MIN, minToHHMM } from "../lab/time.js";

export const px = (n) => (n == null || !Number.isFinite(n) ? "—" : n.toFixed(2));
export const tf = (ctx) => `${ctx.intervalMin}m`;

export const watch = (setups, note = "") => ({ status: "watching", note, setups });
export const armed = (setups, note = "") => ({ status: "armed", note, setups });
export const waiting = (note, setups = []) => ({ status: "waiting", note, setups });
export const off = (note) => ({ status: "off", note, setups: [] });

export const hasBars = (ctx) => ctx.i >= 0;
export const lastBar = (ctx) => (ctx.i >= 0 ? ctx.bar() : null);

// End of the opening range as HH:MM.
export const orEnd = (ctx, minutes) => minToHHMM(OPEN_MIN + Math.max(minutes, ctx.intervalMin));

// A typical bar range: ATR(14) on the chart interval, else a slice of the daily ATR, else 0.3%.
export function barAtr(ctx, price) {
  const a = ctx.i >= 0 ? ctx.ind("atr", [14]) : null;
  if (a) return a;
  if (ctx.ref.atrDaily) return ctx.ref.atrDaily * 0.15;
  return (price || 0) * 0.003;
}

// Day high / low so far (bars 0..i).
export function dayRange(ctx) {
  if (ctx.i < 0) return null;
  return { high: ctx.highest(ctx.i + 1, "high", 0), low: ctx.lowest(ctx.i + 1, "low", 0) };
}

// Price we measure distances from: last completed close, else the previous day's close.
export const refPrice = (ctx) => lastBar(ctx)?.close ?? ctx.ref.pdc ?? null;

// runTimeMachine(plan, sessions, options): Monte Carlo odds + the same rule on every past
// session + a verdict (trade mode), and a price forecast at each horizon (both modes).
// Pure: no I/O, no clock, no Math.random. Refuses instead of guessing.
import { TimeMachineError } from "./errors.js";
import { BARS, slotOf } from "./time.js";
import { buildPool, validBar, validSorted } from "./sessions.js";
import { simulate } from "./simulate.js";
import { analogWeights, CONDITIONING } from "./analog.js";
import { runHistory } from "./history.js";
import { findEntry } from "./strategies/orb.js";
import { verdict } from "./verdict.js";

const refuse = (code, message) => {
  throw new TimeMachineError(code, message);
};
const isInt = (n, min) => Number.isInteger(n) && n >= min;
const isPrice = (x) => Number.isFinite(x) && x > 0;

/**
 * options: replays, seed, window, minSessions, horizons ([6, 12, "until"]: bars after the entry),
 * conditioning (analog days, off by default = exact v1), today ({ date, bars 09:15..entry bar }),
 * index (Nifty 50 sessions), events ({ date: [tags] }), allSessions (for the previous close).
 */
export function runTimeMachine(plan, sessions, options = {}) {
  const { replays = 10000, seed = 19, window = 2, minSessions = 20, horizons = [6, 12, "until"], today, index, events, allSessions } = options;
  const cond = { ...CONDITIONING, ...options.conditioning };
  if (
    !isInt(replays, 1) || !isInt(window, 0) || !isInt(minSessions, 1) || !Number.isInteger(seed) ||
    !Array.isArray(horizons) || !horizons.every((h) => h === "until" || isInt(h, 1)) ||
    !(cond.bandwidth > 0) || !(cond.minEss > 0) || !(cond.eventWeight >= 0)
  )
    refuse("INVALID_OPTIONS", "replays and minSessions must be whole numbers ≥ 1, window ≥ 0, seed whole, horizons whole bars ≥ 1 or \"until\", bandwidth and minEss > 0");

  // Trade mode: stop and target. Forecast mode: neither (entry defaults to today's last close).
  const { entry: planEntry, stop, target, until = "15:15" } = plan;
  const trade = stop != null || target != null;
  const planOk = trade
    ? [planEntry, stop, target].every(isPrice) && stop < planEntry && planEntry < target
    : planEntry == null ? Boolean(today) : isPrice(planEntry);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(plan.date) || !planOk)
    refuse("INVALID_PLAN", "A plan needs a date (YYYY-MM-DD) and either 0 < stop < entry < target, or no stop and no target for a forecast");
  const startSlot = slotOf(plan.entryTime);
  const endSlot = slotOf(until);
  if (startSlot >= endSlot) refuse("ENTRY_AFTER_UNTIL", `The entry bar closes at ${plan.entryTime}, not before ${until}`);
  if (startSlot < 1 || endSlot > BARS) refuse("INVALID_PLAN", "The entry bar must close at 09:20 or later, and flat-by can be 15:30 at the latest");
  if ((cond.enabled || planEntry == null) && !today) refuse("TODAY_REQUIRED", `Analog days and a forecast without an entry need today's bars up to ${plan.entryTime}`);
  if (today && !(today.date === plan.date && today.bars?.length === startSlot && today.bars.every(validBar)))
    refuse("BAD_TODAY", `today must be ${plan.date}'s ${startSlot} bars, 09:15 up to the bar closing at ${plan.entryTime}`);

  const { sessions: past, excluded, pool } = buildPool(sessions, plan.date);
  if (past.length < minSessions)
    refuse("INSUFFICIENT_SESSIONS", `${past.length} full sessions before ${plan.date}${excluded ? ` (${excluded} incomplete or broken)` : ""}; at least ${minSessions} are needed`);

  let w = past.map(() => 1);
  let ratios = pool;
  let diag = null;
  if (cond.enabled) {
    const a = analogWeights(past, today, { e: startSlot, all: allSessions ? validSorted(allSessions) : past, index, events, conditioning: cond });
    ({ w, diag } = a);
    // Volatility scaling: x' = 1 + (x − 1)·s, and the raw ratio when s is exactly 1 (bit-exact).
    const scaled = (x, s) => (s === 1 ? x : 1 + (x - 1) * s);
    if (a.scale) ratios = pool.map((rs) => rs.map((r, j) => ({ ro: scaled(r.ro, a.scale[j]), rh: scaled(r.rh, a.scale[j]), rl: scaled(r.rl, a.scale[j]), rc: scaled(r.rc, a.scale[j]) })));
  }

  const entry = planEntry ?? today.bars[startSlot - 1].c;
  const risk = trade ? entry - stop : null;
  const targetR = trade ? (target - entry) / risk : null;
  const p = { ...plan, entry, until, risk, targetR, startSlot, endSlot, bars: endSlot - startSlot };
  const hSlots = horizons.map((h) => (h === "until" ? endSlot : Math.min(endSlot, startSlot + h)));
  const { mc, forecast } = simulate(p, ratios, w, { replays, seed, window }, hSlots);
  return {
    plan: p,
    pool: { sessions: past.length, excludedSessions: excluded, firstDate: past[0].date, lastDate: past.at(-1).date },
    mc,
    history: trade ? runHistory(past, findEntry, { targetR, until }) : null,
    verdict: trade ? verdict({ ...mc, targetR, until }) : null,
    forecast: { ref: entry, replays, seed, window, horizons: forecast },
    conditioning: diag,
  };
}

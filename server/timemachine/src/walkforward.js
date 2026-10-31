// Walk-forward validation: forecast each past day from only the days before it, score it against
// what really happened, choose a variant on the train period and judge it on the test period.
import { TimeMachineError } from "./errors.js";
import { slotOf } from "./time.js";
import { validSorted } from "./sessions.js";
import { runTimeMachine } from "./index.js";

export const STANDARD_VARIANTS = [
  { name: "uniform" },
  { name: "analog", conditioning: { enabled: true } },
  { name: "analog+vol", conditioning: { enabled: true, volScale: true } },
];

const mean = (rs, f) => (rs.length ? rs.reduce((a, r) => a + f(r), 0) / rs.length : null);

// n, Brier (and skill against always saying 50%), 90% band coverage, mean p, up rate, calibration.
function metrics(rs) {
  const brier = mean(rs, (r) => (r.p - r.y) ** 2);
  const calibration = Array.from({ length: 10 }, (_, bucket) => {
    const b = rs.filter((r) => Math.min(9, Math.floor(r.p * 10)) === bucket);
    return { bucket, n: b.length, meanP: mean(b, (r) => r.p), upRate: mean(b, (r) => r.y) };
  });
  return { n: rs.length, brier, skill: 1 - brier / 0.25, coverage90: mean(rs, (r) => r.inBand), meanP: mean(rs, (r) => r.p), upRate: mean(rs, (r) => r.y), calibration };
}

export function walkForward(sessions, { index, events, decisionTime = "10:15", until = "15:15", lookback = 20, replays = 2000, seed = 19, window = 2, variants = STANDARD_VARIANTS, trainEnd } = {}) {
  const all = validSorted(sessions);
  const days = all.slice(lookback);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trainEnd)) throw new TimeMachineError("INVALID_OPTIONS", "trainEnd must be a date (YYYY-MM-DD)");
  if (!days.some((d) => d.date <= trainEnd) || !days.some((d) => d.date > trainEnd))
    throw new TimeMachineError("INSUFFICIENT_SESSIONS", `Walk-forward needs days on both sides of ${trainEnd} after the first ${lookback} sessions`);
  const e = slotOf(decisionTime);
  const end = slotOf(until);

  const results = variants.map((v) => {
    const records = days.map((D, k) => {
      const i = lookback + k;
      const [f] = runTimeMachine({ date: D.date, entryTime: decisionTime, until }, all.slice(i - lookback, i), {
        replays, seed: (seed + i) >>> 0, window, horizons: ["until"], conditioning: v.conditioning,
        today: { date: D.date, bars: D.bars.slice(0, e) }, index, events, allSessions: all,
      }).forecast.horizons;
      const ref = D.bars[e - 1].c;
      const actual = D.bars[end - 1].c;
      return { date: D.date, p: f.pUp, y: actual > ref ? 1 : 0, inBand: f.p5 <= actual && actual <= f.p95 ? 1 : 0 };
    });
    return { name: v.name, uniform: !v.conditioning?.enabled, records, train: metrics(records.filter((r) => r.date <= trainEnd)), test: metrics(records.filter((r) => r.date > trainEnd)) };
  });

  let chosen = results[0];
  for (const r of results) if (r.train.brier < chosen.train.brier) chosen = r;
  const uniform = results.find((r) => r.uniform);
  return {
    trainEnd, lookback, decisionTime, until, replays, seed,
    variants: results.map(({ uniform: _, ...r }) => r),
    chosen: chosen.name,
    accepted: Boolean(uniform) && chosen !== uniform && chosen.test.brier < uniform.test.brier,
  };
}

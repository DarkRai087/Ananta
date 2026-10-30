// Factor 3 — relative volume and participation (15). Relative volume compares a bar with the
// SAME TIME OF DAY in earlier sessions (intraday volume is U-shaped, so the previous 20 bars
// would mislead). High volume is not success by itself: heavy volume without progress scores 0.
//
//   breakout candle    6   relative volume: ≥ 2.0 → 6 … < 0.7 → 0 (session-average stand-in: max 4)
//   expansion          3   breakout RVOL ÷ the mean RVOL of the 3 bars before it
//   follow-through     3   retest entries: a QUIET retest is constructive · close / momentum:
//                          volume keeps up after the breakout
//   absorption check   3   heavy volume with a weak close, or price stalling = absorption /
//                          exhaustion; rising on thin volume = divergence
import { ptsAtOrAbove, line, factor, num, fmt } from "../../decision/util.js";
import { candleMetrics } from "../../decision/candle.js";
import { rvolClass } from "../setup.js";

export function volumeFactor(D) {
  const { setup, cfg, rvol, long, S, i, timeOf } = D;
  const V = cfg.volume;
  const lines = [];
  const b = setup.b;
  const hasVol = S.slice(0, i + 1).some((x) => x.volume > 0);
  const extra = ["Order flow (cumulative delta, absorption on the tape): needs tick data the feed doesn't provide"];
  const now = rvol(i);

  if (!hasVol) {
    for (const [k, l, m] of [["brkVol", "Breakout-candle volume", 6], ["expansion", "Volume expansion", 3], ["follow", "Follow-through / retest volume", 3], ["absorb", "Absorption check", 3]]) lines.push(line(k, l, 0, m, null, "no volume data (index)", "missing"));
    return factor("volume", "Relative volume", 15, lines, "No volume data", { details: { now: null, breakout: null, participation: "unknown" }, extraMissing: extra });
  }
  if (b < 0) {
    for (const [k, l, m] of [["brkVol", "Breakout-candle volume", 6], ["expansion", "Volume expansion", 3], ["follow", "Follow-through / retest volume", 3], ["absorb", "Absorption check", 3]]) lines.push(line(k, l, 0, m, null, "no breakout yet", "na"));
    return factor("volume", "Relative volume", 15, lines, `No breakout; now ${now ? `${fmt(now.value, 2)}×` : "n/a"}`, { details: { now, breakout: null, participation: rvolClass(now?.value, cfg) }, extraMissing: extra });
  }

  const rb = rvol(b);
  const sub = rb?.source === "session";
  if (rb) {
    const pts = Math.min(ptsAtOrAbove(V.breakoutPoints, rb.value), sub ? V.substituteMax : 6);
    lines.push(line("brkVol", "Breakout-candle volume", pts, 6, `${fmt(rb.value, 2)}× ${sub ? "the session average" : `the ${timeOf(b)} average`} (${rvolClass(rb.value, cfg)})`, sub ? `fewer than ${cfg.range.minProfile} earlier sessions: compared with this session's earlier bars, worth at most ${V.substituteMax}` : "", sub ? "substitute" : "ok"));
  } else {
    lines.push(line("brkVol", "Breakout-candle volume", 0, 6, null, "not enough earlier bars", "missing"));
  }

  // Expansion into the breakout.
  const before = [];
  for (let k = Math.max(0, b - 3); k < b; k++) if (rvol(k)) before.push(rvol(k).value);
  const avgBefore = before.length ? before.reduce((s, x) => s + x, 0) / before.length : null;
  const exp = rb && avgBefore > 0 ? rb.value / avgBefore : null;
  lines.push(line("expansion", "Volume expansion", num(exp) ? ptsAtOrAbove(V.expansionPoints, exp) : 0, 3, num(exp) ? `×${fmt(exp, 2)} vs the 3 bars before` : null, num(exp) && exp < 0.8 ? "volume fell into the breakout" : "", num(exp) ? "ok" : "missing"));

  // Follow-through, or the retest's volume.
  const after = [];
  for (let k = b + 1; k <= i; k++) if (rvol(k)) after.push(rvol(k).value);
  const avgAfter = after.length ? after.reduce((s, x) => s + x, 0) / after.length : null;
  if (setup.retest && rvol(setup.retest.r)) {
    const rr = rvol(setup.retest.r).value;
    const pts = rr <= V.retestQuiet ? 3 : rr <= V.retestHeavy ? 2 : 1;
    lines.push(line("follow", "Retest volume", pts, 3, `${fmt(rr, 2)}× on the ${timeOf(setup.retest.r)} retest`, pts === 3 ? "quiet retest — sellers absent" : pts === 1 ? "heavy volume on the retest — supply at the level" : ""));
  } else if (num(avgAfter)) {
    const pts = avgAfter >= 1 ? 3 : avgAfter >= V.followMin ? 2 : 1;
    lines.push(line("follow", "Follow-through volume", pts, 3, `${fmt(avgAfter, 2)}× average over ${after.length} bar${after.length === 1 ? "" : "s"} after the breakout`, pts === 1 ? "participation faded after the breakout" : ""));
  } else {
    lines.push(line("follow", "Follow-through volume", 0, 3, null, "no bars after the breakout yet", "na"));
  }

  // Absorption / exhaustion / divergence.
  const m = candleMetrics(S[b], long);
  const progress = i > b ? (long ? S[i].close - S[b].close : S[b].close - S[i].close) : null;
  let pts = 0;
  let note = "";
  let status = "ok";
  if (rb && rb.value >= 1.5 && m.closePos < 0.5) {
    note = "heavy volume but a weak close — absorption at the level";
  } else if (progress == null) {
    status = "na";
    note = "no bars after the breakout yet";
  } else if (progress > 0 && (avgAfter ?? 0) >= V.followMin) {
    pts = 3;
    note = "price progressing with volume";
  } else if (progress > 0) {
    pts = 2;
    note = "price rising on thinning volume — divergence";
  } else {
    pts = 1;
    note = "no progress since the breakout — exhaustion risk";
  }
  lines.push(line("absorb", "Absorption check", pts, 3, progress == null ? null : `${progress >= 0 ? "+" : ""}${fmt(progress)} since the breakout close`, note, status));

  const observation = `Breakout ${rb ? `${fmt(rb.value, 2)}× (${rvolClass(rb.value, cfg)})` : "n/a"}${num(exp) ? `, expansion ×${fmt(exp, 2)}` : ""}${num(avgAfter) ? `, after ${fmt(avgAfter, 2)}×` : ""}`;
  return factor("volume", "Relative volume", 15, lines, observation, {
    details: { now, breakout: rb, expansion: exp, after: avgAfter, retest: setup.retest ? rvol(setup.retest.r) : null, participation: rvolClass(rb?.value, cfg) },
    extraMissing: extra,
  });
}

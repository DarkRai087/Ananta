// Factor 5 — breakout and retest confirmation (15), plus false-breakout detection.
//
//   close confirmation 4   a completed candle closed beyond the level (a wick is not a breakout)
//   acceptance         4   closes held beyond the level after the breakout (≥ 3 → 4) or a held retest
//   retest             3   price came back to the level, held it and was rejected there (model B)
//   false-break risk   4   0 risk flags → 4 · 1 → 2 · 2 → 1 · 3+ → 0
//
// Risk flags: wicks through the level without a close · weak breakout volume · an extended entry ·
// a previous-day level just beyond · the market moving against the trade · a news-sized gap.
// Mandatory: the breakout is confirmed, it hasn't failed, the entry isn't a chase, enough volume.
import { line, factor, gate, fmt, rs } from "../../decision/util.js";

export function confirmationFactor(D) {
  const { setup, cfg, long, S, i, atr, rvol, timeOf, ctx, or, levels } = D;
  const C = cfg.setup;
  const lines = [];
  const gates = [];
  const flags = [];
  const word = long ? "above ORH" : "below ORL";
  const b = setup.b;

  // Risk flags (some apply before a breakout too).
  if (setup.wickBreaks >= 2) flags.push(`${setup.wickBreaks} wicks ${word} without a close — the level is being defended`);
  const rb = b >= 0 ? rvol(b) : null;
  if (rb && rb.value < 0.7) flags.push(`weak breakout volume (${fmt(rb.value, 2)}×)`);
  if (setup.extended.length) flags.push(`entry would be ${fmt(setup.extended[setup.extended.length - 1].atr, 2)} ATR beyond the level (model ${setup.extended[setup.extended.length - 1].model} skipped)`);
  const pdx = long ? ctx.ref.pdh : ctx.ref.pdl;
  const ref = levels?.entry ?? S[i].close;
  if (pdx != null && (long ? pdx > ref : pdx < ref) && Math.abs(pdx - ref) < 0.3 * atr[i]) flags.push(`${long ? "PDH" : "PDL"} ${rs(pdx)} is right ${long ? "above" : "below"} the entry`);
  const nifty = D.marketDetails?.nifty;
  if (nifty && nifty.dir === (long ? -1 : 1) && nifty.momPct != null && Math.sign(nifty.momPct) === (long ? -1 : 1)) flags.push(`NIFTY moving against the trade`);
  if (D.marketDetails?.gapAtr > cfg.market.gapAlignedMaxAtr) flags.push("news-sized opening gap");
  if (setup.state === "failed") flags.push(`failed breakout: ${setup.failWhy} at ${timeOf(setup.failIdx)}`);
  const riskLevel = setup.state === "failed" ? "High (failed)" : flags.length === 0 ? "Low" : flags.length === 1 ? "Medium" : "High";

  if (b < 0) {
    lines.push(line("close", "Close confirmation", 0, 4, setup.wickBreaks ? `${setup.wickBreaks} wick${setup.wickBreaks > 1 ? "s" : ""} ${word}, no close` : "no close beyond the level yet", "", "na"));
    lines.push(line("accept", "Acceptance", 0, 4, null, "no breakout yet", "na"));
    lines.push(line("retest", "Retest", 0, 3, null, "no breakout yet", "na"));
    lines.push(line("risk", "False-breakout risk", 0, 4, null, "no breakout yet", "na"));
    gates.push(gate("confirm", "Breakout confirmed", false, `waiting for a completed candle to close ${word} ${rs(setup.breakLevel)}`, { hard: false, pending: true }));
    return factor("confirm", "Breakout confirmation", 15, lines, "No breakout close yet", { gates, details: { flags, riskLevel, status: "Waiting for a breakout close" } });
  }

  lines.push(line("close", "Close confirmation", 4, 4, `the ${timeOf(b)} candle closed at ${rs(S[b].close)}, ${word} ${rs(setup.breakLevel)}`));
  const held = setup.acceptCloses;
  const accPts = setup.model === "B" ? 4 : held >= 3 ? 4 : held === 2 ? 3 : 1;
  lines.push(line("accept", "Acceptance", setup.state === "failed" ? 0 : accPts, 4, setup.model === "B" ? "held the level on the retest" : `${held} close${held === 1 ? "" : "s"} held ${word}`, setup.state === "failed" ? setup.failWhy : held === 1 && setup.model !== "B" ? "only the breakout candle so far" : ""));
  if (setup.retest) {
    const r = setup.retest;
    const strong = setup.model === "B";
    lines.push(line("retest", "Retest", strong ? 3 : 2, 3, `${timeOf(r.r)} retest, ${fmt(r.depthAtr, 2)} ATR ${r.depthAtr >= 0 ? "into" : "short of"} the level, rejected`, strong ? "confirmed by a close beyond the rejection candle" : "waiting for a close beyond the rejection candle"));
  } else {
    lines.push(line("retest", "Retest", 0, 3, "no retest", setup.model ? `model ${setup.model} entry without a retest` : "", setup.model ? "ok" : "na"));
  }
  const fp = setup.state === "failed" ? 0 : flags.length === 0 ? 4 : flags.length === 1 ? 2 : flags.length === 2 ? 1 : 0;
  lines.push(line("risk", "False-breakout risk", fp, 4, riskLevel, flags.join("; ")));

  // Mandatory entry conditions.
  const MODEL = { A: "close + acceptance", B: "breakout and retest", C: "momentum" };
  if (setup.state === "triggered") gates.push(gate("confirm", "Breakout confirmed", true, `model ${setup.model} (${MODEL[setup.model]}) triggered on the ${timeOf(i)} candle`));
  else if (setup.state === "broken") gates.push(gate("confirm", "Breakout confirmed", false, `broke out at ${timeOf(b)}; waiting for ${setup.retest ? "a close beyond the retest candle" : "acceptance or a retest"}`, { hard: false, pending: true }));
  else if (setup.state === "fired") gates.push(gate("confirm", "Breakout confirmed", false, `already triggered at the ${timeOf(setup.triggerIdx)} candle — no repeat entry`));
  else if (setup.state === "failed") gates.push(gate("failed", "Breakout still valid", false, `${setup.failWhy} at ${timeOf(setup.failIdx)} — the breakout is invalidated (no automatic reversal)`));
  else if (setup.state === "expired") gates.push(gate("confirm", "Breakout confirmed", false, setup.note));
  if (rb) gates.push(gate("volume", "Enough breakout volume", rb.value >= cfg.volume.minRvol, `${fmt(rb.value, 2)}× ${rb.source === "session" ? "the session average" : "the same-time average"} (minimum ${cfg.volume.minRvol}×)`));
  else gates.push(gate("volume", "Enough breakout volume", false, "breakout volume can't be measured"));
  if (setup.state === "triggered" && levels) {
    const ext = (long ? levels.entry - setup.level : setup.level - levels.entry) / atr[i];
    gates.push(gate("chase", "Not chasing", ext <= C.maxExtensionAtr && (levels.chaseLimit == null || (long ? levels.entry <= levels.chaseLimit : levels.entry >= levels.chaseLimit)), `entry ${fmt(ext, 2)} ATR beyond the level (limit ${C.maxExtensionAtr})${levels.chaseLimit != null ? `; chase limit ${rs(levels.chaseLimit)}` : ""}`));
  }

  const status = { triggered: `Confirmed — model ${setup.model} (${MODEL[setup.model]})`, broken: "Broken out — waiting for acceptance or a retest", fired: `Triggered earlier (${setup.triggerIdx >= 0 ? timeOf(setup.triggerIdx) : ""})`, failed: "Failed — closed back inside", expired: "Expired — no entry in time" }[setup.state];
  return factor("confirm", "Breakout confirmation", 15, lines, `${status}; false-breakout risk ${riskLevel.toLowerCase()}`, {
    gates,
    details: { flags, riskLevel, status, model: setup.model, modelName: setup.model ? MODEL[setup.model] : null, retest: setup.retest, held: setup.acceptCloses },
  });
}

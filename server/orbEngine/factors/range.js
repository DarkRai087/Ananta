// Factor 1 — opening range quality (15).
//
//   width vs history   6   percentile of today's OR width (% of the open) among earlier sessions'
//                          (same duration): normal best, extremely narrow 1, extremely wide 0.
//                          Until there are 10 sessions: OR ÷ 14-day daily ATR stands in (max 4)
//   OR volume          3   OR volume ÷ the average OR volume of earlier sessions
//   room to PDH / PDL  3   no previous-day level just beyond the breakout side
//   formation          3   two-sided auction best; a drive against the breakout side worst
import { ptsAtOrAbove, line, factor, num, fmt, rs } from "../../decision/util.js";

export function rangeFactor(D) {
  const { or, cfg, long, ctx } = D;
  const R = cfg.range;
  const lines = [];
  let cls = "unknown";

  if (or.percentile != null) {
    const [, label, pts] = R.percentileBands.find(([below]) => or.percentile < below);
    cls = label;
    lines.push(line("width", "Width vs history", pts, 6, `${fmt(or.widthPct, 2)}% of the open · ${fmt(or.percentile, 0)}th percentile of ${or.historyN} sessions`, label === "Extremely narrow" ? "unusually tight — needs extra confirmation" : label === "Extremely wide" ? "unusually wide — poor reward / risk" : label.toLowerCase()));
  } else if (num(or.atrRatio)) {
    const [, label, pts] = R.atrBands.find(([below]) => or.atrRatio < below);
    cls = label;
    lines.push(line("width", "Width vs history", pts, 6, `${fmt(or.atrRatio, 2)} × daily ATR`, `only ${or.historyN} earlier sessions (${R.minProfile} needed for percentiles) — OR ÷ ATR stands in, worth at most 4`, "substitute"));
  } else {
    lines.push(line("width", "Width vs history", 0, 6, `${fmt(or.widthPct, 2)}% of the open`, "no history and no daily ATR", "missing"));
  }

  if (num(or.volRatio)) {
    lines.push(line("orVol", "Opening-range volume", ptsAtOrAbove(R.orVolPoints, or.volRatio), 3, `${fmt(or.volRatio, 2)}× the usual OR volume`, or.volRatio < 0.8 ? "thin participation in the range" : ""));
  } else {
    lines.push(line("orVol", "Opening-range volume", 0, 3, null, or.volume > 0 ? `needs ${R.minProfile} earlier sessions` : "no volume data", "missing"));
  }

  // Previous-day levels just beyond the breakout side.
  const { pdh, pdl, pdc } = ctx.ref;
  if (pdh != null) {
    const edge = long ? or.high : or.low;
    const beyond = [pdh, pdl, pdc].filter((x) => x != null && (long ? x > edge : x < edge));
    const near = beyond.length ? (long ? Math.min(...beyond) : Math.max(...beyond)) : null;
    const room = near != null && or.width > 0 ? Math.abs(near - edge) / or.width : null;
    const name = near == null ? "" : near === pdh ? "PDH" : near === pdl ? "PDL" : "PDC";
    const pts = room == null || room >= R.overheadClearOrw ? 3 : room >= R.overheadTightOrw ? 2 : 0;
    const value = near == null ? `range already ${long ? "above PDH / PDC" : "below PDL / PDC"}` : `${name} ${rs(near)} is ${fmt(room, 2)} × ORW ${long ? "above ORH" : "below ORL"}`;
    lines.push(line("room", `Room to ${long ? "PDH" : "PDL"}`, pts, 3, value, pts === 0 ? "the breakout runs straight into a previous-day level" : near == null ? "clear air" : ""));
  } else {
    lines.push(line("room", `Room to ${long ? "PDH" : "PDL"}`, 0, 3, null, "no previous session", "missing"));
  }

  const f = long ? or.formation : -or.formation;
  const pts = Math.abs(or.formation) <= R.balancedFormation ? 3 : f >= R.directionalFormation ? 2 : f <= -R.directionalFormation ? 1 : 2;
  const words = Math.abs(or.formation) <= R.balancedFormation ? "two-sided (consolidation)" : f > 0 ? `drove toward the ${long ? "high" : "low"}` : `drove toward the ${long ? "low" : "high"} — against the breakout side`;
  lines.push(line("formation", "Range formation", pts, 3, `closed ${fmt(or.formation * 100, 0)}% of the range from the open`, words));

  const observation = `${cls}; ${fmt(or.widthPct, 2)}% wide${num(or.atrRatio) ? ` (${fmt(or.atrRatio, 2)} × ATR)` : ""}${num(or.volRatio) ? `; volume ${fmt(or.volRatio, 2)}×` : ""}`;
  return factor("range", "Opening range quality", 15, lines, observation, { details: { classification: cls } });
}

// Time, news and session — a mandatory filter: it never adds points, it only blocks.
//   • the opening range must be complete (before that: pending)
//   • the entry must come before the strategy's entryEnd (default 12:00)
//   • enough bars left to 15:15 for the move to T1
//   • data complete (no hole of missing bars today); live: the last bar isn't stale
//   • scheduled events (config/events.js), a sudden ≥ 3.5 ATR candle, a news-sized (≥ 3%) gap
// No live news feed is connected: corporate news is NOT checked beyond the calendar and the
// price-shock tests, and the report says so.
import { hhmmToMin, minToHHMM, OPEN_MIN, CLOSE_MIN, SQUARE_OFF_MIN } from "../../lab/time.js";
import { MARKET } from "../../config/market.js";
import { gate, num, fmt } from "../../decision/util.js";

export function sessionFilter(D) {
  const { ctx, cfg, params, intervalMin, i, levels, atr, extras, S, or } = D;
  const C = cfg.session;
  const gates = [];
  const cautions = [];
  const nextMin = D.nextMin;
  const winEnd = Math.min(hhmmToMin(params.entryEnd ?? "12:00"), hhmmToMin(MARKET.entryCutoff));
  const orEnd = OPEN_MIN + Math.max(Number(params.orMinutes ?? 15), intervalMin);

  if (!or) gates.push(gate("orComplete", "Opening range complete", false, `the ${params.orMinutes}-minute range completes at ${minToHHMM(orEnd)}`, { hard: false, pending: true }));
  else gates.push(gate("orComplete", "Opening range complete", true, `complete at ${minToHHMM(orEnd)}`));
  gates.push(gate("window", "Inside the entry window", nextMin < winEnd, nextMin < winEnd ? `an entry at ${minToHHMM(nextMin)} is before the ${minToHHMM(winEnd)} cut-off` : `entry window closed at ${minToHHMM(winEnd)} (late breakouts are skipped)`));

  if (levels?.valid && num(levels.barsToT1)) {
    const need = levels.barsToT1 * C.timeSafety;
    gates.push(gate("time", "Time for the move", levels.barsLeft >= need, `${Math.round(levels.barsLeft)} bars to 15:15; T1 needs about ${Math.ceil(levels.barsToT1)} (${C.timeSafety}× = ${Math.ceil(need)})`));
  }

  // Data completeness: holes in today's bars.
  let hole = 0;
  for (let k = 1; k <= i; k++) hole = Math.max(hole, (ctx.minute(k) - ctx.minute(k - 1)) / intervalMin - 1);
  gates.push(gate("data", "Complete data", hole <= C.gapBarsMax, hole > 0 ? `${hole} missing bar${hole > 1 ? "s" : ""} in today's candles` : "no missing bars today"));
  if (extras.staleMin != null) gates.push(gate("stale", "Fresh data", extras.staleMin <= C.staleBars * intervalMin, `last completed candle closed ${Math.round(extras.staleMin)} min ago`));

  // Events.
  const date = ctx.sd.session.date;
  const sym = extras.symbol ? String(extras.symbol).toUpperCase() : null;
  const holdUntil = nextMin + (levels?.barsToT1 ? Math.ceil(levels.barsToT1) * intervalMin : 60);
  const hits = [];
  for (const e of extras.events ?? cfg.events ?? []) {
    if (e.date !== date) continue;
    if (e.symbols?.length && !(sym && e.symbols.map((s) => s.toUpperCase()).includes(sym))) continue;
    if (e.allDay) {
      hits.push(`${e.label} today`);
      continue;
    }
    const t = hhmmToMin(e.time);
    const a = t - (e.before ?? 30);
    const b = t + (e.after ?? 60);
    if (nextMin >= a && nextMin <= b) hits.push(`${e.label} at ${e.time} (blackout ${minToHHMM(a)}–${minToHHMM(b)})`);
    else if (a > nextMin && a < holdUntil) hits.push(`${e.label} at ${e.time} falls inside the expected holding time`);
  }
  gates.push(gate("events", "No scheduled event", hits.length === 0, hits.length ? hits.join("; ") : `none listed for ${date}${sym ? ` / ${sym}` : ""}`));

  const a = atr[i];
  if (a > 0 && or) {
    let shock = null;
    for (let k = Math.max(or.completeIndex + 1, i - C.shockBars + 1); k <= i; k++) {
      const rng = S[k].high - S[k].low;
      if (rng >= C.shockAtr * atr[k] && (!shock || rng > shock.rng)) shock = { k, rng, atr: atr[k] };
    }
    gates.push(gate("shock", "No sudden news-like move", !shock, shock ? `the ${D.timeOf(shock.k)} candle ran ${fmt(shock.rng / shock.atr, 1)} ATR` : `no candle ≥ ${C.shockAtr} ATR since the range`));
  }
  const gap = ctx.ref.gapPct;
  if (num(gap)) {
    gates.push(gate("gap", "No news-driven gap", Math.abs(gap) < C.gapBlockPct, `opened ${gap >= 0 ? "+" : ""}${fmt(gap, 2)}% vs yesterday (block at ±${C.gapBlockPct}%)`));
    if (Math.abs(gap) >= C.gapCautionPct && Math.abs(gap) < C.gapBlockPct) cautions.push(`Opening gap ${gap >= 0 ? "+" : ""}${fmt(gap, 2)}% — often news; check before trading`);
  }

  const nowMin = extras.nowMinute ?? nextMin;
  return {
    gates,
    cautions,
    info: {
      time: minToHHMM(Math.min(nowMin, CLOSE_MIN)),
      orEnd: minToHHMM(orEnd),
      sinceOpenMin: Math.max(0, nowMin - OPEN_MIN),
      toSquareOffMin: Math.max(0, SQUARE_OFF_MIN - nowMin),
      window: `${minToHHMM(orEnd)}–${minToHHMM(winEnd)}`,
      phase: nowMin < orEnd ? "Opening range forming" : nowMin < winEnd ? "Breakout window" : nowMin < SQUARE_OFF_MIN ? "After the entry window" : "Closing",
    },
    missing: ["News: no live news / corporate-announcement feed is connected — only the event calendar (config/events.js) and price-shock checks"],
  };
}

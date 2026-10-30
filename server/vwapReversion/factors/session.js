// Factor 8 — time, news and session conditions. A mandatory filter: it never adds points, it
// only blocks. Checks (all hard unless noted):
//   • entry window (strategy entryStart / entryEnd, default 10:00–14:30: no opening volatility,
//     no closing run-up). Before the window opens it is a pending condition, not a block.
//   • time to reach VWAP: bars left to 15:15 ≥ timeSafety × bars VWAP is expected to need
//   • scheduled events (config events): blackout windows, and events inside the holding time
//   • sudden news-like moves: a bar ≥ 3.5 ATR in the last 6 bars
//   • abnormal day: today's range ≥ 2 × the 14-day daily ATR
//   • opening gap ≥ 3% (1.5–3% is a caution)
//   • lunch hour (caution only)
// There is no live news feed: corporate announcements and breaking news are NOT checked beyond
// the calendar and the price-shock tests, and the report says so.
import { hhmmToMin, minToHHMM, OPEN_MIN, CLOSE_MIN, SQUARE_OFF_MIN } from "../../lab/time.js";
import { MARKET } from "../../config/market.js";
import { gate, num, fmt } from "../../decision/util.js";

export function sessionFilter(D) {
  const { ctx, cfg, params, intervalMin, i, levels, atr, extras, S } = D;
  const C = cfg.session;
  const gates = [];
  const cautions = [];
  const nextMin = D.nextMin;
  const winStart = hhmmToMin(params.entryStart ?? "10:00");
  const winEnd = Math.min(hhmmToMin(params.entryEnd ?? "14:30"), hhmmToMin(MARKET.entryCutoff));

  if (nextMin < winStart) gates.push(gate("window", "Inside the entry window", false, `entries from ${minToHHMM(winStart)} (opening volatility; the bands settle first)`, { hard: false, pending: true }));
  else gates.push(gate("window", "Inside the entry window", nextMin < winEnd, nextMin < winEnd ? `${minToHHMM(nextMin)} is inside ${minToHHMM(winStart)}–${minToHHMM(winEnd)}` : `entry window closed at ${minToHHMM(winEnd)}`));

  if (levels?.valid && num(levels.barsToT2)) {
    const need = levels.barsToT2 * C.timeSafety;
    const ok = levels.barsLeft >= need;
    gates.push(gate("time", "Time to reach VWAP", ok, `${Math.round(levels.barsLeft)} bars to 15:15; VWAP needs about ${Math.ceil(levels.barsToT2)} (${C.timeSafety}× = ${Math.ceil(need)})`));
  }

  // Scheduled events.
  const date = ctx.sd.session.date;
  const sym = extras.symbol ? String(extras.symbol).toUpperCase() : null;
  const holdUntil = nextMin + (levels?.barsToT2 ? Math.ceil(levels.barsToT2) * intervalMin : 60);
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

  // Sudden moves and abnormal days.
  const a = atr.value;
  if (a > 0) {
    let shock = null;
    for (let k = Math.max(0, i - C.shockBars + 1); k <= i; k++) {
      const rng = S.bars[k].high - S.bars[k].low;
      if (rng >= C.shockAtr * a && (!shock || rng > shock.rng)) shock = { k, rng };
    }
    gates.push(gate("shock", "No sudden news-like move", !shock, shock ? `the ${D.timeOf(shock.k)} candle ran ${fmt(shock.rng / a, 1)} ATR — wait for things to settle` : `no candle ≥ ${C.shockAtr} ATR in the last ${C.shockBars}`));
  }
  const atrD = ctx.ref.atrDaily;
  if (atrD > 0) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let k = 0; k <= i; k++) {
      hi = Math.max(hi, S.bars[k].high);
      lo = Math.min(lo, S.bars[k].low);
    }
    const ratio = (hi - lo) / atrD;
    gates.push(gate("abnormal", "Normal volatility day", ratio < C.abnormalDayAtr, `today's range is ${fmt(ratio, 2)}× the 14-day ATR (block at ${C.abnormalDayAtr}×)`));
  }
  const gap = ctx.ref.gapPct;
  if (num(gap)) {
    gates.push(gate("gap", "No news-driven gap", Math.abs(gap) < C.gapBlockPct, `opened ${gap >= 0 ? "+" : ""}${fmt(gap, 2)}% vs yesterday (block at ±${C.gapBlockPct}%)`));
    if (Math.abs(gap) >= C.gapCautionPct && Math.abs(gap) < C.gapBlockPct) cautions.push(`Opening gap ${gap >= 0 ? "+" : ""}${fmt(gap, 2)}% — often news; check before trading`);
  }
  const [l0, l1] = C.lunch.map(hhmmToMin);
  if (nextMin >= l0 && nextMin < l1) cautions.push(`Lunch hour (${C.lunch.join("–")}): thinner liquidity`);

  const nowMin = extras.nowMinute ?? nextMin;
  return {
    gates,
    cautions,
    info: {
      time: minToHHMM(Math.min(nowMin, CLOSE_MIN)),
      sinceOpenMin: Math.max(0, nowMin - OPEN_MIN),
      toSquareOffMin: Math.max(0, SQUARE_OFF_MIN - nowMin),
      toCloseMin: Math.max(0, CLOSE_MIN - nowMin),
      window: `${minToHHMM(winStart)}–${minToHHMM(winEnd)}`,
      phase: nowMin < OPEN_MIN + 30 ? "Opening (volatile)" : nowMin < hhmmToMin(C.lunch[0]) ? "Morning" : nowMin < hhmmToMin(C.lunch[1]) ? "Lunch (thin)" : nowMin < SQUARE_OFF_MIN ? "Afternoon" : "Closing",
    },
    missing: ["News: no live news / corporate-announcement feed is connected — only the event calendar (config/vwapReversion.js) and price-shock checks"],
  };
}

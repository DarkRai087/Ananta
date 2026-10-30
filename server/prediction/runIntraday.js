// Intraday outlook: will price be higher or lower at today's close than now?
// Tested on past sessions at the SAME time of day: each model sees the bars completed by
// that time and is scored on the move from there to that session's close.
import { PREDICTION } from "../config/prediction.js";
import { INTRADAY_MODELS } from "./models/index.js";
import { callOf, summarize, ensembleScore, CALL_NAME } from "./evaluate.js";
import { istMinute, minToHHMM } from "../lab/time.js";

const cache = new Map();
const paramsOf = (m) => ({ ...m.params, ...(PREDICTION.models[m.id] || {}) });

// Bars of a session that had closed by minute-of-day `cut`.
const barsBy = (candles, cut, intervalMin) => candles.filter((c) => istMinute(c.time) + intervalMin <= cut);

function predictAll(view, models) {
  const out = {};
  for (const { m, p } of models) {
    let r = null;
    try {
      r = view.bars.length >= (m.minBars ?? 1) ? m.predict(view, p) : null;
    } catch {
      r = null;
    }
    out[m.id] = r;
  }
  return out;
}

// index = { name, byDate: Map(date → index session) }: the share's index, cut at the same time.
function viewOf(s, bars, intervalMin, index, cut) {
  const ix = index?.byDate.get(s.date);
  return {
    bars,
    prev: s.prev,
    daily: s.history || [],
    intervalMin,
    index: ix ? { name: index.name, bars: barsBy(ix.candles, cut, intervalMin), prev: ix.prev } : null,
  };
}

/**
 * past: earlier regular sessions (oldest first, with prev/history). today: today's session
 * with COMPLETED bars only. cut: minute-of-day the call is made at (end of the last bar).
 */
export function runIntraday({ past, today, cut, intervalMin, key = null, index = null }) {
  const cfg = PREDICTION.intraday;
  const models = INTRADAY_MODELS.map((m) => ({ m, p: paramsOf(m) }));
  const base = { horizonLabel: cfg.horizonLabel, checkpoint: minToHHMM(cut), interval: `${intervalMin}m` };

  const ck = key ? `${key}|${cut}|${past.length}|${past[past.length - 1]?.date}|${index?.name}|${index?.byDate.size}` : null;
  let evals = ck ? cache.get(ck) : null;
  let tested = 0;
  if (!evals) {
    const ids = [...models.map((x) => x.m.id), "combined"];
    const samples = Object.fromEntries(ids.map((id) => [id, []]));
    for (const s of past.slice(-cfg.evalSessions)) {
      const bars = barsBy(s.candles, cut, intervalMin);
      if (!bars.length || bars.length >= s.candles.length) continue;
      tested++;
      const fwd = s.candles[s.candles.length - 1].close / bars[bars.length - 1].close - 1;
      const preds = predictAll(viewOf(s, bars, intervalMin, index, cut), models);
      const scores = Object.fromEntries(Object.entries(preds).map(([id, r]) => [id, r?.score ?? null]));
      scores.combined = ensembleScore(scores, PREDICTION.ensemble.intraday);
      for (const [id, sc] of Object.entries(scores)) {
        const call = callOf(sc);
        if (call != null) samples[id].push({ call, fwd });
      }
    }
    evals = Object.fromEntries(ids.map((id) => [id, summarize(samples[id], { horizon: 1, minCalls: cfg.minCalls })]));
    evals._tested = tested;
    if (ck) {
      cache.set(ck, evals);
      if (cache.size > 200) cache.delete(cache.keys().next().value);
    }
  }

  const live = today ? predictAll(viewOf(today, today.candles, intervalMin, index, cut), models) : {};
  const nowOf = (r) => (r ? { score: r.score, call: CALL_NAME[callOf(r.score)], reasons: r.reasons } : { score: null, call: null, reasons: ["no call yet"] });
  const ens = ensembleScore(Object.fromEntries(Object.entries(live).map(([id, r]) => [id, r?.score ?? null])), PREDICTION.ensemble.intraday);
  return {
    ...base,
    index: index?.name ?? null,
    sessionsTested: evals._tested,
    models: models.map(({ m, p }) => ({ id: m.id, name: m.name, description: m.description, params: p, now: nowOf(live[m.id]), eval: evals[m.id] })),
    combined: { now: ens == null ? nowOf(null) : { score: ens, call: CALL_NAME[callOf(ens)], reasons: [] }, eval: evals.combined, weights: PREDICTION.ensemble.intraday },
  };
}

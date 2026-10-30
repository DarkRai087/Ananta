// Daily outlook: each model's call now, and how its past calls did at each horizon.
// Pure: takes daily bars, returns JSON. The walk-forward test only uses COMPLETED bars; the
// live call may use today's unfinished bar (latest price).
import { PREDICTION } from "../config/prediction.js";
import { DAILY_MODELS } from "./models/index.js";
import { callOf, summarize, ensembleScore, CALL_NAME } from "./evaluate.js";
import { lru } from "../lru.js";

const cache = lru({ max: 100 }); // test results by symbol|last complete bar|count

const paramsOf = (m) => ({ ...m.params, ...(PREDICTION.models[m.id] || {}) });
const weightsFor = (hid) => PREDICTION.ensemble.daily[hid] || {};
const windowAt = (bars, t, lookback) => bars.slice(Math.max(0, t + 1 - lookback), t + 1);

// idx = { name, bars, at }: the share's index; at[t] = its last bar on or before bars[t]'s day.
function predictAll(bars, t, models, idx) {
  const out = {};
  for (const { m, p, lb } of models) {
    let r = null;
    try {
      const j = m.needsIndex ? (idx?.at[t] ?? -1) : -1;
      if (m.needsIndex && j < 0) r = null;
      else r = m.predict(windowAt(bars, t, lb), p, m.needsIndex ? { index: { name: idx.name, bars: windowAt(idx.bars, j, m.indexLookback(p)) } } : {});
    } catch {
      r = null;
    }
    out[m.id] = r;
  }
  return out;
}

// For each share bar, the index bar of the same day (or the latest before it).
function alignIndex(bars, index) {
  if (!index?.bars?.length) return null;
  const at = new Array(bars.length).fill(-1);
  let j = -1;
  for (let t = 0; t < bars.length; t++) {
    while (j + 1 < index.bars.length && index.bars[j + 1].time <= bars[t].time) j++;
    at[t] = j;
  }
  return { name: index.name, bars: index.bars, at };
}

function evaluate(done, models, cfg, idx) {
  const H = cfg.horizons;
  const maxH = Math.max(...H.map((h) => h.days));
  const end = done.length - 1;
  const from = Math.max(0, end - cfg.evalDays);
  const samples = {}; // id -> hid -> [{ call, fwd }]
  for (const id of [...models.map((x) => x.m.id), "combined"]) samples[id] = Object.fromEntries(H.map((h) => [h.id, []]));
  for (let t = from; t < end; t++) {
    const preds = predictAll(done, t, models, idx);
    const scores = Object.fromEntries(Object.entries(preds).map(([id, r]) => [id, r?.score ?? null]));
    for (const h of H) {
      if (t + h.days > end) continue;
      const fwd = done[t + h.days].close / done[t].close - 1;
      const push = (id, sc) => {
        const call = callOf(sc);
        if (call != null) samples[id][h.id].push({ call, fwd });
      };
      for (const [id, sc] of Object.entries(scores)) push(id, sc);
      push("combined", ensembleScore(scores, weightsFor(h.id)));
    }
  }
  const evals = {};
  for (const [id, byH] of Object.entries(samples)) {
    evals[id] = Object.fromEntries(H.map((h) => [h.id, summarize(byH[h.id], { horizon: h.days, minCalls: cfg.minCalls })]));
  }
  return { evals, from: done[from]?.time ?? null, to: done[end]?.time ?? null, maxH };
}

/**
 * bars: daily bars oldest first. partial: the last bar is today's unfinished bar.
 * returns { horizons, models: [{ id, name, description, now, eval: { [horizon]: summary } }],
 *           combined: { [horizon]: { now, eval, weights } }, testedFrom, testedTo, lastTime, partial }
 */
export function runDaily(bars, { partial = false, key = null, index = null } = {}) {
  const cfg = PREDICTION.daily;
  const models = DAILY_MODELS.map((m) => {
    const p = paramsOf(m);
    return { m, p, lb: m.lookback(p) };
  });
  const done = partial ? bars.slice(0, -1) : bars;
  const ck = key ? `${key}|${done.length}|${done[done.length - 1]?.time}|${done[done.length - 1]?.close}|${index?.name}|${index?.bars.length}` : null;
  let test = ck ? cache.get(ck) : null;
  if (!test) {
    // The test never sees an index bar later than the share's last complete bar either.
    const idxDone = index && done.length ? { ...index, bars: index.bars.filter((b) => b.time <= done[done.length - 1].time) } : null;
    test = evaluate(done, models, cfg, alignIndex(done, idxDone));
    if (ck) cache.set(ck, test);
  }

  const live = predictAll(bars, bars.length - 1, models, alignIndex(bars, index));
  const nowOf = (r) => (r ? { score: r.score, call: CALL_NAME[callOf(r.score)], reasons: r.reasons } : { score: null, call: null, reasons: ["not enough history"] });
  const liveScores = Object.fromEntries(Object.entries(live).map(([id, r]) => [id, r?.score ?? null]));
  return {
    horizons: cfg.horizons,
    models: models.map(({ m, p }) => ({ id: m.id, name: m.name, description: m.description, params: p, now: nowOf(live[m.id]), eval: test.evals[m.id] })),
    combined: Object.fromEntries(
      cfg.horizons.map((h) => {
        const sc = ensembleScore(liveScores, weightsFor(h.id));
        return [h.id, { now: sc == null ? nowOf(null) : { score: sc, call: CALL_NAME[callOf(sc)], reasons: [] }, eval: test.evals.combined[h.id], weights: weightsFor(h.id) }];
      })
    ),
    testedFrom: test.from,
    testedTo: test.to,
    lastTime: bars[bars.length - 1]?.time ?? null,
    lastClose: bars[bars.length - 1]?.close ?? null,
    partial,
    index: index?.name ?? null,
  };
}

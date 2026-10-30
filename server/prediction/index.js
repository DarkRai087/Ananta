// Prediction module: "will this share go up or down?" at four horizons —
// rest of today (intraday bars) and the next session / week / month (daily bars).
//
// Layout (each piece can change on its own):
//   config/prediction.js   horizons, neutral band, test windows, ensemble weights, param overrides
//   models/                one file per model + models/index.js registry (the model contract)
//   features.js            causal helpers models share
//   evaluate.js            how calls are scored (hit rate vs baseline, significance)
//   runDaily.js            daily models: live call + walk-forward test
//   runIntraday.js         intraday models: live call + same-time-of-day test
//   index.js               data loading + the public predict() (this file)
//
// Every call comes with its own track record, so a model with no edge says so.
import { PREDICTION } from "../config/prediction.js";
import { LAB } from "../config/lab.js";
import { getDailyBars } from "../data/candles.js";
import { syncIntraday, sessionsBack } from "../data/intraday.js";
import { loadSessions } from "../backtest/run.js";
import { dailyBar } from "../lab/sessions.js";
import { istNow, istDate, istMinute, hhmmToMin, CLOSE_MIN } from "../lab/time.js";
import { runDaily } from "./runDaily.js";
import { runIntraday } from "./runIntraday.js";
import { DAILY_MODELS, INTRADAY_MODELS } from "./models/index.js";
import { referenceIndex, indexName } from "../data/indexMembers.js";

const dateOfDaily = (t) => new Date(t * 1000).toISOString().slice(0, 10); // daily time = 00:00 UTC of the IST date

export function modelList() {
  const view = (m) => ({ id: m.id, name: m.name, kind: m.kind, description: m.description, params: { ...m.params, ...(PREDICTION.models[m.id] || {}) } });
  return { daily: DAILY_MODELS.map(view), intraday: INTRADAY_MODELS.map(view), config: PREDICTION };
}

// Intraday sessions + daily bars (with today's bar from intraday data) for one symbol.
async function loadSymbol(symbol, interval, now) {
  const out = { sessions: [], todayFull: null, daily: null, partial: false, warning: null, dailyWarning: null, dailyError: null };
  try {
    const need = PREDICTION.intraday.evalSessions + LAB.context.atrDays + 10;
    ({ warning: out.warning } = await syncIntraday(symbol, interval, { fromSec: sessionsBack(need, now.t) }));
    out.sessions = loadSessions(symbol, interval, { from: istDate(sessionsBack(need, now.t)) }).filter((s) => !s.special && s.date <= now.date);
  } catch (err) {
    out.warning = err.message;
  }
  out.todayFull = out.sessions.find((s) => s.date === now.date) || null;
  const liveSession = Boolean(out.todayFull) && now.minute < CLOSE_MIN;
  try {
    const { rows, warning } = await getDailyBars(symbol);
    out.dailyWarning = warning;
    let bars = rows;
    if (out.todayFull) {
      // Today's bar from intraday data: fresher than Yahoo's (which can lag ~15 min).
      const today = { time: Date.parse(`${now.date}T00:00:00Z`) / 1000, ...dailyBar(now.date, out.todayFull.candles) };
      bars = [...rows.filter((b) => dateOfDaily(b.time) < now.date), today];
      out.partial = liveSession;
    } else if (rows.length && dateOfDaily(rows[rows.length - 1].time) === now.date && now.minute < CLOSE_MIN) {
      out.partial = true;
    }
    out.daily = bars;
  } catch (err) {
    out.dailyError = err.message;
  }
  return out;
}

/**
 * predict(symbol) → { symbol, asOf, price, index, daily, intraday }
 * daily / intraday each carry { error } instead when their data can't be loaded.
 * The share's own index (its sector index, else NIFTY 50) feeds the index models.
 */
export async function predict(rawSymbol, { interval = LAB.defaultInterval, nowMs = Date.now() } = {}) {
  const symbol = String(rawSymbol || "").trim().toUpperCase();
  const now = istNow(nowMs);
  const intervalMin = LAB.intervals[interval];

  const me = await loadSymbol(symbol, interval, now);
  const indexId = referenceIndex(symbol, "sector");
  const ix = indexId ? await loadSymbol(indexId, interval, now) : null;
  const indexLabel = indexId ? indexName(indexId) : null;
  const { sessions, todayFull } = me;
  const liveSession = Boolean(todayFull) && now.minute < CLOSE_MIN;
  const intradayWarning = me.warning;

  // ── Daily ──
  let daily;
  try {
    if (me.dailyError) throw new Error(me.dailyError);
    if (me.daily.length < 30) throw new Error(`Only ${me.daily.length} daily bars for ${symbol}`);
    const index = ix?.daily?.length ? { name: indexLabel, bars: ix.daily } : null;
    daily = { ...runDaily(me.daily, { partial: me.partial, key: symbol, index }), source: "Yahoo Finance daily bars", warning: me.dailyWarning };
  } catch (err) {
    daily = { error: err.message };
  }

  // ── Intraday ──
  let intraday;
  const cfg = PREDICTION.intraday;
  if (!sessions.length) {
    intraday = { error: intradayWarning || `No ${interval} data for ${symbol}` };
  } else if (!liveSession) {
    intraday = { live: false, horizonLabel: cfg.horizonLabel, note: "Market closed — the rest-of-day outlook runs during the session." };
  } else {
    const done = todayFull.candles.filter((c) => c.time + intervalMin * 60 <= now.t);
    const lastDone = done[done.length - 1];
    const cut = lastDone ? istMinute(lastDone.time) + intervalMin : null; // the call is made at the end of the last completed bar
    if (!cut || cut < hhmmToMin(cfg.earliest)) {
      intraday = { live: false, horizonLabel: cfg.horizonLabel, note: `Too early — first call after ${cfg.earliest}.` };
    } else if (cut >= hhmmToMin(cfg.latest)) {
      intraday = { live: false, horizonLabel: cfg.horizonLabel, note: `After ${cfg.latest} — nothing left of the session to call.` };
    } else {
      const past = sessions.filter((s) => s.date < now.date);
      const index = ix?.sessions.length ? { name: indexLabel, byDate: new Map(ix.sessions.map((x) => [x.date, x])) } : null;
      intraday = { live: true, ...runIntraday({ past, today: { ...todayFull, candles: done }, cut, intervalMin, key: `${symbol}|${interval}`, index }), warning: intradayWarning };
    }
  }

  const price = todayFull ? todayFull.candles[todayFull.candles.length - 1].close : (daily.lastClose ?? null);
  return {
    symbol,
    asOf: now.t,
    price,
    index: indexId ? { id: indexId, name: indexLabel } : null,
    neutralBand: PREDICTION.neutralBand,
    significanceZ: PREDICTION.significanceZ,
    daily,
    intraday,
  };
}

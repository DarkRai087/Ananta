// Live decision reports for the strategies that have a decision engine (VWAP σ reversion, ORB):
// today's completed bars, NIFTY 50 + sector lined up, the live quote (bid / ask / depth /
// circuits), NIFTY 50 breadth, India VIX, and what the strategy has already done today — then one
// evaluation at the last completed bar, formatted by the engine's report builder.
//
// Outside market hours it evaluates the last bar of the last session, which the session filter
// rejects: the report then explains why there is no trade instead of inventing one.
import { LAB } from "../config/lab.js";
import { MARKET_INDEX } from "../config/indices.js";
import { loadSessions, settingsWithDefaults } from "../backtest/run.js";
import { runSession } from "../backtest/engine.js";
import { accountSettings } from "../backtest/account.js";
import { SessionData, BarContext } from "../lab/sessionData.js";
import { attachMarketFor, marketIdsFor } from "../market/marketData.js";
import { syncIntraday, sessionsBack } from "../data/intraday.js";
import { liveQuote, niftyBreadth, indiaVix, instrumentTick } from "../data/quotes.js";
import { getStrategy, resolveParams } from "../strategies/index.js";
import { istNow, istDate, istHHMM, CLOSE_MIN } from "../lab/time.js";
import { resolveRisk } from "./sizing.js";
import * as vwap from "../vwapReversion/index.js";
import { buildReport as buildVwapReport } from "../vwapReversion/report.js";
import * as orb from "../orbEngine/index.js";
import { buildOrbReport } from "../orbEngine/report.js";

const ENGINES = {
  vwapBands: { evaluate: vwap.evaluate, configFor: vwap.configFor, build: buildVwapReport, vix: false },
  orb: { evaluate: orb.evaluate, configFor: orb.configFor, build: buildOrbReport, vix: true },
};
export const hasDecisionReport = (id) => Object.prototype.hasOwnProperty.call(ENGINES, id);
export const DECISION_STRATEGIES = Object.keys(ENGINES);

// Tops up the symbol and its indices (only bars newer than the cache are fetched).
export async function syncForReport(symbol, interval) {
  const warnings = [];
  const ids = [symbol, ...Object.values(marketIdsFor(symbol)).filter((id) => id && id !== symbol)];
  for (const id of ids) {
    try {
      const { warning } = await syncIntraday(id, interval, { fromSec: sessionsBack(id === symbol ? LAB.profileDays + 10 : 10) });
      if (warning) warnings.push(`${id}: ${warning}`);
    } catch (err) {
      warnings.push(`${id}: ${err.message}`);
    }
  }
  return warnings;
}

const noData = (strategy, symbol, interval) => {
  const why = "No candles cached for this symbol and interval.";
  const box = { score: 0, failed: ["No data"], missing: [], regime: "—", needs: ["Candle data for this symbol"] };
  return { strategy, symbol, interval, phase: "none", label: "No cached data for this symbol yet", decision: "NO TRADE", why, F: box, H: box };
};

export async function decisionReport({ strategy, symbol: raw, interval = LAB.defaultInterval, account: accountInput = {}, params: overrides = {}, nowMs = Date.now() }) {
  const engine = ENGINES[strategy];
  if (!engine) throw new Error(`No decision report for strategy "${strategy}"`);
  const symbol = String(raw || "").toUpperCase();
  const intervalMin = LAB.intervals[interval];
  if (!intervalMin) throw new Error(`Unknown interval ${interval}`);
  const now = istNow(nowMs);
  const def = getStrategy(strategy);
  const params = resolveParams(def, overrides);
  const cfg = engine.configFor(params);
  const { account, settings } = accountSettings(accountInput || {});

  const back = Math.max(LAB.historyDays, LAB.profileDays) + 5;
  const sessions = loadSessions(symbol, interval, { from: istDate(sessionsBack(back, now.t)) }).filter((s) => !s.special && s.date <= now.date);
  if (!sessions.length) return noData(strategy, symbol, interval);
  const todayFull = sessions.find((s) => s.date === now.date) || null;
  const live = Boolean(todayFull) && now.minute < CLOSE_MIN;
  let session;
  let label;
  if (live) {
    session = { ...todayFull, candles: todayFull.candles.filter((c) => c.time + intervalMin * 60 <= now.t) };
    const n = session.candles.length;
    label = n ? `Live — evaluated at the close of the ${istHHMM(session.candles[n - 1].time)} candle` : "Live — first candle still forming";
  } else {
    session = sessions[sessions.length - 1];
    label = `Market closed — evaluated at the last candle of ${session.date}`;
  }
  attachMarketFor(symbol, interval, [session], { from: istDate(sessionsBack(5, now.t)) });
  const sd = new SessionData(session, intervalMin);
  const n = session.candles.length;

  // Live inputs first: the risk budget (and so the engine's sizing) depends on the spread.
  const [{ quote, error: quoteError }, breadth, vix] = live
    ? await Promise.all([liveQuote(symbol), niftyBreadth(), engine.vix ? indiaVix() : null])
    : [{ quote: null, error: "market closed" }, null, null];
  const acct = account ? { capital: account.capital, riskPct: account.riskPct, leverage: account.leverage, maxPosition: account.maxPosition } : null;
  const risk = resolveRisk(cfg.risk, acct, quote);

  // What the strategy did today, with the spec's limits (same engine as the backtest).
  const st = settingsWithDefaults({ ...settings, riskPerTrade: risk.riskRs, maxPositionValue: risk.maxPositionValue, maxTradesPerDay: risk.maxTradesPerDay, maxDailyLoss: risk.maxDailyLossRs, indexFilter: "off", profitTarget: 0 });
  const run = n ? runSession({ session, symbol, strategy: def, params, settings: st, intervalMin, sd, live }) : { trades: [], open: null, pending: null };
  const dayPnlRs = run.trades.reduce((s, t) => s + t.net, 0);
  const lastClose = n ? session.candles[n - 1].time + intervalMin * 60 : null;
  const extras = {
    account: acct,
    quote,
    breadth,
    vix,
    symbol,
    tradesToday: run.trades.length + (run.open ? 1 : 0),
    dayPnlRs,
    nowMinute: live ? now.minute : undefined,
    staleMin: live && lastClose ? (now.t - lastClose) / 60 : undefined,
    tick: instrumentTick(symbol),
  };

  const at = (i, ex) => {
    const ctx = new BarContext(sd, params);
    ctx.i = i;
    ctx.tradesToday = ex.tradesToday ?? 0;
    return engine.evaluate(ctx, { extras: ex });
  };
  const ev = at(n - 1, extras);
  // The same decision without the live-only inputs: what the backtest / plan row sees.
  const noLive = { ...extras, quote: null, breadth: null, vix: null, staleMin: undefined };
  const evNoLive = ev.factors?.length ? at(n - 1, noLive) : ev;
  let entryEv = null;
  if (run.open) {
    const entryIdx = session.candles.findIndex((c) => c.time === run.open.entryTime);
    if (entryIdx > 0) entryEv = at(entryIdx - 1, { ...noLive, nowMinute: undefined, tradesToday: run.trades.filter((t) => t.exitTime <= run.open.entryTime).length });
  }

  // A setup that already triggered earlier: what the engine decided on that candle, and why.
  let atTrigger = null;
  const trig = ev.setup?.triggerIdx;
  if (ev.state === "fired" && trig >= 0) {
    const t = at(trig, { ...noLive, nowMinute: undefined, tradesToday: run.trades.filter((x) => x.entryTime <= session.candles[trig].time).length });
    atTrigger = { time: t.bar?.time, decision: t.decision, score: t.score, classification: t.classification?.label ?? null, why: t.why, model: t.setup?.model ?? null, taken: run.trades.some((x) => x.entryTime === session.candles[trig + 1]?.time) || run.open?.entryTime === session.candles[trig + 1]?.time };
  }

  const lastPrice = quote?.fresh ? quote.ltp : n ? session.candles[n - 1].close : null;
  return {
    atTrigger,
    ...engine.build(ev, {
      symbol,
      interval,
      phase: live ? "live" : "closed",
      label,
      asOf: now.t,
      lastPrice,
      priceSource: quote?.fresh ? `live LTP (${istHHMM(quote.time)})` : n ? `close of the ${istHHMM(session.candles[n - 1].time)} candle` : null,
      quote,
      quoteError,
      breadth,
      vix,
      run,
      entryEv,
      scoreWithoutLive: evNoLive.score,
      params,
    }),
    strategy,
    date: session.date,
    index: { nifty: MARKET_INDEX, sector: marketIdsFor(symbol).sectorId },
    account,
    params,
  };
}

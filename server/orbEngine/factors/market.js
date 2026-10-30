// Factor 2 — market regime and opening sentiment (15). A stock-specific breakout against the
// index is not rejected: the divergence is explained and scored lower.
//
//   NIFTY 50         4   direction (VWAP and day both agree) with the trade 4 · mixed 2 ·
//                        against but turning 1 · against 0
//   sector index     3   same rule (none configured = missing)
//   gap              3   a moderate gap in the breakout direction 3 · flat 2 · against 1 ·
//                        news-sized (≥ 1 × daily ATR) 0
//   previous close   2   where yesterday closed in its range (long: upper third best)
//   India VIX        1   calm and not spiking (live only)
//   breadth          2   NIFTY 50 advances ÷ declines (live only)
// Overnight global markets: no feed — always listed as missing.
import { line, factor, num, fmt } from "../../decision/util.js";

const signed = (x, d = 2) => (num(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}%` : "—");
const dirWord = (d) => (d > 0 ? "up" : d < 0 ? "down" : "mixed");

function indexNow(ctx, role, bars) {
  const now = ctx.market(role);
  if (!now) return null;
  const back = ctx.market(role, bars);
  const dayPct = now.prevClose ? (now.close / now.prevClose - 1) * 100 : null;
  const v = Math.sign(now.close - now.vwap);
  const d = num(dayPct) ? Math.sign(dayPct) : 0;
  return { ...now, dayPct, aboveVwap: now.close > now.vwap, dir: v === d ? v : 0, momPct: back ? (now.close / back.close - 1) * 100 : null, sinceOpenPct: now.dayOpen ? (now.close / now.dayOpen - 1) * 100 : null };
}

export function marketFactor(D) {
  const { ctx, cfg, long, breadth, vix } = D;
  const M = cfg.market;
  const want = long ? 1 : -1;
  const lines = [];
  const nifty = indexNow(ctx, "nifty", M.momentumBars);
  const sector = indexNow(ctx, "sector", M.momentumBars);
  const support = (x, max) => (x.dir === want ? max : x.dir === 0 ? Math.round(max / 2) : num(x.momPct) && Math.sign(x.momPct) === want ? 1 : 0);
  const describe = (x) => `${dirWord(x.dir)} (${signed(x.dayPct)} day, ${x.aboveVwap ? "above" : "below"} VWAP, last ${M.momentumBars} bars ${signed(x.momPct)})`;
  for (const [key, label, x, max, why] of [
    ["nifty", "NIFTY 50", nifty, 4, "no NIFTY 50 bars lined up with this session"],
    ["sector", "Sector index", sector, 3, "no sector index for this stock (config/indices.js), or no data"],
  ]) {
    if (!x) {
      lines.push(line(key, label, 0, max, null, why, "missing"));
      continue;
    }
    const pts = support(x, max);
    lines.push(line(key, x.name || label, pts, max, describe(x), pts === max ? `supports the ${long ? "long" : "short"}` : pts === 0 ? "against the trade" : pts === 1 ? "against, but turning" : "no clear direction"));
  }

  // Gap.
  const gap = ctx.ref.gapPct;
  const atrD = ctx.ref.atrDaily;
  const pdc = ctx.ref.pdc;
  const gapAtr = num(gap) && atrD && pdc ? (Math.abs(gap) / 100) * pdc / atrD : null;
  if (num(gap)) {
    const flat = Math.abs(gap) < M.gapFlatPct;
    const aligned = Math.sign(gap) === want;
    const huge = num(gapAtr) && gapAtr > M.gapAlignedMaxAtr;
    const pts = huge ? 0 : flat ? 2 : aligned ? 3 : 1;
    lines.push(line("gap", "Opening gap", pts, 3, `${signed(gap)}${num(gapAtr) ? ` (${fmt(gapAtr, 2)} × daily ATR)` : ""}`, huge ? "news-sized gap — unstable" : flat ? "flat open" : aligned ? "gap in the breakout direction" : "gap against the breakout direction"));
  } else {
    lines.push(line("gap", "Opening gap", 0, 3, null, "no previous close", "missing"));
  }

  // Where yesterday closed in its range.
  const y = ctx.ref.daily[ctx.ref.daily.length - 1];
  if (y && y.high > y.low) {
    const pos = (y.close - y.low) / (y.high - y.low);
    const p = long ? pos : 1 - pos;
    lines.push(line("prev", "Previous close", p >= 2 / 3 ? 2 : p >= 1 / 3 ? 1 : 0, 2, `closed ${fmt(pos * 100, 0)}% up yesterday's range`, p >= 2 / 3 ? `strong ${long ? "" : "weak "}finish for a ${long ? "long" : "short"}` : p < 1 / 3 ? "finished against the trade" : ""));
  } else {
    lines.push(line("prev", "Previous close", 0, 2, null, "no previous session", "missing"));
  }

  if (vix && num(vix.ltp)) {
    const chg = vix.prevClose ? (vix.ltp / vix.prevClose - 1) * 100 : null;
    const calm = vix.ltp <= M.vixCalm && !(num(chg) && chg > M.vixSpikePct);
    lines.push(line("vix", "India VIX", calm ? 1 : 0, 1, `${fmt(vix.ltp, 2)} (${signed(chg)})`, calm ? "calm" : "elevated or spiking — breakouts whipsaw more"));
  } else {
    lines.push(line("vix", "India VIX", 0, 1, null, "live quote only (never in backtests)", "missing"));
  }

  if (breadth && breadth.coverage >= M.breadthMinCoverage && breadth.advances + breadth.declines > 0) {
    const ratio = long ? breadth.advances / Math.max(1, breadth.declines) : breadth.declines / Math.max(1, breadth.advances);
    lines.push(line("breadth", "NIFTY 50 breadth", ratio >= M.breadthStrong ? 2 : ratio >= M.breadthFair ? 1 : 0, 2, `${breadth.advances} up / ${breadth.declines} down`, `A/D ${fmt(breadth.advances / Math.max(1, breadth.declines), 2)}`));
  } else {
    lines.push(line("breadth", "NIFTY 50 breadth", 0, 2, null, "advance / decline needs live quotes of the NIFTY 50 members (never in backtests)", "missing"));
  }

  // Regime label.
  let regime = "Neutral";
  if (num(gapAtr) && gapAtr > M.gapAlignedMaxAtr) regime = "News-driven (large gap)";
  else if (vix && vix.ltp > M.vixCalm) regime = "High-volatility";
  else if (nifty && nifty.dir !== 0 && Math.abs(nifty.dayPct ?? 0) >= M.strongDayPct) regime = `Strong directional momentum (${nifty.dir > 0 ? "up" : "down"})`;
  else if (nifty && nifty.dir > 0) regime = "Bullish";
  else if (nifty && nifty.dir < 0) regime = "Bearish";
  else if (nifty) regime = "Range-bound / mixed";

  const observation = [nifty ? `NIFTY ${dirWord(nifty.dir)} ${signed(nifty.dayPct)}` : "NIFTY n/a", sector ? `${sector.name} ${dirWord(sector.dir)}` : "sector n/a", num(gap) ? `gap ${signed(gap)}` : null].filter(Boolean).join("; ");
  return factor("market", "Market regime / sentiment", 15, lines, observation, {
    details: { nifty, sector, gapPct: gap, gapAtr, regime, vix: vix ?? null, breadth: breadth ?? null },
    extraMissing: ["Overnight global markets: no feed is connected"],
  });
}

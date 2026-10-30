// Factor 6 — VWAP and momentum (10). Supporting evidence only, and each idea is scored once
// (EMA, MACD, ADX and RSI largely measure the same push, so only one momentum line counts).
//
//   VWAP side / distance  4   on the trade's side of VWAP (2) + not stretched from it (2)
//   VWAP slope            2   rising (long) / falling (short)
//   EMA 9 / 20            2   aligned with the trade; EMA 9 slope stands in (max 1) until EMA 20 is ready
//   momentum              2   ADX ≥ 20 with ±DI in the trade's favour; MACD histogram, then RSI(5)
//                             stand in (max 1) while ADX warms up
// RSI overbought / oversold never blocks a breakout.
import { line, factor, num, fmt } from "../../decision/util.js";

export function momentumFactor(D) {
  const { ctx, cfg, long, S, i, atr } = D;
  const M = cfg.momentum;
  const want = long ? 1 : -1;
  const a = atr[i];
  const close = S[i].close;
  const lines = [];

  const vwap = ctx.ind("vwap");
  const distAtr = a > 0 ? (close - vwap) / a : null;
  const onSide = long ? close > vwap : close < vwap;
  const far = Math.abs(distAtr ?? 0);
  const vp = onSide ? 2 + (far <= M.vwapNearAtr ? 2 : far <= M.vwapFarAtr ? 1 : 0) : 0;
  lines.push(line("vwap", "VWAP side / distance", vp, 4, `${fmt(distAtr, 2)} ATR ${close >= vwap ? "above" : "below"} VWAP ${fmt(vwap)}`, !onSide ? "on the wrong side of VWAP" : far > M.vwapFarAtr ? "stretched far from VWAP" : ""));

  const vb = ctx.ind("vwap", [], M.slopeBars);
  const slope = vb != null && a > 0 ? (vwap - vb) / (M.slopeBars * a) : null;
  if (num(slope)) {
    const dir = Math.abs(slope) <= M.slopeFlat ? 0 : Math.sign(slope);
    lines.push(line("slope", "VWAP slope", dir === want ? 2 : dir === 0 ? 1 : 0, 2, `${slope >= 0 ? "+" : ""}${fmt(slope, 3)} ATR / bar`, dir === 0 ? "flat" : dir === want ? "with the trade" : "against the trade"));
  } else {
    lines.push(line("slope", "VWAP slope", 0, 2, null, `needs ${M.slopeBars + 1} bars`, "missing"));
  }

  const e9 = ctx.ind("ema", [9]);
  const e20 = ctx.ind("ema", [20]);
  const e50 = ctx.ind("ema", [50]);
  if (num(e9) && num(e20)) {
    const ok = long ? e9 > e20 : e9 < e20;
    lines.push(line("ema", "EMA 9 / 20", ok ? 2 : 0, 2, `${fmt(e9)} / ${fmt(e20)}`, ok ? "aligned" : "EMA 9 on the wrong side of EMA 20"));
  } else {
    const e9b = ctx.ind("ema", [9], 3);
    if (num(e9) && num(e9b)) {
      const ok = Math.sign(e9 - e9b) === want && (long ? close > e9 : close < e9);
      lines.push(line("ema", "EMA 9 / 20", ok ? 1 : 0, 2, `EMA 9 ${fmt(e9)}`, "EMA 20 needs 20 bars; EMA 9 slope and price vs EMA 9 stand in, worth at most 1", "substitute"));
    } else {
      lines.push(line("ema", "EMA 9 / 20", 0, 2, null, "EMA 9 needs 12 bars", "missing"));
    }
  }

  const dm = ctx.ind("adx", [M.adxPeriod]);
  const mac = ctx.ind("macd", [12, 26, 9]);
  const rsi5 = ctx.ind("rsi", [5]);
  const rsi14 = ctx.ind("rsi", [14]);
  if (num(dm?.adx)) {
    const diOk = long ? dm.plusDI > dm.minusDI : dm.minusDI > dm.plusDI;
    const pts = diOk && dm.adx >= M.adxTrend ? 2 : diOk ? 1 : 0;
    lines.push(line("mom", "Momentum (ADX / DI)", pts, 2, `ADX ${fmt(dm.adx, 1)}, +DI ${fmt(dm.plusDI, 1)} / −DI ${fmt(dm.minusDI, 1)}`, !diOk ? "directional pressure against the trade" : dm.adx < M.adxTrend ? "direction right, trend weak" : "trend with the trade"));
  } else if (num(mac?.hist)) {
    lines.push(line("mom", "Momentum (ADX / DI)", Math.sign(mac.hist) === want ? 1 : 0, 2, `MACD histogram ${fmt(mac.hist, 3)}`, "ADX not ready; MACD histogram stands in, worth at most 1", "substitute"));
  } else if (num(rsi5)) {
    lines.push(line("mom", "Momentum (ADX / DI)", (long ? rsi5 > 50 : rsi5 < 50) ? 1 : 0, 2, `RSI(5) ${fmt(rsi5, 1)}`, "ADX and MACD not ready; RSI(5) side of 50 stands in, worth at most 1 (overbought / oversold never blocks a breakout)", "substitute"));
  } else {
    lines.push(line("mom", "Momentum (ADX / DI)", 0, 2, null, "too few bars", "missing"));
  }

  const macdStatus = num(mac?.hist) ? `${mac.hist >= 0 ? "bullish" : "bearish"} (histogram ${fmt(mac.hist, 3)})` : num(mac?.macd) ? `line ${fmt(mac.macd, 3)} (signal not ready)` : "not ready (needs 26 bars)";
  return factor("momentum", "VWAP / momentum", 10, lines, `${onSide ? "right" : "wrong"} side of VWAP (${fmt(distAtr, 2)} ATR)${num(dm?.adx) ? `; ADX ${fmt(dm.adx, 1)}` : ""}`, {
    details: { vwap, vwapSlope: slope, vwapDistAtr: distAtr, vwapDistance: close - vwap, ema9: e9, ema20: e20, ema50: e50, rsi5, rsi14, adx: dm?.adx ?? null, plusDI: dm?.plusDI ?? null, minusDI: dm?.minusDI ?? null, macd: mac, macdStatus },
  });
}

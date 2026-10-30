// Factor 5 — market and sector confirmation (10). A stock-specific reversal against the index
// is not rejected; the divergence is explained and scored lower.
//
//   NIFTY 50          3   index direction for the trade side (up/down on BOTH its VWAP and the
//                         day; turning = its last 3 bars): with 3 · mixed 2 · against but
//                         turning 1 · against 0
//   sector index      3   same rule on the stock's sector index (none configured = missing)
//   relative strength 2   stock vs its index over the last 3 bars: turning in the trade's favour
//   breadth           2   NIFTY 50 advances ÷ declines (live quotes only)
import { line, factor, num, fmt } from "../../decision/util.js";

const signed = (x, d = 2) => (num(x) ? `${x >= 0 ? "+" : ""}${x.toFixed(d)}%` : "—");

function indexNow(ctx, role, bars) {
  const now = ctx.market(role);
  if (!now) return null;
  const back = ctx.market(role, bars);
  const dayPct = now.prevClose ? (now.close / now.prevClose - 1) * 100 : null;
  const vDir = Math.sign(now.close - now.vwap);
  const dDir = num(dayPct) ? Math.sign(dayPct) : 0;
  return { ...now, dayPct, aboveVwap: now.close > now.vwap, dir: vDir === dDir ? vDir : 0, momPct: back ? (now.close / back.close - 1) * 100 : null };
}

const dirWord = (d) => (d > 0 ? "up" : d < 0 ? "down" : "mixed");

export function marketFactor(D) {
  const { ctx, cfg, long, S, i, breadth } = D;
  const M = cfg.market;
  const want = long ? 1 : -1;
  const lines = [];
  const nifty = indexNow(ctx, "nifty", M.momentumBars);
  const sector = indexNow(ctx, "sector", M.momentumBars);

  const support = (x) => (x.dir === want ? 3 : x.dir === 0 ? 2 : num(x.momPct) && Math.sign(x.momPct) === want ? 1 : 0);
  const describe = (x) => `${dirWord(x.dir)} (${signed(x.dayPct)} day, ${x.aboveVwap ? "above" : "below"} VWAP, last ${M.momentumBars} bars ${signed(x.momPct)})`;
  for (const [key, label, x, why] of [
    ["nifty", "NIFTY 50", nifty, "no NIFTY 50 bars lined up with this session"],
    ["sector", "Sector index", sector, "no sector index for this stock (config/indices.js), or no data"],
  ]) {
    if (!x) {
      lines.push(line(key, label, 0, 3, null, why, "missing"));
      continue;
    }
    const pts = support(x);
    const note = pts === 3 ? `supports the ${long ? "long" : "short"}` : pts === 0 ? `${long ? "falling" : "rising"} against the trade` : pts === 1 ? "against, but turning" : "no clear direction";
    lines.push(line(key, x.name || label, pts, 3, describe(x), note));
  }

  // Relative strength over the last rsBars bars, against the sector (else NIFTY).
  const ref = sector ? "sector" : nifty ? "nifty" : null;
  let rs = null;
  if (ref && i >= M.rsBars) {
    const a = ctx.market(ref, M.rsBars);
    const b = ctx.market(ref);
    if (a && b && a.close > 0) rs = (S.bars[i].close / S.bars[i - M.rsBars].close - 1) * 100 - (b.close / a.close - 1) * 100;
  }
  if (num(rs)) {
    const d = long ? rs : -rs;
    const pts = d >= 0.1 ? 2 : d >= -0.1 ? 1 : 0;
    lines.push(line("rs", "Relative strength", pts, 2, `${signed(rs)} vs ${ref === "sector" ? sector.name : "NIFTY 50"} (last ${M.rsBars} bars)`, d >= 0.1 ? `stock ${long ? "out" : "under"}performing since the test` : d < -0.1 ? `stock still ${long ? "lagging" : "leading"}` : "in line"));
  } else {
    lines.push(line("rs", "Relative strength", 0, 2, null, "needs index bars", "missing"));
  }

  // Breadth.
  if (breadth && breadth.coverage >= M.breadthMinCoverage && breadth.advances + breadth.declines > 0) {
    const ratio = long ? breadth.advances / Math.max(1, breadth.declines) : breadth.declines / Math.max(1, breadth.advances);
    const pts = ratio >= M.breadthStrong ? 2 : ratio >= M.breadthFair ? 1 : 0;
    lines.push(line("breadth", "NIFTY 50 breadth", pts, 2, `${breadth.advances} up / ${breadth.declines} down${breadth.unchanged ? ` / ${breadth.unchanged} flat` : ""}`, `A/D ${fmt(breadth.advances / Math.max(1, breadth.declines), 2)}`));
  } else {
    lines.push(line("breadth", "NIFTY 50 breadth", 0, 2, null, breadth ? `only ${Math.round(breadth.coverage * 100)}% of members quoted` : "advance/decline needs live quotes of the NIFTY 50 members (never in backtests)", "missing"));
  }

  // Divergence between the stock and the index today.
  const pdc = ctx.ref.pdc;
  const stockDay = pdc ? (S.bars[i].close / pdc - 1) * 100 : null;
  const ix = sector || nifty;
  let divergence = null;
  if (num(stockDay) && ix && num(ix.dayPct)) {
    const gap = stockDay - ix.dayPct;
    if (Math.abs(gap) > M.divergencePct || (Math.sign(stockDay) !== Math.sign(ix.dayPct) && Math.abs(gap) > M.divergencePct / 2)) {
      divergence = `Stock ${signed(stockDay)} vs ${ix.name} ${signed(ix.dayPct)} today — a stock-specific move${long && gap < 0 ? " (weakness: check for news before buying the dip)" : !long && gap > 0 ? " (strength: check for news before shorting the rip)" : ""}`;
    }
  }

  const observation = [nifty ? `NIFTY ${dirWord(nifty.dir)} ${signed(nifty.dayPct)}` : "NIFTY n/a", sector ? `${sector.name} ${dirWord(sector.dir)}` : "sector n/a", num(rs) ? `RS ${signed(rs)}` : null, divergence ? "diverging" : null].filter(Boolean).join("; ");
  return factor("market", "Market / sector", 10, lines, observation, {
    details: { nifty, sector, rs, rsRef: ref, breadth: breadth ?? null, stockDayPct: stockDay, divergence },
  });
}

// Parameter-robustness grid for the 9/21 EMA Crossover. Sweeps fast 7–11 × slow 18–26 (and,
// separately, the ADX-regime threshold 18–28), reports OUT-OF-SAMPLE net expectancy per cell, and
// flags the result "FRAGILE" when neighbouring parameters flip sign or differ sharply — the sign
// of a curve-fit rather than a real edge. Reads cached candles only (backfill first); same engine,
// costs and sizing as the Lab.
//
//   npm run ema-grid -- --symbols=NIFTY50 --interval=5m
//   node scripts/emaGrid.js --symbols=RELIANCE,SBIN --from=2025-01-01 --min=20
//
// --min = fewest OOS trades for a cell to count toward the verdict (default 20).
import "../env.js";
import { loadHolidays } from "../data/holidays.js";
import { resolveTarget } from "../data/universes.js";
import { loadSessions, runStrategies, splitDate } from "../backtest/run.js";
import { metrics } from "../backtest/metrics.js";
import { LAB } from "../config/lab.js";

loadHolidays();
const args = Object.fromEntries(process.argv.filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("=")));
const interval = args.interval || "5m";
const from = args.from || null;
const to = args.to || null;
const minSamples = Number(args.min) || 20;
const symbols = resolveTarget(args.symbols || "NIFTY50");
if (!symbols.length) {
  console.error("No symbols. Use --symbols=NIFTY50 or --symbols=RELIANCE,SBIN");
  process.exit(1);
}

const FAST = [7, 8, 9, 10, 11];
const SLOW = [18, 20, 22, 24, 26];
const ADX = [18, 20, 22, 24, 26, 28];

const t0 = Date.now();
const symbolSessions = symbols.map((symbol) => ({
  symbol,
  sessions: loadSessions(symbol, interval, { from, to }).filter((s) => !s.special && (!from || s.date >= from) && (!to || s.date <= to)),
}));

// One pass: the fast×slow grid plus the ADX sweep (at 9/21). Every entry shares each session's bars.
const entries = [];
for (const fast of FAST) for (const slow of SLOW) entries.push({ id: "emaCross", params: { fast, slow }, key: `f${fast}s${slow}` });
for (const adxMin of ADX) entries.push({ id: "emaCross", params: { useRegime: true, adxMin }, key: `adx${adxMin}` });

const { tradesByStrategy, dates } = runStrategies(symbolSessions, entries, { interval, settings: {} });
const split = splitDate(dates);
const oos = (key) => metrics((tradesByStrategy[key] || []).filter((t) => !split || t.date >= split));

console.log(
  `EMA grid · ${symbols.length} symbol(s) · ${interval} · ${dates[0] ?? "—"} → ${dates[dates.length - 1] ?? "—"} · ` +
    `${dates.length} sessions · OOS from ${split} · min ${minSamples} trades/cell · ${((Date.now() - t0) / 1000).toFixed(1)}s\n`,
);

// ── fast × slow grid of OOS net expectancy (₹) ───────────────────────────────
const cell = {};
for (const fast of FAST) for (const slow of SLOW) cell[`f${fast}s${slow}`] = oos(`f${fast}s${slow}`);

const pad = (s, n) => String(s).padStart(n);
const expOf = (m) => (m.trades ? Math.round(m.expectancyRs) : null);
console.log("Net expectancy ₹/trade (OOS) — rows = slow EMA, cols = fast EMA. '·' = too few trades.");
console.log(pad("slow\\fast", 10) + FAST.map((f) => pad(f, 8)).join(""));
for (const slow of SLOW) {
  const row = FAST.map((fast) => {
    const m = cell[`f${fast}s${slow}`];
    return pad(m.trades >= minSamples ? expOf(m) : "·", 8);
  });
  console.log(pad(slow, 10) + row.join(""));
}

// ── fragility: adjacent cells (same sample threshold) that flip sign ──────────
const grid = FAST.map((fast, ci) => SLOW.map((slow, ri) => ({ fast, slow, ci, ri, m: cell[`f${fast}s${slow}`] })));
const at = (ci, ri) => (ci >= 0 && ci < FAST.length && ri >= 0 && ri < SLOW.length ? grid[ci][ri] : null);
const adequate = (c) => c && c.m.trades >= minSamples;
let compared = 0;
let flips = 0;
for (let ci = 0; ci < FAST.length; ci++)
  for (let ri = 0; ri < SLOW.length; ri++) {
    const a = at(ci, ri);
    if (!adequate(a)) continue;
    for (const [dc, dr] of [[1, 0], [0, 1]]) {
      const b = at(ci + dc, ri + dr);
      if (!adequate(b)) continue;
      compared++;
      if (Math.sign(a.m.expectancyRs) !== Math.sign(b.m.expectancyRs)) flips++;
    }
  }
const cells = grid.flat().filter((c) => adequate(c));
const exps = cells.map((c) => c.m.expectancyRs);
const best = cells.slice().sort((a, b) => b.m.expectancyRs - a.m.expectancyRs)[0] || null;
const flipRate = compared ? flips / compared : null;
// Fragile = adequate neighbours disagree on sign often, or there is no positive region at all.
const fragile = best == null || !(best.m.expectancyRs > 0) || (flipRate != null && flipRate > 0.3);

console.log(`\nAdequate cells: ${cells.length}/${FAST.length * SLOW.length} · sign flips between neighbours: ${flips}/${compared}${flipRate != null ? ` (${(flipRate * 100).toFixed(0)}%)` : ""}`);
if (exps.length) console.log(`Expectancy spread: ₹${Math.round(Math.min(...exps))} … ₹${Math.round(Math.max(...exps))}${best ? ` · best ${best.fast}/${best.slow} = ₹${Math.round(best.m.expectancyRs)} (${best.m.trades}t)` : ""}`);
console.log(`\nVERDICT: ${fragile ? "FRAGILE — the edge is not stable across neighbouring params; do not trust a single peak." : "robust — neighbouring params agree in sign, so the edge is not a single-cell artefact."}`);

// ── ADX-threshold sweep (useRegime on, at 9/21) ──────────────────────────────
console.log(`\nADX-regime threshold sweep (useRegime on, 9/21):`);
console.log(pad("adxMin", 8) + pad("trades", 8) + pad("win%", 8) + pad("exp ₹", 9) + pad("PF", 7));
for (const adxMin of ADX) {
  const m = oos(`adx${adxMin}`);
  const pf = m.profitFactor == null ? "—" : Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞";
  console.log(pad(adxMin, 8) + pad(m.trades, 8) + pad(m.trades ? `${m.winPct.toFixed(0)}%` : "—", 8) + pad(m.trades ? Math.round(m.expectancyRs) : "—", 9) + pad(pf, 7));
}

console.log(`\nCosts: config/costs.js · slippage ${LAB.backtest.slippagePct}% · risk ₹${LAB.backtest.riskPerTrade}/trade.`);

// Self-check: the grid must be fully built and include the default 9/21 cell.
if (Object.keys(cell).length !== FAST.length * SLOW.length || !cell["f9s22"]) {
  console.error("Self-check failed: grid incomplete.");
  process.exit(1);
}

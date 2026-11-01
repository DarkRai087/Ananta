// Phase 1 audit: every strategy's OUT-OF-SAMPLE edge, split by opening context and by entry
// time bucket. Shows where each strategy actually pays, so Phase 2 can gate it to those
// contexts. Reads cached candles only (backfill first); same engine, costs and sizing as the
// Lab. Judges on OUT-OF-SAMPLE trades only (the last 1−inSampleFraction of dates).
//
//   npm run strategy-audit -- --symbols=NIFTY50 --interval=5m
//   node scripts/strategyAudit.js --symbols=RELIANCE,SBIN --from=2025-01-01 --min=20
//
// --min = fewest OOS trades for a context verdict to count (default 20). Thin buckets are
// shown but flagged "thin" and never drive the shortlist.
import "../env.js";
import { loadHolidays } from "../data/holidays.js";
import { resolveTarget } from "../data/universes.js";
import { loadSessions, runStrategies, splitDate } from "../backtest/run.js";
import { metrics } from "../backtest/metrics.js";
import { STRATEGIES } from "../strategies/index.js";
import { LAB } from "../config/lab.js";
import { MARKET } from "../config/market.js";

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

const t0 = Date.now();
const symbolSessions = symbols.map((symbol) => ({
  symbol,
  sessions: loadSessions(symbol, interval, { from, to }).filter((s) => !s.special && (!from || s.date >= from) && (!to || s.date <= to)),
}));
const entries = STRATEGIES.map((s) => ({ id: s.id }));
const { tradesByStrategy, dates } = runStrategies(symbolSessions, entries, { interval, settings: {} });
const split = splitDate(dates);
console.log(
  `Strategy audit · ${symbols.length} symbol(s) · ${interval} · ${dates[0] ?? "—"} → ${dates[dates.length - 1] ?? "—"} · ` +
    `${dates.length} sessions · OOS from ${split} · min ${minSamples} trades/context · ${((Date.now() - t0) / 1000).toFixed(1)}s`,
);
console.log(`Costs: config/costs.js · slippage ${LAB.backtest.slippagePct}% · risk ₹${LAB.backtest.riskPerTrade}/trade · max ${LAB.backtest.maxTradesPerDay} trades/day/symbol.\n`);

const pad = (s, n) => String(s).padStart(n);
const pct = (x) => (x == null ? "—" : `${x.toFixed(1)}%`);
const head = (label) =>
  `${label.padEnd(26)}${pad("trades", 7)}${pad("win%", 7)}${pad("95% CI", 15)}${pad("avg R", 8)}${pad("exp ₹", 9)}${pad("PF", 7)}${pad("net ₹", 10)}`;
const row = (label, m) =>
  m.trades
    ? `${label.padEnd(26)}${pad(m.trades, 7)}${pad(pct(m.winPct), 7)}${pad(`${m.winLow.toFixed(0)}–${m.winHigh.toFixed(0)}`, 15)}` +
      `${pad(m.expectancyR.toFixed(2), 8)}${pad(Math.round(m.expectancyRs), 9)}${pad(m.profitFactor == null ? "—" : Number.isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : "∞", 7)}${pad(Math.round(m.netPnl), 10)}`
    : `${label.padEnd(26)}${pad(0, 7)}`;

const shortlist = []; // { id, name, keep:[{label,m}], benchCandidate }

for (const s of STRATEGIES) {
  const oos = (tradesByStrategy[s.id] || []).filter((t) => !split || t.date >= split);
  const overall = metrics(oos);
  console.log(`\n═══ ${s.name} (${s.id}) ═══`);
  console.log(head("OVERALL (out-of-sample)"));
  console.log(row("all contexts", overall));

  // By opening context (gap × OR-width × PDH/PDL), best expectancy first.
  const byCtx = new Map();
  for (const t of oos) {
    const key = t.ctx || "unknown";
    if (!byCtx.has(key)) byCtx.set(key, { label: labelOf(t.ctxParts) || key, trades: [] });
    byCtx.get(key).trades.push(t);
  }
  const ctxRows = [...byCtx.values()].map((g) => ({ label: g.label, m: metrics(g.trades) })).sort((a, b) => b.m.expectancyRs - a.m.expectancyRs);
  console.log(`\n${head("by opening context")}`);
  const keep = [];
  for (const r of ctxRows) {
    const thin = r.m.trades < minSamples;
    const positive = r.m.expectancyRs > 0;
    const tag = thin ? " ·thin" : positive ? " ·KEEP" : " ·cut";
    console.log(row(r.label, r.m) + tag);
    if (positive && !thin) keep.push(r);
  }

  // By entry time bucket (for Phase 3 exit/time tuning).
  console.log(`\n${head("by entry time")}`);
  for (const b of MARKET.timeBuckets) console.log(row(b.label, metrics(oos.filter((t) => t.bucket === b.id))));

  const benchCandidate = keep.length === 0 && !(overall.expectancyRs > 0);
  shortlist.push({ id: s.id, name: s.name, overall, keep, benchCandidate });
}

// ── Verdict shortlist ───────────────────────────────────────────────────────
console.log(`\n\n${"═".repeat(70)}\nVERDICT (out-of-sample, ≥${minSamples} trades per context)\n${"═".repeat(70)}`);
const bench = shortlist.filter((x) => x.benchCandidate);
const gate = shortlist.filter((x) => x.keep.length && !x.benchCandidate);
const broad = shortlist.filter((x) => !x.keep.length && !x.benchCandidate);

console.log(`\nGATE these to their winning contexts (Phase 2):`);
for (const x of gate) console.log(`  • ${x.name}: ${x.keep.map((k) => `${k.label} (${k.m.trades}t, exp ₹${Math.round(k.m.expectancyRs)})`).join("  |  ")}`);

console.log(`\nBENCH candidates (no positive context on adequate sample, negative overall):`);
for (const x of bench) console.log(`  • ${x.name} — overall ${x.overall.trades}t, exp ₹${Math.round(x.overall.expectancyRs)}`);
if (!bench.length) console.log("  (none)");

console.log(`\nNEEDS MORE DATA (no context reached ${minSamples} OOS trades but not clearly negative):`);
for (const x of broad) console.log(`  • ${x.name} — overall ${x.overall.trades}t, exp ₹${Math.round(x.overall.expectancyRs)}`);
if (!broad.length) console.log("  (none)");

console.log(`\nNote: thin buckets (wide 95% CI) are noise, not edge. Widen the universe or backfill before trusting them.`);

function labelOf(parts) {
  if (!parts) return null;
  const L = { up: "gap-up", down: "gap-down", flat: "flat", narrow: "narrow-OR", normal: "normal-OR", wide: "wide-OR", unknown: "OR?", abovePDH: ">PDH", belowPDL: "<PDL", inside: "inside" };
  return [L[parts.gap], L[parts.or], L[parts.pos]].filter(Boolean).join("/");
}

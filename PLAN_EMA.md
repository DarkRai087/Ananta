# PLAN_EMA — harden the 9/21 EMA Crossover

STEP 0 output. No code yet. Read this, correct the three decisions at the bottom, then I build step by step with a diff summary after each.

## The reframe (important)

A 9/21 EMA crossover strategy **already exists**: [emaCross.js](server/strategies/emaCross.js). It does EMA 9/21 on closed 5m candles, enters at the next bar's open, long+short, swing stop, optional exit on the opposite cross, and a live `plan()`. The Nov-1 OOS audit ([index.js:30](server/strategies/index.js#L30)) **benched it** — net-negative after costs out-of-sample in every adequate-sample context. That matches the saved audit note: *the issue is edge, not accuracy/warmup.*

So almost none of your spec is missing *plumbing* — the engine already enforces the hard things you asked for. The real work is adding the **toggleable filters** (STEP 2) so we can A/B whether any of them turns the net-negative edge positive, plus a **robustness grid**, **avg-hold** metric, and the **UI breakdown**. We build on `emaCross`, we do not add a second strategy.

### What the framework already gives us (do NOT rebuild)

| Your ask | Already done, where |
|---|---|
| Signal on closed candle, fill next bar open, no look-ahead | [engine.js](server/backtest/engine.js) + `BarContext` guard + `lookahead.test.js` / `sessionLeak.test.js` |
| Long/short each toggleable | `allowLong` / `allowShort` ([common.js](server/strategies/common.js)) |
| Time window: no entries before 09:30 / after 14:45, force-exit | `entryStart` / `entryEnd` / `settings.squareOff` (default 15:15) |
| ATR stop, % stop, structure stop | `stopType` + `atrMult` in the engine's `bracket()` |
| Trail on ATR / VWAP / swing; breakeven | `trailType`, `trailAtrMult`, `breakevenR` in `trailStop()` |
| Opposite crossover as fallback exit | `exitOnCross` in `emaCross.onBar` |
| Position size = risk / stop distance, whole shares, cap by capital | `sizeForRisk()` ([costs.js](server/backtest/costs.js)) |
| Round prices to NSE tick | `tickFor` / `roundTick` ([decision/util.js](server/decision/util.js)) |
| All NSE costs (STT, brokerage, exch, SEBI, stamp, GST) net of P&L | [config/costs.js](server/config/costs.js) + `tradeCosts()` |
| Trade count, win%, avg R, expectancy, PF (net), max DD, % time-stop, exit breakdown | [metrics.js](server/backtest/metrics.js) |
| Walk-forward IS/OOS split + verdict | `splitDate` + `walkForwardFlag` + `strategyAudit.js` + `timemachine/src/walkforward.js` |
| Feed a plan into the Time Machine | `timemachine` task ([tasks.js:101](server/workers/tasks.js#L101)); takes `{entry,stop,target,until}` |
| NIFTY vs its VWAP, available to a strategy | `ctx.market("nifty").vwap` ([sessionData.js:163](server/lab/sessionData.js#L163)) |

### Genuinely missing (this is the actual work)

1. Regime filter: ADX(14) > thr **and** |EMA9−EMA21|/ATR(14) > min-separation. (`adx` + `ema` + `atr` indicators all exist; filter logic is new, in `emaCross.onBar`.)
2. Higher-timeframe 15m EMA21 slope agreement — **no HTF access in `ctx`** (see Decision 2).
3. Relative-volume filter: signal-bar vol ≥ 1.5× the 20-session average for that time-of-day slot — the per-slot seasonal average is not computed anywhere today.
4. Universe exclude list (ASM/GSM/near-circuit) — [config/universes.js] has lists; need one exclusion set the audit/Lab honor.
5. Robustness grid (fast 7–11, slow 18–26, ADX 18–28) + "fragile" flag — new script, modeled on [strategyAudit.js](server/scripts/strategyAudit.js).
6. Avg holding time — one line in `metrics.js`.
7. `trailType: "ema"` (trail on EMA21) — one branch in `trailStop()`.
8. UI: expectancy + PF next to win%, and a "filters passed" breakdown for today's signal.

## Three decisions I need from you before STEP 1

**Decision 1 — EMA seeding across sessions.** You asked to seed EMAs from prior sessions so 09:15 is valid (no daily reset). The whole app is built the opposite way: **every** indicator restarts at 09:15 and reads nothing from a prior session — enforced by `sessionLeak.test.js` and the `SessionData` design. `ctx` has no prior-session intraday bars at all. Seeding would be a structural change to the candle/indicator core, break a core invariant, and make EMA behave unlike every other indicator and the chart. Given the audit says the edge (not warmup) is the problem, the ~1h45m of pre-warmup signals this buys is low value for high structural cost.
   - **My recommendation: keep per-session EMAs** (what `emaCross` already does; `warmup` blocks entries until 21 bars exist, ~10:50 on 5m). If you still want seeding, I'd scope it as a strategy-local seeded series fed from prior-session closes passed through `session`, *not* a change to `indicators.js` — bigger, and I'll quote it separately.

**Decision 2 — 15m HTF EMA21 slope filter.** `ctx` is single-interval; there's no 15m feed inside a 5m backtest. Cheapest correct option: **aggregate the current session's 5m bars up to 15m inside `onBar`** (causal, no new data path) and take EMA21 slope on that. Alternative (bigger): a second candle series threaded through `SessionData`. I recommend the in-strategy aggregation. OK?

**Decision 3 — partial exit at 1R.** The engine is strictly **one position, one exit** — no scale-outs anywhere. A true "exit half at 1R, trail the rest" means adding partial fills to the engine, the trade record, `metrics` and sizing, and re-proving no-lookahead + the equivalence hash for all 19 strategies. That's the single most invasive item in your spec.
   - **My recommendation: defer partial exits.** Ship breakeven-at-1R + EMA21/ATR trail first (already supported), measure, and only build scale-outs if the filtered strategy shows a real edge worth the engine surgery. OK to defer?

## Build order (after your OK), diff summary after each step

- **STEP 1 — base.** No new strategy. Confirm `emaCross` meets STEP 1; add `timeframe` only if not already a Lab param (interval already is). Make seeding decision per Decision 1. *Likely a near-zero diff.*
- **STEP 2 — filters**, each a toggleable param on `emaCross` (default off so A/B is clean): `useRegime`/`adxMin`/`minSepAtr`, `useHtf` (Decision 2), `useRelVol`/`relVolMult` + the per-slot 20-session average helper, `useMarketVwap` (via `ctx.market`), and the universe exclude set. Verify `ctx.market` is populated in **backtest** (not only live) before relying on the NIFTY-VWAP filter — this is a known gap for backtests and may need gating.
- **STEP 3 — exits/sizing.** Add `trailType:"ema"`; wire tick rounding of entry/stop into the engine's `open()`/`bracket()` (reuse `roundTick`); confirm `sizeForRisk` cap covers "max capital per position" (it does via `maxValue`). Partial exits per Decision 3.
- **STEP 4 — costs.** Already config-driven. Only change if you want slippage expressed in **ticks/side** instead of the current `slippagePct` — minor, flag your preference.
- **STEP 5 — eval + UI.** Add avg-hold to `metrics.js`; new `scripts/emaGrid.js` (grid + fragility flag, built on the audit harness + `walkForwardFlag`); surface expectancy/PF and a "filters passed" list in `ranking/today.js` + `StrategyDetail.jsx`. Time Machine already consumes the plan.

## Tests I'll add/keep green
EMA value/seeding (per Decision 1), no-look-ahead fill (existing suites must stay green), each new filter gates the right bars, sizing + tick rounding, cost math (existing), and the grid's fragility flag. Verify with `cd server && npm test` + an equivalence hash vs HEAD for the 18 untouched strategies.

---
Skipped for now: I did not read `StrategyDetail.jsx`, `config/universes.js`, or `plans/` in detail, and did not run the audit to get fresh emaCross OOS numbers — I'll do those when the relevant step starts.
Risk: the single biggest uncertainty is whether **any** filter combination makes emaCross net-positive OOS — the audit suggests it may not, so the honest outcome of this work could be "still benched, now with evidence." Decisions 1 and 3 are where you can cut the most cost.

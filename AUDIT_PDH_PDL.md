# AUDIT — Previous Day High/Low Breakout (v1)

PHASE 1, read-only. Baseline in [baseline_metrics_pdh.json](baseline_metrics_pdh.json).

## a) What it does, step by step

Source: [pdhPdlBreakout.js](server/strategies/pdhPdlBreakout.js) (`id: "pdhPdl"`), registered in [strategies/index.js](server/strategies/index.js).

Per closed bar `i` (`onBar`):
1. Read `pdh/pdl` from `ctx.ref` ([sessionData.js BarContext](server/lab/sessionData.js)) = `session.prev.high/low`, the previous **regular** session's daily high/low (built in [sessions.js buildSessions](server/lab/sessions.js), where `prev` = the last non-special session's `dailyBar`).
2. `up = pdh × (1 + bufferPct/100)`, `dn = pdl × (1 − bufferPct/100)`.
3. **Long** if `close > up` **and** the previous bar's `close ≤ up` (a fresh cross); **short** mirror below `dn`. Stop = the breakout bar's other end (`c.low` / `c.high`). No target.
4. Fill/exit/sizing/costs are the shared engine ([engine.js](server/backtest/engine.js)): next-bar-open fill, `bracket()` applies `stopType`/`targetR`, `sizeForRisk()` sizes, square-off at `settings.squareOff`. All P&L net of costs + slippage.
5. `plan(ctx)` draws long/short watch triggers at `up`/`dn` with an estimated stop — UI only.

## b) Parameters and where they live

Strategy ([pdhPdlBreakout.js:9](server/strategies/pdhPdlBreakout.js#L9)): `bufferPct 0.05`, `entryStart "09:20"`, `entryEnd "14:30"`.
Shared ([common.js](server/strategies/common.js)): `stopType "structure"`, `atrMult 1.5`, `targetR 2`, breakeven/trail. Run settings ([config/lab.js](server/config/lab.js)): risk ₹1000, slippage 0.05%, `maxTradesPerDay 2`, `maxPositionValue`, `squareOff 15:15`. Costs: [config/costs.js](server/config/costs.js). Calendar/special sessions: [config/market.js](server/config/market.js) `specialSessions` + [data/holidays.js](server/data/holidays.js).

## c) Bugs and biases (the nine checks)

| Check | Verdict | Detail |
|---|---|---|
| "Previous day" = calendar vs NSE trading day | **OK** | `buildSessions` iterates **actual session dates** (dates that have candles); `prev` = the last **non-special** session. Weekends/holidays have no candles, so they're skipped automatically. No calendar-day bug. |
| PDH/PDL includes pre-open / post-close | **OK** | `isSessionCandle` restricts to 09:15–15:30 ([sessions.js](server/lab/sessions.js)); Yahoo fetch sets `includePrePost:false`. (Assumes the provider doesn't emit a pre-open bar stamped 09:15.) |
| Unadjusted splits/bonus break levels | **BUG (provider-dependent)** | Yahoo OHLC is **split/bonus adjusted** ([yahoo.js:96](server/data/providers/yahoo.js#L96)). **SmartAPI — the active provider here — has no adjustment** ([smartapi/index.js](server/data/providers/smartapi/index.js)): a split/bonus between the reference day and today leaves PDH/PDL on the old price scale, firing false breakouts. Real latent risk for any price-level strategy. |
| Short special sessions (Muhurat) as the reference day | **OK** | `prev` only advances on non-special sessions, so a Muhurat/short session is never the reference, and its own `prev` is the last regular day. Config: `specialSessions` + `registerSpecialDate` for "*"-marked holidays. |
| Signal on intrabar wick (high > PDH) vs closed close | **OK** | Uses `c.close > up`, never `c.high`. No wick-trigger bug. |
| Look-ahead: signal + fill same bar | **OK** | Signal at close `i`, fill at next bar open (engine `pending`). Guarded by [lookahead.test.js](server/tests/lookahead.test.js). |
| Gap-up/down treated as normal breakouts | **Partial / missing** | No open classification. The fresh-cross guard (`prev.close ≤ up`) means a gap-up open (already above PDH) usually produces **no** fresh intraday cross, so gaps aren't *chased* — but they're not routed to gap-specific support/retest logic either. GAP_UP/GAP_DOWN handling is absent. |
| Repeated re-triggering in one day | **Minor bug** | The cross guard checks only the immediately prior bar, so price oscillating across PDH can re-trigger the same side; the only cap is `maxTradesPerDay` (2). No explicit one-trade-per-side-per-day rule. |
| No costs / slippage | **OK** | Full charges + slippage applied; metrics are net. |

**Also:** `bufferPct` is a **percent**, not an ATR buffer (spec wants ≥ 0.1 ATR); no VWAP-side check; no RVOL; no acceptance (hold/retest); no day-quality filters; CPR exists (`ctx.pivots`) but is **unused**; no previous-day VWAP / weekly levels; no min-stop floor, measured target or time stop; `entryStart 09:20` (spec wants 09:30–11:30, nothing after 14:00). Benched ([index.js:30](server/strategies/index.js#L30)); baseline confirms it's net-negative.

## d) Missing vs the PHASE 2 spec

Present (reuse): trading-calendar `prev`, session-only levels, special-session skip, CPR (`ctx.pivots`), daily ATR (`ctx.ref.atrDaily`), 20 daily bars (`ctx.ref.daily` → weekly high/low, NR4/NR7), per-slot RVOL (`ctx.ref.profile`), `ctx.market("nifty").vwap`, next-bar fills, costs/sizing, metrics, walk-forward, Time Machine, tick helpers.

Missing (build in v2): ATR-measured open classification (INSIDE / GAP_UP / GAP_DOWN) with per-trade tagging; ATR buffer + hold/retest acceptance; VWAP-side + RVOL gates; one-per-side-per-day; day-quality score (prev-range/ATR, NR4/NR7, close location, ADR skip, CPR-width percentile, confluence); CPR / weekly-high-low / previous-close targets + measured move; min-ATR stop, time stop; optional fade module; richer stats/UI; cross-strategy dedupe. **Not freely available:** previous-day VWAP (no prior-session intraday in `ctx`), corporate-action adjustment on SmartAPI.

## Baseline (last 60 sessions × 10 liquid stocks)

[baseline_metrics_pdh.json](baseline_metrics_pdh.json) — v1, 5m, 2026-08-05 → 2026-10-30, RELIANCE/TCS/SBIN/INFY/ITC/LT/AXISBANK/KOTAKBANK/SUNPHARMA/TITAN.

| | v1 |
|---|---|
| Trades | 515 |
| Win % | 23.9 |
| Avg R | −0.48 |
| Expectancy | −₹471/trade |
| Profit factor | 0.36 |
| Max drawdown | ₹242,396 |
| Avg hold | 59 min |
| Net P&L | −₹242,396 |

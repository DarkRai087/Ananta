# NSE Chart Viewer + Intraday Lab (local)

Runs only on your machine and costs nothing. Research only: **no orders, no paper trading.**

- **Phase 1 – Chart viewer:** full daily history (Yahoo), 1D / 1W / 1M / 1H, symbol search, SQLite cache.
- **Phase 2 – Intraday lab (NSE cash, intraday only):** 1m / 3m / 5m / 15m candles from Angel One SmartAPI, overlays, 17 pattern detectors with same-session stats, 19 intraday strategies, a bar-by-bar backtester after real costs, walk-forward split, **Today's Top 3**, and an all-strategies scoreboard.

## Requirements

- Node.js 20 or newer (tested on Node 24)
- An Angel One account with SmartAPI enabled, for years of intraday history. Without it the lab falls back to Yahoo, which only keeps ~60 days of 5m/15m and ~7 days of 1m/3m.

## Setup

```bash
npm install          # installs root, server/ and client/
npm run dev          # server on :4000 + client on :5173 (concurrently)
```

Open **http://localhost:5173**.

### Angel One SmartAPI setup

1. Log in at https://smartapi.angelone.in and create an app under **My Apps**. Any redirect URL works. Copy the **API Key**.
2. Enable TOTP at https://smartapi.angelone.in/enable-totp. When it shows the QR code, also copy the **text secret** (the long code under the QR). Add it to your authenticator app as usual.
3. Copy `server/.env.example` to `server/.env` and fill it in:

   ```
   SMARTAPI_API_KEY=your_api_key
   SMARTAPI_CLIENT_CODE=A1234567
   SMARTAPI_PIN=1234
   SMARTAPI_TOTP_SECRET=THE_TEXT_SECRET
   ```

4. Restart `npm run dev`. The nav bar badge turns green (**SmartAPI**). To check the login:
   `curl -X POST http://localhost:4000/api/lab/smartapi/test`

How it works:

- **Login:** the server generates the TOTP with `otplib` and logs in on demand. The session is cached in SQLite and shared by the server, the backfill script and worker threads.
- **Expiry:** sessions expire at midnight IST, so a new day triggers a new login. An expired or invalid token is refreshed with the refresh token, falling back to a fresh login.
- **Instruments:** symbols are mapped to SmartAPI tokens using Angel's instrument master JSON, cached in SQLite and re-downloaded once per day.
- **Limits:** all limits are in `server/config/smartapi.js`, copied from the official docs. History requests are split into chunks of at most 30 / 60 / 100 / 200 days for 1m / 3m / 5m / 15m. A queue keeps candle requests under 2/sec, 80/min and 5000/hour. The request times are kept in SQLite, so the server, the backfill script and the worker threads share that one budget (Angel counts per account). Interactive requests (chart, plans, reports) go first; bulk work (a job's data sync, the backfill) waits for free slots and leaves 15 requests a minute for them. A rate-limit reply (HTTP 403 "exceeding access rate") is retried with backoff: 2s, 4s, 8s, 16s, 32s.
- **Credentials:** `server/.env` is git-ignored. Never commit or share it.

### Backfill intraday history

```bash
npm run backfill -- --symbols=NIFTY50 --interval=5m --years=2
npm run backfill -- --symbols=RELIANCE,TCS --interval=1m,5m --years=1
npm run backfill -- --symbols=WATCHLIST --interval=15m --from=2024-01-01
```

- `--symbols` takes symbols and/or universe names (`NIFTY50`, `NIFTY100`, `WATCHLIST`). `NIFTY50` expands to its 50 stocks plus the NIFTY 50 index.
- **Resumable:** stop with Ctrl+C at any time. Every chunk is saved as it arrives. Older history is fetched newest-first, so an interruption still leaves one unbroken block, and the next run fetches only what's missing.
- **Time:** at 80 requests/min, 2 years of 5m for NIFTY 50 is about 450 requests (~6 min). 2 years of 1m is about 1,300 requests (~17 min).

The lab and Top 3 also fetch missing data on demand, so backfilling first just makes them start faster.

## The session-bound rule

Everything lives inside one session, 09:15–15:30 IST:

- **Candles:** pre-open and post-close candles are dropped. Holidays have no session. NSE's holiday list is fetched and cached. Muhurat or special sessions become their own short "day", are excluded from backtests, and are never used as the previous day. Their windows are in `server/config/market.js`.
- **Indicators:** EMA, ATR, RSI, Bollinger, Supertrend and VWAP all restart at 09:15. Zigzag swing points reset each day.
- **Prior-day data:** the only data allowed from earlier sessions is daily bars: previous-day high / low / close (PDH, PDL, PDC, gap, CPR, floor and Camarilla pivots) and the daily OHLCV of the last 20 sessions (`ctx.ref.daily`, `ctx.ref.atrDaily`, used by NR7 and ATR exhaustion). These are derived from earlier sessions' intraday candles. The one other exception is the *opening profile* of up to 60 earlier sessions (`ctx.ref.profile`): opening-range widths and volumes, and volume / range by minute. These are summaries for the ORB engine's percentiles and same-time-of-day volume, never candles.
- **Pattern forward returns:** they stop at the last bar that closes by 15:15 the same day.
- **Trades:** every trade opens and closes the same day, with a forced exit at 15:15.

**Side effect of restarting indicators at 09:15:** on 15m bars, 20-bar indicators are only ready at about 14:15. So the 9/21 EMA, Volume Breakout and RSI/Bollinger strategies take few or no trades on 15m. Use 1m, 3m or 5m for them.

## Main screen

1. **Today's Top 3** (top). Pick the symbol or a universe, the interval (5m default) and the out-of-sample window (60 sessions default).
2. **Chart.** It shows the Phase 1 clean chart by default. On intraday intervals you can toggle overlays (VWAP, EMA 9/21, PDH/PDL, opening range 5/15/30m, CPR + pivots, Supertrend 10,3, Bollinger 20,2, RSI 14 in a sub-pane) and pattern markers per pattern. Everything is off by default.
3. **All-strategies scoreboard** (bottom). It has all 19 strategies with sortable columns, green when net expectancy after costs is above 0 and red otherwise. Toggles: *All sessions / Sessions like today*, and *Out-of-sample* (default) / *In-sample*. **Click a strategy (▸) for a details dropdown, and click again (▾) to close it.** Opening Range Breakout and VWAP σ-Band Reversion open their full live decision analysis for the chart symbol. The others show their description, today's plan and how their backtested trades ended, by exit and by time of day.

### How the Top 3 is ranked (no black box)

1. **Backtest:** every strategy is backtested with default params, after costs, over the last W sessions, where W = N ÷ 0.3. With N = 60, that's 200 sessions. The last N sessions are the out-of-sample period.
2. **Today's context:** once the opening range completes (default 15 min, i.e. 09:30), each symbol is classified on three things, set in `server/config/lab.js`:
   - **Gap:** gap from the previous close is up, down, or flat (within ±0.5%).
   - **Opening range:** its width ÷ 14-day ATR is narrow (< 0.25), normal, or wide (> 0.5). The ATR comes from daily bars derived from the intraday candles.
   - **Position:** price at 09:30 is above PDH, below PDL, or inside the prior range.
3. **Matching sessions:** only out-of-sample trades from past sessions with the same context are kept.
4. **Ranking:** strategies are ranked by net expectancy in ₹, then in R. A strategy needs at least 30 matching trades; below that it shows "not enough data". If nothing is positive you get **"No edge today — sit out"**.

**When it updates:**

- **Before 09:15** it ranks on recent out-of-sample performance only, labelled *Pre-market (no today context yet)*.
- **From 09:30** it re-ranks with today's context and refreshes every 5 min.
- **At 10:30** it freezes for the day. The snapshot is saved in SQLite.

Clicking a card draws that strategy's key levels for today on the chart (OR high/low, VWAP, PDH/PDL, CPR, …).

If you match on all three context dimensions, a single stock rarely reaches 30 trades. Use a universe, or drop a dimension in `LAB.context.match`.

## Lab page

Choose a symbol or universe, then the interval, date range, Strategy or Patterns, and params, and press **Run**. Heavy work runs in a worker thread with a progress bar.

**Strategy results:**

- Trades, win / loss / forced-exit %, average win and loss, expectancy in R and ₹ after costs, gross vs net, profit factor and max drawdown, for All, In-sample (first 70% of dates) and Out-of-sample (last 30%).
- A verdict: *Holds out-of-sample*, *Works in-sample only*, …
- An equity curve with the split marked, a time-of-entry breakdown, and the full trade list. Click a trade to open its day.

**Pattern results:**

- Count and forward move after +3 / +6 / +12 bars (capped at 15:15), win rate, and average move.
- All of it is compared with a baseline of random bars from the same sessions, with a t-stat and a verdict (*edge* / *weak edge* / *no edge* / *not enough data*). Click a row for the time-of-day buckets.

**Day picker:** step through sessions with entry and exit markers (or pattern markers) and stop/target lines.

## Backtester rules

- **Fills:** a signal on a bar's close fills at the **next bar's open**, in the same session. A signal on the last bar is discarded.
- **Entry timing:** no entries before the strategy's warm-up, outside its entry window, or at/after the cutoff (14:45).
- **Square-off:** forced at **15:15**, before the broker's MIS auto square-off.
- **Positions:** one position per symbol. There's a maximum number of trades per day, and a daily max-loss that halts the rest of the day.
- **Stops and targets:**
  - Stop types are structure, ATR or percent. The target is N × R, or the strategy's own target when R = 0.
  - Optional stop management (off by default): move to breakeven after N × R, and/or trail by ATR, VWAP or the last N bars' swing. The stop is recomputed at each bar's close, only tightens, and is used from the next bar. R is still measured from the initial stop; a moved stop exits as `trail`.
  - If the stop and target are both touched in the same bar, the stop counts first. A gap through a level fills at the open.
- **Sizing:** `qty = floor(risk ÷ |entry − stop|)`, capped by the max position value.
- **Slippage:** 0.05% by default. It applies to entries and market exits; targets fill at the limit price.
- **Costs** (`server/config/costs.js`):
  - Brokerage ₹20/order
  - STT 0.025% on the sell side
  - NSE transaction charge 0.00297%
  - SEBI fee ₹10/crore
  - Stamp duty 0.003% on the buy side
  - GST 18% on brokerage + transaction charge
- **Outcomes:** each trade is a **win** (net > 0), a **loss** (net ≤ 0) or **forced** (15:15 exit). The three add up to 100%.
- **Walk-forward:** this is a fixed split (first 70% of dates vs last 30%), not parameter re-optimisation. A strategy that only makes money in the first part is flagged *Works in-sample only*.

## VWAP Pullback (trend-day continuation)

The `vwapPullback` strategy buys a dip to VWAP on a confirmed up-trend day (short: the mirror).
The full hypothesis and rule set are in [`server/strategies/vwapPullback.md`](server/strategies/vwapPullback.md);
every threshold is a param on the strategy and editable in the Lab. In short: VWAP must be
sloping and uncrossed, price must have held one side, a low-volume pullback must touch VWAP, and
the entry is the reclaim bar that closes above the prior high and back through VWAP. The stop is
`min(pullback swing low, VWAP − 0.25·ATR)` on the NSE tick; target is 2R (or the VWAP ±σ band).

**Run a backtest:** Lab page → pick *VWAP Pullback*, the NIFTY 50 symbols and **5m** (the only
stored intraday interval), a date range, then run. It uses the shared engine, costs and sizing.

**Read the result:** look at the **out-of-sample** column, not the headline. A win % is only
meaningful next to its expectancy and trade count: the card shows win % with its Wilson 95%
interval, expectancy in R and ₹ (net of costs), profit factor, max drawdown and the walk-forward
flag. Judge it an edge only if the out-of-sample expectancy is positive with a profit factor
above ~1.2 and enough trades (aim for ≥100) to trust the win %.

> On the ~232 sessions of 5m history available locally (Nov 2025 → Oct 2026, 60 names), the
> default params produce **no edge**: 134 trades, win 28%, expectancy −0.37R, profit factor 0.47,
> negative both in- and out-of-sample (gross too, so it is not a cost problem). Out-of-sample has
> only 38 trades — below the ≥100 bar — so the honest verdict is **no proven edge**. The filters
> would need rethinking (or more history) before this is tradable; don't tune them on this whole
> sample, which would just overfit. Results use today's NIFTY 50 list (survivorship caveat).

## VWAP σ-Band Reversion (eight-factor decision engine)

The `vwapBands` strategy never trades a band touch on its own. On every bar, `server/vwapReversion/` analyses the setup, scores it, checks the mandatory conditions, and only then gives one decision: **LONG**, **SHORT**, **WATCHLIST** or **NO TRADE**. The backtest (`onBar`), the trade-plan row (`plan`) and the decision report all run this same code. Every number lives in `server/config/vwapReversion.js`.

**The setup (long; short is the mirror):**

1. A bar's low reaches the −2σ band. That bar is the rejection candle (σ = volume-weighted σ of typical price around session VWAP).
2. A completed candle closes back above −2σ.
3. Within 6 bars, a later completed candle closes above the rejection candle's high. That is the trigger. Entry is at the next bar's open.

No prices are shown before step 2: until then the rejection candle isn't finished, so its high isn't known.

**Score (100):**

| Factor | Max | What earns points |
|---|---:|---|
| Market regime | 20 | ADX(14) low, ±DI balanced, VWAP flat, EMA 20/50 intertwined, mixed swings, stable ATR |
| VWAP / deviation | 15 | Stretch of 2.5–3σ (deeper scores *less*), a quick spike, σ not widening, room left to VWAP |
| Price action | 20 | Rejection wick and close, a reversal pattern (lab detectors), a failed breakdown, close back inside, the trigger |
| Volume / order flow | 15 | High-volume rejection, trigger volume, buying pressure since the test, volume drying up into the extreme, live order book |
| Market / sector | 10 | NIFTY 50 and the sector index with the trade, relative strength turning, NIFTY 50 breadth |
| Liquidity | 10 | ₹ traded per minute, small share of bar volume, low cost drag, live spread and depth |
| Risk-reward | 10 | Net R:R to VWAP after every charge and slippage, a stop 0.5–2 ATR away, a feasible size |

Missing data scores 0 and is listed in the report. It never counts as confirmation. Until ADX(14) and EMA 50 are ready (they restart at 09:15), the efficiency ratio and the EMA 20 slope stand in for them, for fewer points.

**Mandatory conditions.** Any one failing means NO TRADE, whatever the score:

- the entry window (10:00–14:30), and enough time to reach VWAP before 15:15
- no scheduled event (the `events` list in the config), no candle of 3.5 ATR or more in the last 6, no abnormal day (range ≥ 2 × daily ATR), no opening gap of ±3% or more
- not fading a strong trend that rides the outer band
- the reversal is confirmed
- enough traded value, a liquid stock, a size under 10% of bar volume; live only: spread ≤ 0.25% and clear of circuit limits
- net R:R ≥ 1.5, at least one share, ≤ 3 trades a day, today's loss under 1% of capital

Risk per trade is held at 0.25–0.5% of capital. A larger account setting is capped at 0.5%.

**Decision.** Triggered + score ≥ 85 + every condition passing = LONG / SHORT. A score of 65 or more without the trigger (or below 85) = WATCHLIST, with the levels marked CONDITIONAL. Everything else is NO TRADE, and the report shows no entry, stop, target or quantity.

**Live-only inputs.** Bid / ask, best-5 depth, circuit limits and total bid / ask quantity come from a SmartAPI quote; NIFTY 50 advances / declines come from one quote call. Backtests never have them, so those 8 points can't be earned there. No news feed is connected: only the event calendar and the price-shock checks stand in. Cumulative volume delta and absorption need tick data, so they are always listed as missing.

**Where to see it:**

- **Today page → All strategies → click "VWAP σ-Band Reversion" (▸)**: sections A–F of the spec (market analysis, the seven σ bands, the scorecard with sub-scores, the trade plan, the explanation, or why there is no trade), for the chart symbol. "Show on chart" draws the bands and levels. Click again (▾) to close.
- `GET /api/lab/decision-report?strategy=vwapBands&symbol=RELIANCE&interval=5m&capital=200000&riskPct=0.5`
- **Lab:** backtest `VWAP σ-Band Reversion` and lower *Min setup score* to study it. Backtests line up NIFTY 50 and the sector index bar by bar (`ctx.market`).

**Does the score mean anything?**

```bash
npm run vwap-research -- --symbols=NIFTY50 --interval=5m   # = strategy-research --strategy=vwapBands
```

This backtests every confirmed setup that passes the mandatory conditions, groups the trades by score band, in-sample and out-of-sample, and gives the score-vs-result rank correlation.

On NIFTY 50, 5m, Nov 2025 – Oct 2026 (275 sessions):

- 166 setups, 25% wins, −0.38R average after costs
- no setup scored 75 or more
- no link between score and result (correlation −0.01)

So at the default 85 the strategy doesn't trade on that data, and the weights are a starting point to research, not a proven edge.

## Opening Range Breakout (multi-factor decision engine)

The `orb` strategy never trades a cross of the opening range on its own. `server/orbEngine/` follows *analyse → validate → score → calculate → decide* on every bar and gives one decision: **LONG**, **SHORT**, **WATCHLIST** or **NO TRADE**. The backtest, the trade-plan row and the decision report all run the same code. Every number lives in `server/config/orb.js`. The opening range is 15 minutes by default (5 / 15 / 30 / 60 in the Lab).

**Entry models (long; short is the mirror):** the breakout is the first completed candle that closes above ORH (+0.05%). Then one of:

- **A: close + acceptance.** The next candle also holds above ORH. Entry at the open after it.
- **B: retest.** Price comes back to ORH, holds it, prints a rejection candle there, and a later candle closes above that candle's high.
- **C: momentum.** The breakout candle itself is strong: body ≥ 60%, closing in the top quarter, volume ≥ 1.5× the same time of day.

A close meaningfully back inside the range fails the breakout. That side stays off for the day, with no automatic reversal. An A or C entry more than 1 ATR beyond the level is a chase and is skipped; a later retest (B) can still qualify. An open trade is exited if a candle closes back inside the range.

**Score (100):**

| Factor | Max | What earns points |
|---|---:|---|
| Opening range quality | 15 | Width percentile vs earlier sessions (normal best), OR volume, room to PDH / PDL, two-sided formation |
| Market regime / sentiment | 15 | NIFTY 50 and the sector with the trade, the gap, yesterday's close, India VIX, breadth |
| Relative volume | 15 | Breakout candle vs the **same time of day** in earlier sessions, expansion, follow-through or a quiet retest, no absorption |
| Breakout candle | 15 | Body, close position, small rejection wick, size 0.7–2 ATR, a clean close beyond the level |
| Breakout confirmation | 15 | A completed close beyond, acceptance, a held retest, few false-breakout flags |
| VWAP / momentum | 10 | Right side of VWAP and not stretched, VWAP slope, EMA 9 / 20, one momentum measure (ADX / DI) |
| Relative strength / liquidity | 5 | Stock vs NIFTY and vs sector since the open, traded value, live spread |
| Risk-reward / volatility | 10 | Net R:R to the target after charges, room left in the typical daily range, stop distance |

**Stop and targets.** The stop is the retest low (model B), else the tighter of the breakout candle's low and the range midpoint, minus 0.1 ATR. It is never closer than 0.3 ATR. Each target is the nearest of three candidates:

- the range projection (entry ± 1 or 2 × the range width)
- the volatility cap (the day's extreme ± one typical daily range)
- structure (PDH / PDL / PDC / pivots)

So a resistance just overhead caps the trade. T3 appears only with a trending tape or a momentum entry. A "don't chase beyond" price is shown, and an entry past it fails the 1.5:1 rule.

**Mandatory conditions** (any one failing = NO TRADE):

- the range is complete; the data is complete and fresh
- the breakout is confirmed, not failed, not chased, with ≥ 0.8× the usual volume for that time
- a logical stop, net R:R ≥ 1.5, at least one share
- enough liquidity; live only: spread ≤ 0.25%, clear of circuit limits
- the entry window (until 12:00), and time left for the move; no scheduled event, sudden ≥ 3.5 ATR candle or ±3% gap
- ≤ 3 trades and < 1% loss today; the day's typical range not already used up

**History it uses:** opening-range percentiles and same-time-of-day volume need earlier sessions. Each session therefore receives the *opening profiles* of up to 60 earlier sessions (`ctx.ref.profile`): OR widths and volumes, plus volume and range by minute. These are summaries only, never candles. Below 10 sessions, OR ÷ daily ATR and the session's own average volume stand in, for fewer points.

**Live-only inputs:** bid / ask / depth / circuits, NIFTY 50 breadth and India VIX (SmartAPI quotes). There is no feed for overnight global markets or industry peers, so those are always listed as missing.

**Where to see it:** Today page → All strategies → click **Opening Range Breakout** (▸). It shows the dashboard from the spec:

- A: market overview
- B: opening range
- C: breakout analysis
- D: technical confirmation
- E: eight-factor scorecard with sub-scores
- F: final trading parameters, only when the decision allows numbers
- the 12-point explanation, or the exact failed conditions and what has to change
- for a breakout that already fired today, what the engine decided on that candle

API: `GET /api/lab/decision-report?strategy=orb&symbol=RELIANCE&interval=5m`.

**Research:**

```bash
npm run orb-research -- --symbols=NIFTY50 --interval=5m
npm run strategy-research -- --strategy=orb --orMinutes=30 --target=t1
```

This groups every confirmed breakout that passes the mandatory conditions by score band, entry model, OR width and breakout time, in-sample and out-of-sample.

On NIFTY 50, 5m, Nov 2025 – Oct 2026 (275 sessions):

- 1,816 breakouts, 19% wins, −0.35R average after costs
- every band, model, width and time window lost
- no setup scored 85 or more
- score vs result correlation 0.05 (not significant)
- variants also lost: T1 target −0.40R, no exit on a close back inside −0.32R, 30-minute range −0.35R

At the default 85 it doesn't trade in backtests. The weights are a starting point to research, not a proven edge.

## Time Machine

**Time Machine** tab (top bar, right of Lab). It opens on the symbol from the main screen, prefilled with ORB's long levels when there are any (otherwise the last price ± 0.5%), and re-runs 0.5 s after each edit. For a long plan (entry, stop, target, entry-bar close time, flat-by time) it replays the rest of the day 10,000 times from the stock's own 5-minute bars, and runs the ORB rule on the same past sessions. It reports target first / stop first / neither / green, the history, a verdict, and a price forecast at +30 min, +60 min and the flat-by time (stop and target left blank = forecast only). The engine is in `server/timemachine/` (pure, zero dependencies); the app calls it through `POST /api/lab/timemachine` on the live worker, using the last 60 cached 5m sessions before the plan date by default.

Principles:

1. **Odds, not predictions.** It asks how often this exact plan hits the target first, the stop first, or neither.
   The output is a distribution, never a forecast.
2. **The stock is its own model.** No normal distribution or volatility formula: it resamples the stock's real 5-minute bars.
   Fat tails and quirks come along for free.
3. **Time of day matters.** A bar is only replaced by a past bar from the same time of day, ± 2 slots by default.
   The open, the lunch lull and the 15:00 rush keep their own behaviour.
4. **Scale-free.** Past bars are stored as ratios to the previous close (slot 0: its own open).
   A bar from ₹700 days replays correctly at ₹740.
5. **Pessimistic when ambiguous.** A bar touching both stop and target is a stop.
   A gap through the stop is booked at −1R and counted separately, because a real fill is worse.
6. **No lookahead.** Only full sessions strictly before the plan date enter the pool.
   Today's bars never do, and sessions on or after the plan date change nothing.
7. **Two witnesses.** The simulation and the real history of the same rule are shown side by side.
   When they disagree, that disagreement is information.
8. **Judge against break-even, not 50%.** A 2R plan only needs to win 1 in 3.
   Break-even target share = 1 / (1 + R) of the replays that hit something.
9. **Reproducible.** Seeded mulberry32 PRNG, one stream per run.
   Same data, plan and seed give byte-identical output.
10. **Refuse rather than guess.** Too few sessions, a broken plan or an off-grid time is a refusal with a code.
    `INSUFFICIENT_SESSIONS`, `INVALID_PLAN`, `ENTRY_NOT_ON_GRID`, `ENTRY_AFTER_UNTIL`, `INVALID_OPTIONS`, `TODAY_REQUIRED`, `BAD_TODAY`.
11. **It informs, it never acts.** No orders, no position sizing, no rupee P&L.
    Rounding is display-only.
12. **Similar mornings, not all mornings.** Today's first hour picks which past days to learn from.
    It never becomes a formula.
13. **Only what was knowable.** Features read bars up to the decision moment only, and the pool is strictly earlier days.
    Walk-forward enforces this for every single day.
14. **A forecast is a distribution.** "54% up, 90% between ₹996 and ₹1,006", never "₹1,004".
    Every horizon has odds, percentiles and move buckets.
15. **Never too few witnesses.** If weights concentrate on fewer than `minEss` effective days, the bandwidth widens ×1.5.
    After 10 widenings it falls back to uniform weights. Two lucky days never decide.
16. **Prove it or drop it.** Analog days stay off unless they beat uniform in walk-forward.
    Choose on the train period, judge on the test period, never choose by the test period.

**Analog days (off by default; "Analog days" checkbox, `--analog`).** Each past session is described by its morning at the decision bar, standardized over the pool (population sd; a flat feature is dropped). A session's weight is `exp(−d² / 2h²)`, where d² is the weighted squared z-distance to today plus `eventWeight` (4) when its event tags differ. Weights only change which past bar a random number picks, never how many random numbers are drawn, so uniform weights reproduce the plain run exactly. `volScale` stretches each session's bars by today's rvol ÷ its rvol (kept within 0.5–2).

| Feature | Definition (bars 0..e−1 only) | Dropped when |
|---|---|---|
| `relVol` | volume so far ÷ the pool's mean volume so far | any session lacks volume, or the mean is 0 |
| `rvol` | √(mean of ln(close ÷ reference)²), reference = previous close (09:15 bar: its open) | never |
| `gap` | ln(open ÷ previous valid session's 15:25-bar close), 0 if none | never |
| `moveSoFar` | ln(last close ÷ 09:15 open) | never |
| `niftyMove` | Nifty 50's ln(last close ÷ 09:15 open), same date | no index, or a date is missing |

A new feature (open interest, delivery %) is one object `{ name, available, value }` in `server/timemachine/src/features/index.js`.

**Price forecast.** Every run also reports, at +30 min, +60 min and the flat-by time: the chance the price is up or down, the mean, the 5/25/50/75/95th percentiles, and the share of replays in six move buckets (below −1%, −1 to −0.5%, −0.5 to 0, 0 to +0.5%, +0.5 to +1%, +1% or more). Leave stop and target empty for forecast-only mode; the entry then defaults to the close of the last bar before the entry time.

Command line, on Kite candles (`["2026-10-19T09:15:00+0530", o, h, l, c, v]`) and a plan file. When `--analog` is on or the plan has no entry, today's morning is taken from `--data` (only the bars before the entry time):

```bash
cd server/timemachine
node cli.js --data data/RELIANCE.json --plan plan.json [--seed 19] [--replays 10000] [--window 2] [--json]
node cli.js --data data/RELIANCE.json --index data/NIFTY50.json --plan forecast.json --analog [--vol-scale] [--events events.json]
node --test        # the engine's own tests (also run by npm test)
```

`forecast.json` is a plan without stop and target, e.g. `{ "symbol": "RELIANCE", "date": "2026-10-13", "entryTime": "10:15" }`. `events.json` tags days, e.g. `{ "2026-10-13": ["expiry"], "2026-10-08": ["rbi"] }`.

**Walk-forward validation.** It forecasts each past day at the decision time from only the 20 sessions before it, scores P(up at the flat-by time) against what happened (Brier score, 90% band coverage, calibration), and compares uniform, analog and analog+vol. It picks the variant with the lowest train Brier. Analog is *accepted* only if that pick is not uniform and also beats uniform on the test period.

```bash
node cli.js walkforward --data data/RELIANCE.json [--index data/NIFTY50.json] [--events events.json] --train-end 2026-08-07 [--replays 2000] [--json]
```

Known limitations:

- Sampling single bars breaks momentum and volatility clustering, so odds drift toward a coin flip.
- 20 sessions is a thin sample.
- Gap stops are booked at −1R but fill worse in reality.
- Long only.
- A session counts only with all 75 bars (09:15–15:25). Sessions missing their last bars are skipped, and the refusal says how many.
- **Bands are too narrow on trending days.** On the planted-signal test (walk-forward fixture P), the 90% band holds the real close only 30–37% of the time, even with analog days. Sampling single bars mixes bars from different days and destroys within-day trend persistence, so bands come out too narrow and too centred. The goldens lock this behaviour on purpose; the next version's block bootstrap (runs of consecutive bars from one analog day) will be measured against it.
- Market depth, open interest, delivery %, FII/DII flows and news are not in free 5-minute candles, so they are not features.
- Walk-forward is command-line only.

## Tests

```bash
npm test
```

There are 278 Vitest tests:

- **Indicators:** each indicator against handcrafted values.
- **Patterns:** every pattern, positive and negative cases, each confirming only on its completing bar.
- **Sessions and time:** pre-open/post-close filtering, prior-day levels, special sessions, 3m aggregation, time buckets.
- **Engine and costs:** fills, stop-first, forced 15:15 exit, cutoff, limits, sizing, slippage, costs, metrics.
- **SmartAPI:** request chunking, the documented limits, the rate limiter.
- **Lookahead test:** every strategy and pattern must decide identically with the future bars removed, and the context throws if anything reads past bar i. It includes two deliberately cheating strategies to prove the guard catches them.
- **Session-leak test:** two histories have completely different previous-day candles but the same previous-day high/low/close. Every pattern, indicator, signal and trade on the next day must be identical.
- **VWAP σ-reversion and ORB engines:** setup states and entry models, failed / chased / wick-only breakouts, levels and sizing, missing data scoring 0, every mandatory condition, the decision, and the reports.

`npm test` then runs the Time Machine's 85 `node:test` tests (`server/timemachine/test/`): PRNG, time grid, session validation and lookahead, plan refusals, deterministic and seeded golden runs, ORB history, the verdict table, the Kite adapter, speed, and no `Math.random`. The add-on tests cover analog features and weights, the weighted pick, forecast mode, volatility scaling, walk-forward on noise (must reject analog) and on a planted signal (must accept it), and strict-past checks.

## How the server is built

- **Threads.** The main thread only answers HTTP. CPU work runs on persistent worker threads (`server/workers/`): the *jobs* pool (2 workers) runs backtests, pattern stats and the Top 3; the *live* worker runs each chart, plan, decision report and outlook request. A long job never delays a chart refresh, and workers keep their caches between tasks.
- **Top 3 cost.** The window backtest ends yesterday, so it runs once per day per request shape and stays cached on its worker (the same target always goes to the same worker). The 5-minute refreshes only redo today's context: NIFTY 50 on 5m takes ~25 s the first time and ~2 s after that.
- **Jobs.** At most 2 compute at once; the rest wait their turn. A job nobody has polled for 90 s stops at its next progress report.
- **Caches.** Every in-memory cache is an `lru` (`server/lru.js`) with an explicit bound; the big ones (indicators, index sessions) are bounded by how much data they hold, not by entry count.
- **Database.** `server/db.js` owns the whole schema. A change is a new migration at the end of its list (`PRAGMA user_version` counts the ones a database has run). One `candles` table holds every candle (lab intraday and the chart's Yahoo 1d / 1h), tagged by source.
- **Errors and inputs.** One error type (`server/errors.js`, `AppError` with an HTTP status). Routes check symbols, intervals and dates (`routes/validate.js`) and answer 400 instead of computing on bad input.
- **Client.** Market hours and holidays come from `/api/lab/meta`. Each panel sits in an error boundary, so one failing panel shows its error and a Retry button instead of blanking the page.

## Project layout

```
server/
  index.js                 Express API (localhost only)
  env.js                   loads server/.env
  db.js                    SQLite (server/cache.db): the whole schema + migrations
  errors.js                AppError / ProviderError (one error type with an HTTP status)
  lru.js                   the bounded cache every in-memory cache uses
  priority.js              interactive vs bulk SmartAPI requests
  config/                  market.js · smartapi.js · costs.js · patterns.js · lab.js · vwapReversion.js · orb.js · events.js
  data/
    provider.js            provider registry (same interface for every provider)
    providers/yahoo.js     Yahoo (daily chart + lab fallback)
    providers/smartapi/    auth (TOTP login/refresh) · client (rate-limited queue) · instruments · quote · index
    quotes.js              live quote (bid/ask/depth/circuits) + NIFTY 50 breadth, for the VWAP report
    intraday.js            the candle store (lab + chart): chunked, resumable sync per source
    candles.js             chart API (Phase 1 + intraday chart with overlays/markers)
    nse.js                 NSE downloads (User-Agent, CSV)
    holidays.js            NSE holidays (+ Muhurat detection)
    universes.js           NIFTY 50 / NIFTY 100 (from NSE) + watchlist
    symbols.js             NSE equity list (Phase 1)
  lab/                     time · sessions · indicators · sessionData (cache + guarded context) · context · overlays
  patterns/                one file per detector in detectors/ · zigzag · stats
  strategies/              19 strategies + common params
  decision/                shared by the decision engines: util · sizing · candle · atr · live (reports)
  vwapReversion/           VWAP σ engine: setup · factors/ · levels · report
  orbEngine/               ORB engine: setup (models A/B/C) · factors/ · levels · report
  market/                  indexLink · relation · marketContext (index bars lined up) · marketData (loader)
  backtest/                engine · costs · metrics · run (walk-forward) · account · jobs
  workers/                 pool (jobs + live worker threads) · worker (thread entry) · tasks (what they run)
  ranking/today.js         Top 3 + scoreboard (window backtest cached for the day)
  timemachine/             Time Machine engine (pure, zero deps): src/ · cli.js · test/ (node:test)
  prediction/              bullish / bearish outlook: models/ · features · evaluate · runDaily · runIntraday
  routes/                  lab.js (/api/lab/*) · predict.js · market.js · validate.js (input checks)
  scripts/                 backfill.js · fetch-all.js · strategyResearch.js
  tests/                   Vitest
client/src/
  pages/TodayPage.jsx      Top 3 · chart · scoreboard
  pages/LabPage.jsx        lab form, results, day picker
  pages/TimeMachinePage.jsx  Time Machine tab: plan form, odds, history
  components/              Chart · Top3Panel · Scoreboard (+ StrategyDetail dropdown) · OrbReport · VwapReport · decision/parts · ErrorBoundary · …
```

### Adding a strategy or pattern

- **Strategy:** add a file in `server/strategies/` using `defineStrategy({ id, name, params, spec, warmup, onBar })` and register it in `strategies/index.js`. `onBar(ctx)` sees only `ctx.bar(k ≤ i)`, `ctx.ind(name, args, ago)`, `ctx.openingRange(min)`, `ctx.ref` (PDH/PDL/PDC/gap, `daily`, `atrDaily`) and `ctx.pivots`. Don't keep state between bars (`ctx.state`): recompute from bars 0..i so the truncation test can check it. A series whose value at bar k uses only bars ≤ k can be built once per session with `ctx.sd.memo(key, fn)` (see `decision/atr.js`) instead of on every bar. Everything else about the strategy goes in the same file: `levels` (today's levels its Top 3 card draws, keys from `LEVEL_LABELS` in `ranking/today.js`), an optional `plan(ctx)`, and for a decision engine `decision: { evaluate, configFor, build, vix, report }`, where `report` names the client view (`orb` or `vwap`). No other file needs editing. The lookahead and session-leak tests cover new strategies automatically. A strategy that reads the market sets `needsMarket: true` and uses `ctx.market("nifty" | "sector", ago)`. A strategy too strict to fire on random test data can set `testParams`, which the guard tests apply on top of its defaults.
- **Pattern:** add `detectors/<name>.js` exporting `id`, `names` and `detect(sessionCandles, i)`, put its thresholds in `config/patterns.js`, and register it in `patterns/index.js`.

## Phase 1 commands (still available)

- `npm run fetch-all` caches daily history for every NSE symbol (Yahoo). It's resumable.
- 1D / 1W / 1M / 1H on the chart come from Yahoo and are split/bonus adjusted.

## Resetting

Stop the server and delete `server/cache.db` (plus `-wal` / `-shm`). That clears every candle, the symbol lists and the cached SmartAPI session.

# NSE Chart Viewer + Intraday Lab

A local, research-only trading lab for NSE cash intraday. It runs entirely on your own machine and never places orders or paper trades — it exists to test whether a setup has a real edge *before* you risk anything.

Two parts:

- **Chart viewer** — full daily history with 1D / 1W / 1M / 1H views, symbol search, and a SQLite cache.
- **Intraday lab** — 1m / 3m / 5m / 15m candles, indicator overlays, 17 pattern detectors with same-session stats, 19 intraday strategies, a bar-by-bar backtester that charges real NSE costs, walk-forward validation, a **Today's Top 3** ranker, and an all-strategies scoreboard.

Everything is bound to a single 09:15–15:30 IST session: indicators restart at the open, trades open and close the same day, and nothing reads the future (an automated lookahead test enforces this). Two decision engines (Opening Range Breakout and VWAP σ-Band Reversion) score each setup across market regime, volume, price action, liquidity and risk-reward, and only then give a LONG / SHORT / WATCHLIST / NO-TRADE call. A Time Machine replays any plan 10,000 times against the stock's own history to show the odds, not a prediction.

<!-- ![Main screen — Today's Top 3, chart, scoreboard](docs/images/main.png) -->
<!-- ![Lab page — backtest results and equity curve](docs/images/lab.png) -->
<!-- ![Time Machine — outcome distribution](docs/images/timemachine.png) -->

## Screenshots

> _Add images here._<img width="1917" height="915" alt="image" src="https://github.com/user-attachments/assets/6759d3bc-285a-4d6b-9b25-0b2e350c12d5" />


|  |  |
|--|--|
| <!-- ![Today page](docs/images/today.png) --> | <!-- ![Decision report](docs/images/decision.png) --> |
| <!-- ![Backtest](docs/images/backtest.png) --> | <!-- ![Chart overlays](docs/images/chart.png) --> |

## Future scalability opportunities

- **More data sources.** The provider registry gives every data source one interface, so adding another broker/history feed (Kite, Dhan, Fyers) is a new file under `data/providers/`, not a rewrite.
- **Beyond NSE cash.** The session model is NSE-specific but isolated in config (`config/market.js`); F&O, commodities, or other exchanges could be added as their own session definitions.
- **Short side & multi-leg.** The Time Machine and some engines are long-only today; symmetric short handling and spread/hedged plans are a natural extension.
- **Live execution layer.** The engines already emit full trade plans (entry, stop, target, size). A broker order adapter could turn research plans into real orders behind an explicit opt-in.
- **Horizontal compute.** Backtests already run on worker threads with a shared rate budget; the same jobs could fan out to multiple processes or machines for whole-universe sweeps.
- **Richer features.** Tick data, market depth, open interest, delivery %, FII/DII flows and a news feed are stubbed as "missing" inputs — wiring real feeds would let the scorers and the Time Machine use them.
- **Block-bootstrap Time Machine.** The current resampler draws single bars, which flattens within-day trend; a consecutive-bar bootstrap would widen bands on trending days.
- **Walk-forward parameter search.** Validation today is a fixed in/out-of-sample split; adding rolling re-optimisation would let strategies adapt without overfitting.

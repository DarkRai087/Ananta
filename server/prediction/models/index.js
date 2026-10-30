// Model registry. To add a model: write one file in daily/ or intraday/ and list it here.
//
// Daily model:     { id, name, kind: "daily", description, params, lookback(params),
//                    predict(bars, params, ctx) → { score, reasons } | null }
//   bars = daily OHLCV, oldest first, ending at the bar the call is made on (at most
//   lookback(params) bars). Nothing after it is ever passed in.
//   needsIndex: true → ctx.index = { name, bars }: the share's index's daily bars up to the
//   same day (indexLookback(params) of them).
//
// Intraday model:  { id, name, kind: "intraday", description, params,
//                    predict(view, params) → { score, reasons } | null }
//   view = { bars, prev, daily, intervalMin, index }: today's COMPLETED bars up to the call
//   time, the previous session's { high, low, close }, earlier daily bars (oldest first, never
//   today), and index = { name, bars, prev }: the share's index cut at the same time.
//
// score is in [-1, +1]: +1 = strongly bullish, −1 = strongly bearish. Return null when the
// model has nothing to say (not enough data). Params can be overridden in config/prediction.js.
import trend from "./daily/trend.js";
import momentum from "./daily/momentum.js";
import breakout from "./daily/breakout.js";
import meanReversion from "./daily/meanReversion.js";
import indexTrendDaily from "./daily/indexTrend.js";
import vwapTrend from "./intraday/vwapTrend.js";
import dayMomentum from "./intraday/dayMomentum.js";
import openingRange from "./intraday/openingRange.js";
import indexTrendIntraday from "./intraday/indexTrend.js";

export const DAILY_MODELS = [trend, momentum, breakout, meanReversion, indexTrendDaily];
export const INTRADAY_MODELS = [vwapTrend, dayMomentum, openingRange, indexTrendIntraday];

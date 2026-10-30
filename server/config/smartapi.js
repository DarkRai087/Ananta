import { INDICES } from "./indices.js";
// Angel One SmartAPI settings. Limits are from the official docs:
//   https://smartapi.angelbroking.com/docs/Historical  ("Max Days in one Request")
//   https://smartapi.angelbroking.com/docs/RateLimit   (getCandleData: 2/s, 80/min, 5000/h)
// Login session stays valid until midnight IST (docs: "Authentication with Angel").
export const SMARTAPI = {
  baseUrl: "https://apiconnect.angelone.in",
  endpoints: {
    login: "/rest/auth/angelbroking/user/v1/loginByPassword",
    refresh: "/rest/auth/angelbroking/jwt/v1/generateTokens",
    profile: "/rest/secure/angelbroking/user/v1/getProfile",
    candles: "/rest/secure/angelbroking/historical/v1/getCandleData",
    quote: "/rest/secure/angelbroking/market/v1/quote/", // live LTP / OHLC / FULL (depth, circuits), up to 50 tokens
  },
  instrumentMasterUrl: "https://margincalculator.angelone.in/OpenAPI_File/files/OpenAPIScripMaster.json",

  // Lab intervals → SmartAPI interval code and max calendar days per request.
  intervals: {
    "1m": { code: "ONE_MINUTE", maxDaysPerRequest: 30 },
    "3m": { code: "THREE_MINUTE", maxDaysPerRequest: 60 },
    "5m": { code: "FIVE_MINUTE", maxDaysPerRequest: 100 },
    "15m": { code: "FIFTEEN_MINUTE", maxDaysPerRequest: 200 },
  },

  // Per client code. The queue stays under all three windows.
  rateLimits: {
    candles: { perSecond: 2, perMinute: 80, perHour: 5000 },
    login: { perSecond: 1 },
    refresh: { perSecond: 1, perHour: 1000 },
    quote: { perSecond: 1, perMinute: 50 }, // well under the documented market-data limit; used by the VWAP decision report
  },

  // Our margin on top of the documented limits. Network delay varies, so two requests sent a
  // second apart can reach Angel closer together and get "exceeding access rate".
  // bulkReserve: candle requests per minute that bulk work (job syncs, backfill) leaves free
  // for interactive ones (chart, plans, reports), whichever process they come from.
  candleSafety: { minGapMs: 600, spareMinute: 5, bulkReserve: 15 },

  // Retries on "exceeding access rate" (HTTP 403) / network errors: 2s, 4s, 8s, 16s, 32s.
  backoff: { retries: 5, baseMs: 2000 },
  requestTimeoutMs: 30_000,

  // Index tokens (exchange NSE), from config/indices.js. Equities are looked up in the instrument master.
  indexTokens: Object.fromEntries(Object.entries(INDICES).map(([k, v]) => [k, v.smartapi])),

  // Required headers. Data APIs don't validate these; placeholders are fine.
  clientHeaders: {
    "X-UserType": "USER",
    "X-SourceID": "WEB",
    "X-ClientLocalIP": "127.0.0.1",
    "X-ClientPublicIP": "127.0.0.1",
    "X-MACAddress": "00:00:00:00:00:00",
  },
};

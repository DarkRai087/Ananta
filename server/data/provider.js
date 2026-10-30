// ─────────────────────────────────────────────────────────────────────────────
// Market-data providers. Every provider module has the same interface:
//
//   id, name                   e.g. "smartapi", "Angel One SmartAPI"
//   INTERVALS                  { [interval]: { maxDays: number|null } }  (history depth)
//   LAB_INTERVALS              intraday intervals it can serve to the lab
//   isConfigured()             credentials present?
//   fetchCandles(symbol, interval, { from, to, onChunk, reverse })
//       → [{ time, open, high, low, close, volume }] sorted, time = unix seconds (UTC)
//         (daily: 00:00 UTC of the IST date). Prices split/bonus adjusted.
//   errors: ProviderError with code NOT_FOUND | RATE_LIMIT | NETWORK | AUTH | NOT_CONFIGURED | UNKNOWN
//
// The daily/weekly/monthly chart uses Yahoo. The intraday lab uses SmartAPI when credentials
// are in server/.env, otherwise Yahoo (with Yahoo's short intraday history). Force one with
// LAB_PROVIDER=smartapi|yahoo in .env.
// ─────────────────────────────────────────────────────────────────────────────
import db from "../db.js";
import * as yahoo from "./providers/yahoo.js";
import * as smartapi from "./providers/smartapi/index.js";

export { ProviderError } from "./providers/errors.js";

export const PROVIDERS = { yahoo, smartapi };

export const chartProvider = yahoo;

// Without SmartAPI keys, a database that already holds SmartAPI candles keeps reading them:
// Yahoo rows are stored apart, so switching would hide all that history.
let hasSmartapiRows = null;
export function labProvider() {
  const want = (process.env.LAB_PROVIDER || "").toLowerCase();
  if (PROVIDERS[want]) return PROVIDERS[want];
  if (smartapi.isConfigured()) return smartapi;
  hasSmartapiRows ??= Boolean(db.prepare("SELECT 1 FROM lab_candles WHERE source = 'smartapi' LIMIT 1").get());
  return hasSmartapiRows ? smartapi : yahoo;
}

// Phase 1 interface (daily chart), unchanged.
export const name = yahoo.name;
export const INTERVALS = yahoo.INTERVALS;
export const fetchCandles = yahoo.fetchCandles;

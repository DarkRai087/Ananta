// SmartAPI instrument master (symbol → token). Downloaded once per IST day, NSE cash only.
import db, { getMeta, setMeta } from "../../../db.js";
import { SMARTAPI } from "../../../config/smartapi.js";
import { ProviderError, isNetworkError } from "../../../errors.js";
import { istNow } from "../../../lab/time.js";

const META_KEY = "smartapi_instruments_date";
let refreshing = null;

async function download() {
  let res;
  try {
    res = await fetch(SMARTAPI.instrumentMasterUrl, { signal: AbortSignal.timeout(180_000) });
  } catch (err) {
    throw new ProviderError(isNetworkError(err) ? "NETWORK" : "UNKNOWN", `Instrument master download failed: ${err.message}`);
  }
  if (!res.ok) throw new ProviderError("UNKNOWN", `Instrument master HTTP ${res.status}`);
  const all = await res.json();

  // Prefer the EQ series; fall back to BE (trade-for-trade) when a stock has no EQ line.
  const pick = new Map();
  for (const r of all) {
    if (r.exch_seg !== "NSE") continue;
    const m = /^(.+)-(EQ|BE)$/.exec(r.symbol || "");
    if (!m) continue;
    const [, sym, series] = m;
    if (series === "BE" && pick.has(sym)) continue;
    pick.set(sym, { symbol: sym, token: String(r.token), trading_symbol: r.symbol, name: r.name, tick_size: Number(r.tick_size) / 100 || null });
  }
  return [...pick.values()];
}

export async function ensureInstruments({ force = false } = {}) {
  const count = db.prepare("SELECT COUNT(*) AS n FROM smartapi_instruments").get().n;
  if (!force && count > 0 && getMeta(META_KEY) === istNow().date) return count;
  if (!refreshing) {
    refreshing = (async () => {
      try {
        const rows = await download();
        const ins = db.prepare(
          "INSERT INTO smartapi_instruments (symbol, token, trading_symbol, name, tick_size) VALUES (@symbol, @token, @trading_symbol, @name, @tick_size)"
        );
        db.transaction(() => {
          db.prepare("DELETE FROM smartapi_instruments").run();
          for (const r of rows) ins.run(r);
        })();
        setMeta(META_KEY, istNow().date);
        console.log(`[smartapi] instrument master: ${rows.length} NSE equities`);
        return rows.length;
      } catch (err) {
        if (count > 0) {
          console.warn(`[smartapi] instrument refresh failed (${err.message}); using cached list`);
          return count;
        }
        throw err;
      } finally {
        refreshing = null;
      }
    })();
  }
  return refreshing;
}

export async function getToken(symbol) {
  if (SMARTAPI.indexTokens[symbol]) return SMARTAPI.indexTokens[symbol];
  await ensureInstruments();
  const row = db.prepare("SELECT token FROM smartapi_instruments WHERE symbol = ?").get(symbol);
  if (!row) throw new ProviderError("NOT_FOUND", `"${symbol}" is not in Angel One's NSE instrument list`);
  return row.token;
}

// Tick size in ₹ from the instrument master (null if unknown or not downloaded yet).
export function tickSize(symbol) {
  const row = db.prepare("SELECT tick_size FROM smartapi_instruments WHERE symbol = ?").get(String(symbol || "").toUpperCase());
  return row?.tick_size > 0 ? row.tick_size : null;
}

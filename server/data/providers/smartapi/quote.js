// SmartAPI live market data (read-only): LTP / OHLC / FULL quotes for up to 50 NSE tokens a call.
// FULL adds best-5 depth, total bid / ask quantity and the circuit limits.
import { SMARTAPI } from "../../../config/smartapi.js";
import { apiPost } from "./client.js";
import { getJwt, renewJwt, credentials } from "./auth.js";

/** tokens: string[] (NSE). Returns the `fetched` rows (unknown tokens are skipped). */
export async function fetchQuotes(tokens, mode = "FULL") {
  const out = [];
  for (let k = 0; k < tokens.length; k += 50) {
    const body = { mode, exchangeTokens: { NSE: tokens.slice(k, k + 50) } };
    let json;
    try {
      json = await apiPost(SMARTAPI.endpoints.quote, body, { apiKey: credentials().apiKey, token: await getJwt(), limiter: "quote" });
    } catch (err) {
      if (err.code !== "AUTH" || !err.tokenError) throw err;
      await renewJwt();
      json = await apiPost(SMARTAPI.endpoints.quote, body, { apiKey: credentials().apiKey, token: await getJwt(), limiter: "quote" });
    }
    out.push(...(json.data?.fetched || []));
  }
  return out;
}

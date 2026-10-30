// Raw SmartAPI HTTP calls behind a rate-limited queue.
import { SMARTAPI } from "../../../config/smartapi.js";
import { ProviderError, sleep, isNetworkError } from "../errors.js";

// Sliding-window limiter: requests run one at a time, never exceed any window, and start at
// least minGapMs apart.
export class RateLimiter {
  constructor({ perSecond = Infinity, perMinute = Infinity, perHour = Infinity, minGapMs = 0 }, now = () => Date.now()) {
    this.minGapMs = minGapMs;
    this.windows = [
      [1000, perSecond],
      [60_000, perMinute],
      [3_600_000, perHour],
    ].filter(([, limit]) => Number.isFinite(limit));
    this.stamps = [];
    this.chain = Promise.resolve();
    this.now = now;
  }

  // How long to wait before another request is allowed (0 = now).
  waitMs() {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 3_600_000);
    const last = this.stamps[this.stamps.length - 1];
    let wait = last != null && this.minGapMs ? Math.max(0, last + this.minGapMs - t) : 0;
    for (const [span, limit] of this.windows) {
      const inWindow = this.stamps.filter((s) => t - s < span);
      if (inWindow.length >= limit) wait = Math.max(wait, inWindow[inWindow.length - limit] + span - t + 5);
    }
    return wait;
  }

  acquire() {
    const run = this.chain.then(async () => {
      for (let w = this.waitMs(); w > 0; w = this.waitMs()) await sleep(w);
      this.stamps.push(this.now());
    });
    this.chain = run.catch(() => {});
    return run;
  }
}

const { minGapMs, spareMinute } = SMARTAPI.candleSafety;
const limiters = {
  candles: new RateLimiter({ ...SMARTAPI.rateLimits.candles, perMinute: SMARTAPI.rateLimits.candles.perMinute - spareMinute, minGapMs }),
  login: new RateLimiter(SMARTAPI.rateLimits.login),
  refresh: new RateLimiter(SMARTAPI.rateLimits.refresh),
  quote: new RateLimiter(SMARTAPI.rateLimits.quote),
};

// From the SmartAPI error-code table. Token errors are fixed by refresh/re-login.
const TOKEN_ERRORS = new Set(["AG8001", "AG8002", "AG8003", "AB1010", "AB1011", "AB8050", "AB8051"]);
const AUTH_ERRORS = new Set([...TOKEN_ERRORS, "AB1000", "AB1001", "AB1002", "AB1005", "AB1006"]);

/**
 * POST to SmartAPI. Throws ProviderError:
 *   RATE_LIMIT (403 "exceeding access rate"), AUTH (token/login problems, .tokenError=true for
 *   expired/invalid JWT), NETWORK, UNKNOWN. Returns the parsed JSON body ({ status, data, … }).
 */
export async function apiPost(path, body, { apiKey, token = null, limiter = "candles" } = {}) {
  await limiters[limiter].acquire();
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-PrivateKey": apiKey,
    ...SMARTAPI.clientHeaders,
  };
  if (token) headers.Authorization = `Bearer ${String(token).replace(/^Bearer\s+/i, "")}`;

  let res;
  try {
    res = await fetch(SMARTAPI.baseUrl + path, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(SMARTAPI.requestTimeoutMs),
    });
  } catch (err) {
    if (isNetworkError(err)) throw new ProviderError("NETWORK", "Cannot reach Angel One SmartAPI (no internet?)");
    throw new ProviderError("UNKNOWN", err.message);
  }

  const text = await res.text();
  if (/exceeding access rate|exceeding rate limit/i.test(text) || res.status === 429) {
    throw new ProviderError("RATE_LIMIT", "SmartAPI rate limit hit");
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new ProviderError(res.status === 401 || res.status === 403 ? "AUTH" : "UNKNOWN", `SmartAPI HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  if (json.status === false || json.success === false) {
    const code = json.errorcode || json.errorCode || "";
    const msg = json.message || "SmartAPI error";
    const isAuth = AUTH_ERRORS.has(code) || /invalid totp|token/i.test(msg);
    const err = new ProviderError(isAuth ? "AUTH" : "UNKNOWN", `${msg}${code ? ` (${code})` : ""}`);
    err.errorcode = code;
    err.tokenError = TOKEN_ERRORS.has(code) || /token/i.test(msg);
    throw err;
  }
  if (!res.ok) throw new ProviderError(res.status === 401 ? "AUTH" : "UNKNOWN", `SmartAPI HTTP ${res.status}`);
  return json;
}

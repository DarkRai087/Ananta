// Raw SmartAPI HTTP calls behind a rate-limited queue.
import db from "../../../db.js";
import { SMARTAPI } from "../../../config/smartapi.js";
import { ProviderError, sleep, isNetworkError } from "../../../errors.js";
import { isBulk } from "../../../priority.js";

const q = {
  load: db.prepare("SELECT t FROM rate_stamps WHERE name = ? AND t > ? ORDER BY t"),
  add: db.prepare("INSERT INTO rate_stamps (name, t) VALUES (?, ?)"),
  trim: db.prepare("DELETE FROM rate_stamps WHERE name = ? AND t <= ?"),
};

// Sliding-window limiter: requests start one at a time, never exceed any window, and at
// least minGapMs apart. Interactive requests go first; bulk ones (priority.js) wait for a free
// slot and leave `bulkReserve` of each minute for interactive ones. With a `shared` name the
// request times live in SQLite, so the server, backfill and workers share one budget (Angel
// counts per account, not per process).
export class RateLimiter {
  constructor({ perSecond = Infinity, perMinute = Infinity, perHour = Infinity, minGapMs = 0, bulkReserve = 0 }, now = () => Date.now(), shared = null) {
    this.minGapMs = minGapMs;
    this.bulkReserve = bulkReserve;
    this.windows = [
      [1000, perSecond],
      [60_000, perMinute],
      [3_600_000, perHour],
    ].filter(([, limit]) => Number.isFinite(limit));
    this.span = Math.max(1000, ...this.windows.map(([span]) => span)); // oldest request that still matters
    this.stamps = [];
    this.queues = { high: [], low: [] };
    this.pumping = false;
    this.now = now;
    this.shared = shared;
  }

  // 0 after recording a request now, else how long to wait. Shared: one write transaction, so
  // two processes can't both take the last free slot.
  take(low = false) {
    if (!this.shared) {
      const w = this.waitMs(low);
      if (!w) this.stamps.push(this.now());
      return w;
    }
    return db
      .transaction(() => {
        const old = this.now() - this.span;
        q.trim.run(this.shared, old);
        this.stamps = q.load.all(this.shared, old).map((r) => r.t);
        const w = this.waitMs(low);
        if (!w) q.add.run(this.shared, this.now());
        return w;
      })
      .immediate();
  }

  // How long to wait before another request is allowed (0 = now). low: a bulk request.
  waitMs(low = false) {
    const t = this.now();
    this.stamps = this.stamps.filter((s) => t - s < 3_600_000);
    const last = this.stamps[this.stamps.length - 1];
    let wait = last != null && this.minGapMs ? Math.max(0, last + this.minGapMs - t) : 0;
    for (const [span, limit] of this.windows) {
      const lim = low && span === 60_000 ? Math.max(1, limit - this.bulkReserve) : limit;
      const inWindow = this.stamps.filter((s) => t - s < span);
      if (inWindow.length >= lim) wait = Math.max(wait, inWindow[inWindow.length - lim] + span - t + 5);
    }
    return wait;
  }

  acquire(low = isBulk()) {
    return new Promise((resolve) => {
      this.queues[low ? "low" : "high"].push(resolve);
      this.pump();
    });
  }

  // Hands out slots: the high queue first. A bulk wait is cut into 250 ms steps, so an
  // interactive request that arrives meanwhile isn't stuck behind it.
  async pump() {
    if (this.pumping) return;
    this.pumping = true;
    const { high, low } = this.queues;
    while (high.length || low.length) {
      const bulk = !high.length;
      let w;
      try {
        w = this.take(bulk);
      } catch {
        w = 250; // database busy: try again shortly
      }
      if (w > 0) await sleep(bulk ? Math.min(w, 250) : w);
      else (bulk ? low : high).shift()();
    }
    this.pumping = false;
  }
}

const { minGapMs, spareMinute, bulkReserve } = SMARTAPI.candleSafety;
const limiters = {
  candles: new RateLimiter({ ...SMARTAPI.rateLimits.candles, perMinute: SMARTAPI.rateLimits.candles.perMinute - spareMinute, minGapMs, bulkReserve }, undefined, "candles"),
  login: new RateLimiter(SMARTAPI.rateLimits.login, undefined, "login"),
  refresh: new RateLimiter(SMARTAPI.rateLimits.refresh, undefined, "refresh"),
  quote: new RateLimiter(SMARTAPI.rateLimits.quote, undefined, "quote"),
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

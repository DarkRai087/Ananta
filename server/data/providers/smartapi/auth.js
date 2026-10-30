// SmartAPI login: TOTP generated with otplib, session cached in SQLite (shared by the
// server, the backfill script and workers). Sessions are valid until midnight IST, so a new
// IST day triggers a fresh login; an expired/invalid token triggers refresh, then re-login.
import { generate, createGuardrails } from "otplib";
import db, { getMeta, setMeta } from "../../../db.js";
import { SMARTAPI } from "../../../config/smartapi.js";
import { ProviderError, sleep } from "../errors.js";
import { apiPost } from "./client.js";
import { istNow } from "../../../lab/time.js";

export function credentials() {
  return {
    apiKey: process.env.SMARTAPI_API_KEY || "",
    clientCode: process.env.SMARTAPI_CLIENT_CODE || "",
    pin: process.env.SMARTAPI_PIN || "",
    totpSecret: (process.env.SMARTAPI_TOTP_SECRET || "").replace(/\s+/g, "").toUpperCase(),
  };
}

export function isConfigured() {
  const c = credentials();
  return Boolean(c.apiKey && c.clientCode && c.pin && c.totpSecret);
}

const META_KEY = "smartapi_session";
let session = null;
let loginPromise = null;

function loadSession() {
  if (session) return session;
  try {
    session = JSON.parse(getMeta(META_KEY) || "null");
  } catch {
    session = null;
  }
  return session;
}

function saveSession(data) {
  session = {
    jwt: data.jwtToken,
    refreshToken: data.refreshToken,
    feedToken: data.feedToken,
    date: istNow().date,
    clientCode: credentials().clientCode,
  };
  setMeta(META_KEY, JSON.stringify(session));
  return session;
}

export function clearSession() {
  session = null;
  db.prepare("DELETE FROM meta WHERE key = ?").run(META_KEY);
}

async function totp() {
  return generate({ secret: credentials().totpSecret, guardrails: createGuardrails({ MIN_SECRET_BYTES: 1 }) });
}

async function login() {
  const c = credentials();
  if (!isConfigured()) throw new ProviderError("NOT_CONFIGURED", "SmartAPI credentials missing in server/.env");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const json = await apiPost(
        SMARTAPI.endpoints.login,
        { clientcode: c.clientCode, password: c.pin, totp: await totp() },
        { apiKey: c.apiKey, limiter: "login" }
      );
      console.log("[smartapi] logged in");
      return saveSession(json.data);
    } catch (err) {
      // A TOTP generated at the end of a 30s window can expire in flight: retry once in the next window.
      if (attempt === 0 && /totp/i.test(err.message)) {
        await sleep(31_000 - (Date.now() % 30_000));
        continue;
      }
      if (err.code === "AUTH") throw new ProviderError("AUTH", `SmartAPI login failed: ${err.message}`);
      throw err;
    }
  }
}

async function refresh() {
  const s = loadSession();
  if (!s?.refreshToken) return login();
  try {
    const json = await apiPost(
      SMARTAPI.endpoints.refresh,
      { refreshToken: s.refreshToken },
      { apiKey: credentials().apiKey, token: s.jwt, limiter: "refresh" }
    );
    console.log("[smartapi] session refreshed");
    return saveSession({ ...json.data, feedToken: json.data.feedToken ?? s.feedToken });
  } catch (err) {
    if (err.code === "NETWORK" || err.code === "RATE_LIMIT") throw err;
    return login();
  }
}

function single(fn) {
  if (!loginPromise) loginPromise = fn().finally(() => (loginPromise = null));
  return loginPromise;
}

// A valid JWT for today, logging in if needed.
export async function getJwt() {
  const s = loadSession();
  if (s?.jwt && s.date === istNow().date && s.clientCode === credentials().clientCode) return s.jwt;
  return (await single(login)).jwt;
}

// Called when an API call reports an invalid/expired token.
export async function renewJwt() {
  return (await single(refresh)).jwt;
}

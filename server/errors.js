// The one error type the API answers with: status (HTTP) + code + message. Providers throw
// ProviderError, whose status follows from its code.
// code: NOT_FOUND | RATE_LIMIT | NETWORK | AUTH | NOT_CONFIGURED | BAD_REQUEST | … | UNKNOWN
export class AppError extends Error {
  constructor(status, code, message) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
  }
}

const PROVIDER_STATUS = { NOT_FOUND: 404, RATE_LIMIT: 429, NETWORK: 503, AUTH: 401, NOT_CONFIGURED: 401 };

export class ProviderError extends AppError {
  constructor(code, message) {
    super(PROVIDER_STATUS[code] ?? 502, code, message);
    this.name = "ProviderError";
  }
}

// A job stopped because nobody was polling it any more (backtest/jobs.js).
export class StoppedError extends AppError {
  constructor() {
    super(410, "STOPPED", "Stopped: nobody was waiting for this job");
  }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function isNetworkError(err) {
  const msg = String(err?.message || err);
  const causeCode = err?.cause?.code;
  return (
    /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket|aborted|timeout/i.test(msg) ||
    ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT"].includes(causeCode)
  );
}

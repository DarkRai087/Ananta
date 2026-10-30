// Shared error type for every market-data provider.
// code: 'NOT_FOUND' | 'RATE_LIMIT' | 'NETWORK' | 'AUTH' | 'NOT_CONFIGURED' | 'UNKNOWN'
export class ProviderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
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

// All calls to the local server. The frontend never talks to Yahoo / SmartAPI directly.

async function request(url, { signal, method = "GET", body } = {}) {
  let res;
  try {
    res = await fetch(url, {
      signal,
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if (err.name === "AbortError") throw err;
    throw new Error("Can't reach the local server. Is it running? (npm run dev)");
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON response */
  }
  if (!res.ok) {
    const err = new Error(json?.error || `Server error (${res.status})`);
    err.code = json?.code;
    throw err;
  }
  return json;
}

const qs = (o) =>
  Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => `${k}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : v)}`)
    .join("&");

export const searchSymbols = (q, signal) => request(`/api/symbols?q=${encodeURIComponent(q)}`, { signal });

export const fetchCandles = (symbol, interval, opts = {}, signal) =>
  request(`/api/candles/${encodeURIComponent(symbol)}?${qs({ interval, ...opts })}`, { signal });

export const labMeta = () => request("/api/lab/meta");
export const getWatchlist = () => request("/api/lab/watchlist");
export const saveWatchlist = (symbols) => request("/api/lab/watchlist", { method: "PUT", body: { symbols } });
export const testSmartApi = () => request("/api/lab/smartapi/test", { method: "POST" });

export const labSessions = (symbol, interval, from, to, signal) => request(`/api/lab/sessions?${qs({ symbol, interval, from, to })}`, { signal });
export const labSession = (symbol, interval, date, opts = {}, signal) =>
  request(`/api/lab/session?${qs({ symbol, interval, date, ...opts })}`, { signal });

export const startJob = (body) => request("/api/lab/jobs", { method: "POST", body });
export const getJob = (id, signal) => request(`/api/lab/jobs/${id}`, { signal });
export const startToday = (body) => request("/api/lab/today", { method: "POST", body });
export const fetchPlans = (symbol, interval, account, signal) => request(`/api/lab/plans?${qs({ symbol, interval, ...(account || {}) })}`, { signal });
export const fetchDecisionReport = (strategy, symbol, interval, account, signal) => request(`/api/lab/decision-report?${qs({ strategy, symbol, interval, ...(account || {}) })}`, { signal });
export const runTimeMachine = (body, signal) => request("/api/lab/timemachine", { method: "POST", body, signal });
export const fetchIndexLink =(symbol, interval, signal) => request(`/api/market/index-link/${encodeURIComponent(symbol)}?${qs({ interval })}`, { signal });
export const fetchPrediction = (symbol, interval, signal) => request(`/api/predict/${encodeURIComponent(symbol)}?${qs({ interval })}`, { signal });

// Polls a job until it finishes. onProgress(job) on every poll. Resolves with the job.
export async function waitForJob(id, { onProgress, signal, every = 700 } = {}) {
  for (;;) {
    const job = await getJob(id, signal);
    onProgress?.(job);
    if (job.status === "done") return job;
    if (job.status === "error") {
      const err = new Error(job.error || "Job failed");
      err.warnings = job.warnings;
      throw err;
    }
    await new Promise((r, rej) => {
      const t = setTimeout(r, every);
      signal?.addEventListener("abort", () => {
        clearTimeout(t);
        rej(new DOMException("Aborted", "AbortError"));
      });
    });
  }
}

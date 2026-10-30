// Job manager: syncs the data a job needs (network, main thread, rate-limited), then runs the
// computation in a worker thread and reports progress. Jobs are kept in memory for 30 min.
import { Worker } from "node:worker_threads";
import { randomUUID } from "node:crypto";
import { syncIntraday, sessionsBack, DataError } from "../data/intraday.js";
import { istEpoch } from "../lab/time.js";
import { LAB } from "../config/lab.js";

const jobs = new Map();
const KEEP_MS = 30 * 60_000;
const ABANDON_MS = 90_000; // a job nobody has polled for this long is stopped (hidden tabs poll ~1/min)
const STOPPED = "Stopped: nobody was waiting for this job";

// At most MAX_WORKERS computations at once; the rest wait in order.
const MAX_WORKERS = 2;
let active = 0;
const queue = [];
const takeSlot = () => (active < MAX_WORKERS ? (active++, Promise.resolve()) : new Promise((r) => queue.push(r)));
const freeSlot = () => (queue.length ? queue.shift()() : active--);

function prune() {
  const t = Date.now();
  for (const [id, j] of jobs) if (j.status !== "running" && t - j.updatedAt > KEEP_MS) jobs.delete(id);
}

export function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  j.seenAt = Date.now();
  return { id: j.id, kind: j.kind, status: j.status, progress: j.progress, result: j.status === "done" ? j.result : null, error: j.error, warnings: j.warnings };
}

/**
 * kind: 'backtest' | 'patterns' | 'today'
 * input.symbols: symbols to sync; input.interval; input.from (YYYY-MM-DD) or input.syncSessions
 * onDone(result) optional hook (used to store Today snapshots).
 */
export function startJob(kind, input, { onDone } = {}) {
  prune();
  const id = randomUUID();
  const job = { id, kind, status: "running", progress: { phase: "data", done: 0, total: input.symbols.length, message: "Updating data" }, result: null, error: null, warnings: [], updatedAt: Date.now(), seenAt: Date.now() };
  jobs.set(id, job);
  const abandoned = () => Date.now() - job.seenAt > ABANDON_MS;

  (async () => {
    // 1. Data (fetch only what's missing).
    const fromSec = input.from ? istEpoch(input.from) - 40 * 86400 : sessionsBack(input.syncSessions || LAB.ranking.oosSessions * 4);
    let ok = 0;
    // input.syncExtra: symbols the computation reads but doesn't trade (e.g. their indices).
    const toSync = [...input.symbols, ...(input.syncExtra || []).filter((s) => !input.symbols.includes(s))];
    for (let k = 0; k < toSync.length; k++) {
      const symbol = toSync[k];
      if (abandoned()) throw new Error(STOPPED);
      job.progress = { phase: "data", done: k, total: toSync.length, message: `Updating ${symbol}` };
      job.updatedAt = Date.now();
      try {
        const { warning } = await syncIntraday(symbol, input.interval, {
          fromSec,
          onProgress: ({ chunk, chunks }) => (job.progress = { ...job.progress, message: `Updating ${symbol} (${chunk}/${chunks})` }),
        });
        if (warning) job.warnings.push(`${symbol}: ${warning}`);
        if (k < input.symbols.length) ok++;
      } catch (err) {
        job.warnings.push(`${symbol}: ${err.message}`);
        // Credentials / config problems affect every symbol: stop early.
        if (err instanceof DataError && (err.code === "NOT_CONFIGURED" || err.code === "AUTH")) break;
      }
    }
    if (!ok && input.symbols.length) {
      throw new Error(job.warnings[0] || "No data available");
    }

    // 2. Compute in a worker, once one is free.
    job.progress = { phase: "compute", done: 0, total: 1, message: "Waiting for a free worker" };
    await takeSlot();
    let result;
    try {
      if (abandoned()) throw new Error(STOPPED);
      job.progress = { phase: "compute", done: 0, total: 1, message: "Starting" };
      result = await new Promise((resolve, reject) => {
        const { symbols: _s, syncSessions: _x, syncExtra: _e, ...rest } = input;
        const w = new Worker(new URL("./worker.js", import.meta.url), { workerData: { kind, input: { ...rest, symbols: input.symbols } } });
        w.on("message", (m) => {
          job.updatedAt = Date.now();
          if (abandoned()) return w.terminate(); // "exit" then rejects with STOPPED
          if (m.type === "progress") job.progress = { phase: m.phase, done: m.done, total: m.total, message: m.message };
          else if (m.type === "result") resolve(m.result);
          else if (m.type === "error") reject(new Error(m.error));
        });
        w.on("error", reject);
        w.on("exit", (code) => code !== 0 && reject(new Error(abandoned() ? STOPPED : `Worker stopped with code ${code}`)));
      });
    } finally {
      freeSlot();
    }
    job.result = result;
    job.status = "done";
    job.progress = { phase: "done", done: 1, total: 1, message: "Done" };
    onDone?.(result);
  })()
    .catch((err) => {
      job.status = "error";
      job.error = err.message;
    })
    .finally(() => (job.updatedAt = Date.now()));

  return getJob(id);
}

// Job manager: syncs the data a job needs (network, main thread, bulk priority), then runs the
// computation on the jobs pool (workers/pool.js) and reports progress. Jobs are kept in memory
// for 30 min. A job nobody has polled for ABANDON_MS stops at its next progress report.
import { randomUUID } from "node:crypto";
import { syncIntraday, sessionsBack } from "../data/intraday.js";
import { AppError, StoppedError } from "../errors.js";
import { asBulk } from "../priority.js";
import { jobPool } from "../workers/pool.js";
import { istEpoch } from "../lab/time.js";
import { LAB } from "../config/lab.js";

const jobs = new Map();
const KEEP_MS = 30 * 60_000;
const ABANDON_MS = 90_000; // hidden browser tabs still poll about once a minute

function prune() {
  const t = Date.now();
  for (const [id, j] of jobs) if (j.status !== "running" && t - j.updatedAt > KEEP_MS) jobs.delete(id);
}

// Every poll moves the job's deadline; the worker reads it (shared memory) while it computes.
const touch = (j) => Atomics.store(j.deadline, 0, BigInt(Date.now() + ABANDON_MS));

export function getJob(id) {
  const j = jobs.get(id);
  if (!j) return null;
  touch(j);
  return { id: j.id, kind: j.kind, status: j.status, progress: j.progress, result: j.status === "done" ? j.result : null, error: j.error, warnings: j.warnings };
}

/**
 * kind: 'backtest' | 'patterns' | 'today' (workers/tasks.js)
 * input.symbols: symbols to sync; input.interval; input.from (YYYY-MM-DD) or input.syncSessions
 * onDone(result): optional hook (stores Today snapshots). affinity: see workers/pool.js.
 */
export function startJob(kind, input, { onDone, affinity = null } = {}) {
  prune();
  const id = randomUUID();
  const deadline = new BigInt64Array(new SharedArrayBuffer(8));
  const job = { id, kind, status: "running", progress: { phase: "data", done: 0, total: input.symbols.length, message: "Updating data" }, result: null, error: null, warnings: [], updatedAt: Date.now(), deadline };
  jobs.set(id, job);
  touch(job);
  const abandoned = () => Date.now() > Number(Atomics.load(deadline, 0));

  (async () => {
    // 1. Data (fetch only what's missing).
    const fromSec = input.from ? istEpoch(input.from) - 40 * 86400 : sessionsBack(input.syncSessions || LAB.ranking.oosSessions * 4);
    let ok = 0;
    // input.syncExtra: symbols the computation reads but doesn't trade (e.g. their indices).
    const toSync = [...input.symbols, ...(input.syncExtra || []).filter((s) => !input.symbols.includes(s))];
    for (let k = 0; k < toSync.length; k++) {
      const symbol = toSync[k];
      if (abandoned()) throw new StoppedError();
      job.progress = { phase: "data", done: k, total: toSync.length, message: `Updating ${symbol}` };
      job.updatedAt = Date.now();
      try {
        const { warning } = await asBulk(() =>
          syncIntraday(symbol, input.interval, {
            fromSec,
            onProgress: ({ chunk, chunks }) => (job.progress = { ...job.progress, message: `Updating ${symbol} (${chunk}/${chunks})` }),
          })
        );
        if (warning) job.warnings.push(`${symbol}: ${warning}`);
        if (k < input.symbols.length) ok++;
      } catch (err) {
        job.warnings.push(`${symbol}: ${err.message}`);
        // Credentials / config problems affect every symbol: stop early.
        if (err instanceof AppError && (err.code === "NOT_CONFIGURED" || err.code === "AUTH")) break;
      }
    }
    if (!ok && input.symbols.length) throw new Error(job.warnings[0] || "No data available");

    // 2. Compute on a worker; "Waiting" until that worker starts it.
    job.progress = { phase: "compute", done: 0, total: 1, message: "Waiting for a free worker" };
    const { symbols: _s, syncSessions: _x, syncExtra: _e, ...rest } = input;
    job.result = await jobPool.run(kind, { ...rest, symbols: input.symbols }, {
      affinity,
      deadline,
      onProgress: (m) => {
        job.updatedAt = Date.now();
        job.progress = { phase: "compute", done: m.done, total: m.total, message: m.message };
      },
    });
    job.status = "done";
    job.progress = { phase: "done", done: 1, total: 1, message: "Done" };
    onDone?.(job.result);
  })()
    .catch((err) => {
      job.status = "error";
      job.error = err.message;
    })
    .finally(() => (job.updatedAt = Date.now()));

  return getJob(id);
}

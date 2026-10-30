// Persistent worker threads for the CPU-heavy work: the main thread only serves HTTP, and the
// workers keep their caches between tasks.
//   jobPool  (2 workers) backtests, pattern stats, Today ranking. A task with an `affinity` key
//            always goes to the same worker, so a target's refreshes find its cached backtest.
//   livePool (1 worker)  one HTTP request each: charts, plans, decision reports, outlooks. A
//            thread of its own, so a long job never delays a chart refresh.
import { Worker } from "node:worker_threads";

const hash = (s) => [...String(s)].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 0);

function createPool(size) {
  const slots = new Array(size).fill(null);
  let seq = 0;

  function spawn(k) {
    const w = new Worker(new URL("./worker.js", import.meta.url));
    const slot = { w, tasks: new Map() };
    w.on("message", (m) => {
      const t = slot.tasks.get(m.id);
      if (!t) return;
      if (m.type === "progress") return t.onProgress?.(m);
      slot.tasks.delete(m.id);
      if (!slot.tasks.size) w.unref(); // idle workers don't keep the process alive
      if (m.type === "result") t.resolve(m.result);
      else t.reject(Object.assign(new Error(m.error), { status: m.status, code: m.code }));
    });
    const fail = (err) => {
      if (slots[k] === slot) slots[k] = null; // the next task starts a fresh worker
      for (const t of slot.tasks.values()) t.reject(err);
      slot.tasks.clear();
    };
    w.on("error", fail);
    w.on("exit", (code) => fail(new Error(`Worker stopped (exit code ${code})`)));
    return slot;
  }

  const load = (k) => slots[k]?.tasks.size ?? 0;
  return {
    /**
     * Runs workers/tasks.js TASKS[task](input). affinity: same key → same worker. onProgress(m):
     * { done, total, message }. deadline: BigInt64Array on a SharedArrayBuffer holding a ms time;
     * once it passes, the task stops at its next progress report.
     */
    run(task, input, { affinity = null, onProgress, deadline } = {}) {
      let k = 0;
      if (affinity != null) k = hash(affinity) % size;
      else for (let j = 1; j < size; j++) if (load(j) < load(k)) k = j;
      const slot = (slots[k] ??= spawn(k));
      const id = ++seq;
      return new Promise((resolve, reject) => {
        slot.tasks.set(id, { resolve, reject, onProgress });
        slot.w.ref();
        slot.w.postMessage({ id, task, input, deadline });
      });
    },
  };
}

export const jobPool = createPool(2);
export const livePool = createPool(1);

// Worker thread: runs TASKS (workers/tasks.js) as the pool asks, one message per task. CPU work
// runs one task at a time; the live worker interleaves tasks while they wait on the network.
import "../env.js";
import { parentPort } from "node:worker_threads";
import { loadHolidays } from "../data/holidays.js";
import { StoppedError } from "../errors.js";
import { TASKS } from "./tasks.js";

parentPort.on("message", async ({ id, task, input, deadline }) => {
  let last = 0;
  // A job's progress, at most every 150 ms. Past the deadline (nobody polling) the job stops here.
  const progress = (done, total, message) => {
    if (deadline && Date.now() > Number(Atomics.load(deadline, 0))) throw new StoppedError();
    const t = Date.now();
    if (t - last < 150 && done < total) return;
    last = t;
    parentPort.postMessage({ id, type: "progress", done, total, message });
  };
  try {
    loadHolidays(); // special dates learned since the last task
    progress(0, 1, "Starting");
    parentPort.postMessage({ id, type: "result", result: await TASKS[task](input, progress) });
  } catch (err) {
    parentPort.postMessage({ id, type: "error", error: err.message, status: err.status, code: err.code });
  }
});

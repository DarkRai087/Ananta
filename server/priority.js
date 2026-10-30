// Request priority. Bulk work (a job's data sync, the backfill script) runs inside asBulk(fn):
// the SmartAPI limiter then serves interactive requests (chart, plans, reports) first.
import { AsyncLocalStorage } from "node:async_hooks";

const bulk = new AsyncLocalStorage();
export const asBulk = (fn) => bulk.run(true, fn);
export const isBulk = () => bulk.getStore() === true;

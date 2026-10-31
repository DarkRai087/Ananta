// node cli.js --data RELIANCE.json --plan plan.json [--index NIFTY.json] [--events events.json]
//              [--analog] [--vol-scale] [--seed 19] [--replays 10000] [--window 2] [--json]
// node cli.js walkforward --data RELIANCE.json --train-end YYYY-MM-DD [--index ...] [--events ...]
//              [--seed 19] [--replays 2000] [--window 2] [--json]
// --data / --index: Kite candles (an array, or a Kite response with data.candles) or sessions.
// A plan without stop and target is a forecast. Today's morning comes from --data when needed.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { runTimeMachine } from "./src/index.js";
import { walkForward } from "./src/walkforward.js";
import { fromKite } from "./src/kite.js";
import { slotOf } from "./src/time.js";
import { report, walkForwardReport } from "./src/report.js";

try {
  const str = { type: "string" };
  const bool = { type: "boolean" };
  const { values: a, positionals } = parseArgs({
    allowPositionals: true,
    options: { data: str, plan: str, index: str, events: str, "train-end": str, seed: str, replays: str, window: str, analog: bool, "vol-scale": bool, json: bool },
  });
  const walk = positionals[0] === "walkforward";
  if (!a.data || (walk ? !a["train-end"] : !a.plan))
    throw Object.assign(new Error("node cli.js --data <candles.json> --plan <plan.json> [...] | node cli.js walkforward --data <candles.json> --train-end YYYY-MM-DD [...]"), { code: "USAGE" });
  const read = (file) => JSON.parse(readFileSync(file, "utf8"));
  const load = (file) => {
    const raw = read(file);
    const candles = raw.data?.candles ?? raw.candles ?? raw;
    return candles[0]?.bars ? candles : fromKite(candles);
  };
  const num = (v) => (v === undefined ? undefined : Number(v));
  const sessions = load(a.data);
  const shared = { index: a.index && load(a.index), events: a.events && read(a.events), seed: num(a.seed), replays: num(a.replays), window: num(a.window) };
  let r;
  if (walk) {
    r = walkForward(sessions, { ...shared, trainEnd: a["train-end"] });
  } else {
    const plan = read(a.plan);
    const day = (a.analog || plan.entry == null) && sessions.find((s) => s.date === plan.date);
    const today = day ? { date: day.date, bars: day.bars.slice(0, slotOf(plan.entryTime)) } : undefined;
    r = runTimeMachine(plan, sessions, { ...shared, today, conditioning: { enabled: Boolean(a.analog), volScale: Boolean(a["vol-scale"]) } });
  }
  console.log(a.json ? JSON.stringify(r, null, 2) : walk ? walkForwardReport(r) : report(r));
} catch (e) {
  console.error(`${e.code ?? "ERROR"}: ${e.message}`);
  process.exit(1);
}

// Backfill intraday history into the lab store.
//
//   npm run backfill -- --symbols=NIFTY50 --interval=5m --years=2
//   npm run backfill -- --symbols=RELIANCE,TCS --interval=1m,5m --years=1
//   npm run backfill -- --symbols=WATCHLIST --interval=15m --from=2024-01-01
//
// --symbols accepts symbols and/or universe names (NIFTY50, NIFTY100, WATCHLIST). A universe
// expands to its stocks (NIFTY50 also includes the NIFTY 50 index itself).
// Resumable: stop with Ctrl+C any time; already-fetched chunks are kept and the next run
// fetches only what's still missing.
import "../env.js";
import { ensureUniverses, resolveTarget } from "../data/universes.js";
import { ensureHolidays } from "../data/holidays.js";
import { syncIntraday, labSource, cachedBounds } from "../data/intraday.js";
import { LAB } from "../config/lab.js";
import { istEpoch, istDate } from "../lab/time.js";

function arg(name, def = null) {
  const hit = process.argv.slice(2).find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return def;
  const eq = hit.indexOf("=");
  if (eq >= 0) return hit.slice(eq + 1);
  const i = process.argv.indexOf(hit);
  return process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : true;
}

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log("\nStopping after the current symbol… (Ctrl+C again to force)");
});

async function main() {
  const symbolsArg = arg("symbols");
  if (!symbolsArg || symbolsArg === true) {
    console.log("Usage: npm run backfill -- --symbols=NIFTY50 --interval=5m --years=2");
    process.exit(1);
  }
  const intervals = String(arg("interval", LAB.defaultInterval)).split(",").map((s) => s.trim());
  const years = Number(arg("years", LAB.backfillYears));
  const fromArg = arg("from");
  const fromSec = fromArg ? istEpoch(fromArg) : Math.floor(Date.now() / 1000) - Math.round(years * 365 * 86400);

  const src = labSource();
  for (const iv of intervals) {
    if (!src.intervals.includes(iv)) {
      console.error(`${src.name} doesn't provide ${iv}. Lab intervals: ${src.intervals.join(", ")}`);
      process.exit(1);
    }
  }
  if (src.id !== "smartapi") {
    console.warn(`⚠ SmartAPI credentials not found in server/.env — using ${src.name}, which only keeps ~60 days of 5m/15m and ~7 days of 1m/3m.\n`);
  }

  await Promise.all([ensureUniverses(), ensureHolidays()]);
  const symbols = [...new Set(String(symbolsArg).split(",").flatMap((t) => resolveTarget(t, { includeIndex: true })))];
  if (!symbols.length) {
    console.error("No symbols to backfill (empty universe or watchlist?).");
    process.exit(1);
  }

  console.log(`Backfilling ${symbols.length} symbol(s) × ${intervals.join(", ")} from ${istDate(fromSec)} using ${src.name}.`);
  console.log("Safe to stop with Ctrl+C; run the same command again to resume.\n");

  const started = Date.now();
  let ok = 0;
  let failed = 0;
  const total = symbols.length * intervals.length;
  let n = 0;
  outer: for (const iv of intervals) {
    for (const symbol of symbols) {
      if (stopping) break outer;
      n++;
      const tag = `[${String(n).padStart(String(total).length)}/${total}] ${symbol.padEnd(12)} ${iv.padEnd(3)}`;
      try {
        const { warning, added } = await syncIntraday(symbol, iv, {
          fromSec,
          force: true,
          onProgress: ({ chunk, chunks }) => process.stdout.write(`\r${tag} chunk ${chunk}/${chunks}   `),
        });
        const b = cachedBounds(symbol, iv);
        const span = b.first ? `${istDate(b.first)} → ${istDate(b.last)}` : "no data";
        process.stdout.write(`\r${tag} +${added} candles · ${span}${warning ? ` · ${warning}` : ""}        \n`);
        ok++;
      } catch (err) {
        process.stdout.write(`\r${tag} FAILED: ${err.message}\n`);
        failed++;
        if (err.code === "NOT_CONFIGURED" || err.code === "AUTH") break outer;
      }
    }
  }
  const mins = ((Date.now() - started) / 60000).toFixed(1);
  console.log(`\n${ok} done, ${failed} failed in ${mins} min.${stopping ? " Paused — run again to resume." : ""}`);
  process.exitCode = failed && !ok ? 1 : 0; // let open sockets close (process.exit can crash libuv on Windows)
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

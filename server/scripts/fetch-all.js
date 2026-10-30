// Bulk-cache daily history for every NSE symbol.
//
//   npm run fetch-all                 resume / top up (skips symbols done in the last 20h)
//   npm run fetch-all -- --restart    ignore saved progress and go through everything again
//   npm run fetch-all -- --delay 2000 delay between requests in ms (default 1500)
//
// Safe to stop with Ctrl+C at any time; the next run continues where it left off.
import db from "../db.js";
import { ensureSymbolList, allEquitySymbols, INDICES } from "../data/symbols.js";
import { refreshCandles } from "../data/candles.js";
import { AppError } from "../errors.js";

const args = process.argv.slice(2);
const restart = args.includes("--restart");
const delayArg = args.indexOf("--delay");
const DELAY_MS = delayArg >= 0 ? Number(args[delayArg + 1]) || 1500 : 1500;

const DONE_FRESH_MS = 20 * 3600_000; // treat "done" as current for 20 hours
const NOT_FOUND_SKIP_MS = 7 * 86400_000; // don't retry unknown symbols for a week

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const getProgress = db.prepare("SELECT status, updated_at FROM bulk_progress WHERE symbol = ?");
const countDaily = db.prepare("SELECT COUNT(*) AS n FROM candles WHERE source = 'yahoo' AND symbol = ? AND interval = '1d'");
const setProgress = db.prepare(
  "INSERT OR REPLACE INTO bulk_progress (symbol, status, message, updated_at) VALUES (?, ?, ?, ?)"
);

let stopping = false;
process.on("SIGINT", () => {
  if (stopping) process.exit(1);
  stopping = true;
  console.log("\nStopping after the current symbol… (Ctrl+C again to force)");
});

function fmtDuration(ms) {
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
  return h ? `${h}h ${m}m` : `${m}m ${s % 60}s`;
}

async function main() {
  const n = await ensureSymbolList();
  if (!n) {
    console.error("No NSE symbols available (download failed and cache is empty). Check your internet.");
    process.exit(1);
  }
  if (restart) db.prepare("DELETE FROM bulk_progress").run();

  const symbols = [...INDICES.map((i) => i.symbol), ...allEquitySymbols()];
  const now = Date.now();
  const todo = symbols.filter((s) => {
    const p = getProgress.get(s);
    if (!p) return true;
    if (p.status === "done") return now - p.updated_at > DONE_FRESH_MS;
    if (p.status === "not_found") return now - p.updated_at > NOT_FOUND_SKIP_MS;
    return true; // failed → retry
  });

  console.log(`${symbols.length} symbols total, ${symbols.length - todo.length} already done, ${todo.length} to fetch.`);
  console.log(`Delay between requests: ${DELAY_MS} ms. Press Ctrl+C to pause.\n`);

  const started = Date.now();
  let ok = 0, failed = 0, notFound = 0;

  for (let i = 0; i < todo.length && !stopping; i++) {
    const symbol = todo[i];
    const prefix = `[${String(i + 1).padStart(String(todo.length).length)}/${todo.length}] ${symbol.padEnd(12)}`;

    let attempt = 0;
    while (!stopping) {
      try {
        const { added, warning } = await refreshCandles(symbol, "1d", { force: true });
        if (warning) throw new AppError(503, "NETWORK", warning);
        const total = countDaily.get(symbol).n;
        if (!total) throw new AppError(404, "NOT_FOUND", `No data for ${symbol}`);
        setProgress.run(symbol, "done", null, Date.now());
        ok++;
        console.log(`${prefix} +${added} candles (${total} total)`);
        break;
      } catch (err) {
        const code = err.code || "UNKNOWN";
        if (code === "NOT_FOUND") {
          setProgress.run(symbol, "not_found", err.message, Date.now());
          notFound++;
          console.log(`${prefix} not found on Yahoo — skipped`);
          break;
        }
        if ((code === "RATE_LIMIT" || code === "NETWORK") && attempt < 5) {
          const wait = code === "RATE_LIMIT" ? 60_000 * (attempt + 1) : 30_000;
          attempt++;
          console.warn(`${prefix} ${code === "RATE_LIMIT" ? "rate limited" : "network error"}; waiting ${wait / 1000}s before retry ${attempt}/5`);
          await sleep(wait);
          continue;
        }
        setProgress.run(symbol, "failed", err.message, Date.now());
        failed++;
        console.warn(`${prefix} FAILED: ${err.message}`);
        break;
      }
    }

    if (i > 0 && (i + 1) % 50 === 0) {
      const elapsed = Date.now() - started;
      const eta = (elapsed / (i + 1)) * (todo.length - i - 1);
      console.log(`  … ${i + 1}/${todo.length} in ${fmtDuration(elapsed)}, ~${fmtDuration(eta)} left`);
    }
    if (i < todo.length - 1 && !stopping) await sleep(DELAY_MS + Math.random() * 500);
  }

  console.log(`\nDone: ${ok} updated, ${notFound} not found, ${failed} failed in ${fmtDuration(Date.now() - started)}.`);
  if (stopping) console.log("Paused. Run `npm run fetch-all` again to resume.");
  db.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import "./env.js";
import express from "express";
import cors from "cors";
import { ensureSymbolList, searchSymbols } from "./data/symbols.js";
import { getCandles, AppError } from "./data/candles.js";
import { ensureHolidays } from "./data/holidays.js";
import { ensureUniverses } from "./data/universes.js";
import { ensureIndexMembers } from "./data/indexMembers.js";
import { labSource } from "./data/intraday.js";
import labRoutes from "./routes/lab.js";
import predictRoutes from "./routes/predict.js";
import marketRoutes from "./routes/market.js";

const PORT = Number(process.env.PORT) || 4000;
const app = express();

app.use(cors({ origin: [/^http:\/\/localhost:\d+$/, /^http:\/\/127\.0\.0\.1:\d+$/] }));
app.use(express.json({ limit: "1mb" }));

// GET /api/symbols?q=reli  → [{ symbol, name, type }]
app.get("/api/symbols", (req, res) => {
  res.json(searchSymbols(req.query.q, Math.min(Number(req.query.limit) || 20, 50)));
});

// GET /api/candles/RELIANCE?interval=1d|1w|1mo|1h|15m|5m|3m|1m
//   intraday intervals also accept overlays=vwap,ema,… patterns=engulfing,… orMinutes=15
app.get("/api/candles/:symbol", async (req, res, next) => {
  try {
    const list = (v) => String(v || "").split(",").filter(Boolean);
    res.json(
      await getCandles(req.params.symbol, req.query.interval || "1d", {
        overlays: list(req.query.overlays),
        patterns: list(req.query.patterns),
        orMinutes: Number(req.query.orMinutes) || 15,
      })
    );
  } catch (err) {
    next(err);
  }
});

app.use("/api/lab", labRoutes);
app.use("/api/predict", predictRoutes);
app.use("/api/market", marketRoutes);

app.get("/api/health", (_req, res) => res.json({ ok: true }));

app.use((err, _req, res, _next) => {
  if (err instanceof AppError || (err.status && err.code)) {
    return res.status(err.status).json({ error: err.message, code: err.code });
  }
  console.error(err);
  res.status(500).json({ error: err.message || "Internal error", code: "INTERNAL" });
});

// Bind to localhost only: nothing outside this machine can reach it.
app.listen(PORT, "127.0.0.1", () => {
  console.log(`[server] http://localhost:${PORT}`);
  console.log(`[server] intraday lab data: ${labSource().name}`);
  // Background refreshes (each keeps its cached copy on failure).
  ensureSymbolList();
  ensureHolidays();
  ensureUniverses();
  ensureIndexMembers();
});

// /api/predict/* — bullish / bearish outlook (prediction module), computed on the live worker.
import { Router } from "express";
import { modelList } from "../prediction/index.js";
import { livePool } from "../workers/pool.js";
import { symbolOf, intervalOf } from "./validate.js";

const router = Router();

router.get("/models", (_req, res) => res.json(modelList()));

// GET /api/predict/RELIANCE?interval=5m
router.get("/:symbol", async (req, res) => {
  res.json(await livePool.run("predict", { symbol: symbolOf(req.params.symbol), interval: intervalOf(req.query.interval) }));
});

export default router;

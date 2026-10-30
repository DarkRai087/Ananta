// /api/market/* — index membership, how a share follows its index, and the index right now.
import { Router } from "express";
import { livePool } from "../workers/pool.js";
import { symbolOf, intervalOf } from "./validate.js";

const router = Router();

// GET /api/market/index-link/HDFCBANK?interval=5m
router.get("/index-link/:symbol", async (req, res) => {
  res.json(await livePool.run("indexLink", { symbol: symbolOf(req.params.symbol), interval: intervalOf(req.query.interval) }));
});

export default router;

// /api/market/* — index membership, how a share follows its index, and the index right now.
import { Router } from "express";
import { LAB } from "../config/lab.js";
import { indexLink } from "../market/index.js";

const router = Router();

// GET /api/market/index-link/HDFCBANK?interval=5m
router.get("/index-link/:symbol", async (req, res, next) => {
  try {
    const interval = req.query.interval || LAB.defaultInterval;
    if (!LAB.intervals[interval]) return res.status(400).json({ error: "bad interval", code: "BAD_REQUEST" });
    res.json(await indexLink(req.params.symbol, { interval }));
  } catch (err) {
    next(err);
  }
});

export default router;

// /api/predict/* — bullish / bearish outlook (prediction module).
import { Router } from "express";
import { LAB } from "../config/lab.js";
import { predict, modelList } from "../prediction/index.js";

const router = Router();

router.get("/models", (_req, res) => res.json(modelList()));

// GET /api/predict/RELIANCE?interval=5m
router.get("/:symbol", async (req, res, next) => {
  try {
    const interval = req.query.interval || LAB.defaultInterval;
    if (!LAB.intervals[interval]) return res.status(400).json({ error: "bad interval", code: "BAD_REQUEST" });
    res.json(await predict(req.params.symbol, { interval }));
  } catch (err) {
    next(err);
  }
});

export default router;

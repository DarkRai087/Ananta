// Pattern registry. Each detector: detect(sessionCandles, i) -> { name, direction, index } | null
// It receives ONE session's candles and may only look at indices <= i.
import * as engulfing from "./detectors/engulfing.js";
import * as hammer from "./detectors/hammer.js";
import * as invertedHammer from "./detectors/invertedHammer.js";
import * as shootingStar from "./detectors/shootingStar.js";
import * as marubozu from "./detectors/marubozu.js";
import * as doji from "./detectors/doji.js";
import * as gravestoneDoji from "./detectors/gravestoneDoji.js";
import * as dragonflyDoji from "./detectors/dragonflyDoji.js";
import * as morningStar from "./detectors/morningStar.js";
import * as eveningStar from "./detectors/eveningStar.js";
import * as insideBar from "./detectors/insideBar.js";
import * as bullFlag from "./detectors/bullFlag.js";
import * as bearFlag from "./detectors/bearFlag.js";
import * as doubleTop from "./detectors/doubleTop.js";
import * as doubleBottom from "./detectors/doubleBottom.js";
import * as ascendingTriangle from "./detectors/ascendingTriangle.js";
import * as descendingTriangle from "./detectors/descendingTriangle.js";

export const DETECTORS = [
  engulfing, hammer, invertedHammer, shootingStar, marubozu, doji, gravestoneDoji, dragonflyDoji,
  morningStar, eveningStar, insideBar, bullFlag, bearFlag, doubleTop, doubleBottom,
  ascendingTriangle, descendingTriangle,
];

export const DETECTOR_BY_ID = Object.fromEntries(DETECTORS.map((d) => [d.id, d]));

export function patternList() {
  return DETECTORS.map((d) => ({ id: d.id, names: d.names }));
}

// All hits in one session for the chosen detector ids (default: all).
export function detectSession(candles, ids = null) {
  const dets = ids ? ids.map((x) => DETECTOR_BY_ID[x]).filter(Boolean) : DETECTORS;
  const hits = [];
  for (let i = 0; i < candles.length; i++) {
    for (const d of dets) {
      const h = d.detect(candles, i);
      if (h) hits.push({ ...h, id: d.id });
    }
  }
  return hits;
}

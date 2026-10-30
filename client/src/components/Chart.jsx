import { useEffect, useRef } from "react";
import {
  createChart,
  createSeriesMarkers,
  CandlestickSeries,
  HistogramSeries,
  LineSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
} from "lightweight-charts";

const IST_OFFSET_SEC = 5.5 * 3600;
const UP = "#26a69a";
const DOWN = "#ef5350";

// lightweight-charts labels the axis in UTC. Daily times are already IST-date keys;
// intraday times are real UTC epochs, so shift them by +5:30 to display IST.
export const toChartTime = (t, intraday) => (intraday ? t + IST_OFFSET_SEC : t);

// Overlay series styles. pane 2 = RSI sub-pane.
const STYLE = {
  vwap: { color: "#f0a030", lineWidth: 2, title: "VWAP" },
  ema9: { color: "#4fc3f7", lineWidth: 1, title: "EMA 9" },
  ema21: { color: "#b388ff", lineWidth: 1, title: "EMA 21" },
  pdh: { color: "#9e9e9e", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "PDH" },
  pdl: { color: "#9e9e9e", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "PDL" },
  orHigh: { color: "#ffd54f", lineWidth: 1, title: "OR H" },
  orLow: { color: "#ffd54f", lineWidth: 1, title: "OR L" },
  pivot: { color: "#e0e0e0", lineWidth: 1, lineStyle: LineStyle.Dotted, title: "P" },
  tc: { color: "#64b5f6", lineWidth: 1, title: "TC" },
  bc: { color: "#64b5f6", lineWidth: 1, title: "BC" },
  r1: { color: "#e57373", lineWidth: 1, lineStyle: LineStyle.Dotted, title: "R1" },
  r2: { color: "#e57373", lineWidth: 1, lineStyle: LineStyle.Dotted, title: "R2" },
  s1: { color: "#81c784", lineWidth: 1, lineStyle: LineStyle.Dotted, title: "S1" },
  s2: { color: "#81c784", lineWidth: 1, lineStyle: LineStyle.Dotted, title: "S2" },
  stUp: { color: UP, lineWidth: 2, title: "ST" },
  stDown: { color: DOWN, lineWidth: 2, title: "ST" },
  bbUpper: { color: "#78909c", lineWidth: 1, title: "BB" },
  bbMid: { color: "#78909c", lineWidth: 1, lineStyle: LineStyle.Dashed, title: "" },
  bbLower: { color: "#78909c", lineWidth: 1, title: "BB" },
  rsi: { color: "#ce93d8", lineWidth: 1, title: "RSI 14", pane: 2 },
};

const MARKER_COLOR = { long: "#26a69a", short: "#ef5350", neutral: "#b0bec5" };

/**
 * data:     { candles, intraday }                      (setting new data fits the view)
 * overlays: { seriesName: [{ time, value? }] }         (raw times)
 * markers:  [{ time, position, shape, color?, text?, direction? }]
 * levels:   [{ price, label, color? }]                  (horizontal price lines)
 * focus:    { from, to } raw times to zoom to (optional)
 * fitKey:   when given, the view is only re-fitted when this changes, so live updates
 *           with the same key keep the user's zoom and scroll (optional)
 */
export default function Chart({ data, overlays, markers, levels, focus, fitKey, className = "chart" }) {
  const containerRef = useRef(null);
  const chartRef = useRef(null);
  const fittedKeyRef = useRef(null);
  const candleRef = useRef(null);
  const volumeRef = useRef(null);
  const markersRef = useRef(null);
  const overlayRef = useRef(new Map());
  const linesRef = useRef([]);

  // Create the chart once.
  useEffect(() => {
    const chart = createChart(containerRef.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0d1117" },
        textColor: "#8b949e",
        fontSize: 12,
        attributionLogo: false,
        panes: { separatorColor: "#21262d", separatorHoverColor: "#30363d", enableResize: true },
      },
      grid: { vertLines: { color: "#161b22" }, horzLines: { color: "#161b22" } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: "#21262d" },
      timeScale: { borderColor: "#21262d", minBarSpacing: 0.001, rightOffset: 5 },
    });

    candleRef.current = chart.addSeries(CandlestickSeries, {
      upColor: UP,
      downColor: DOWN,
      borderUpColor: UP,
      borderDownColor: DOWN,
      wickUpColor: UP,
      wickDownColor: DOWN,
    });
    volumeRef.current = chart.addSeries(
      HistogramSeries,
      { priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false },
      1
    );
    chart.panes()[0].setStretchFactor(4);
    chart.panes()[1].setStretchFactor(1);
    markersRef.current = createSeriesMarkers(candleRef.current, []);

    chartRef.current = chart;
    const overlayMap = overlayRef.current;
    return () => {
      chart.remove();
      overlayMap.clear();
      chartRef.current = candleRef.current = volumeRef.current = markersRef.current = null;
    };
  }, []);

  const intraday = Boolean(data?.intraday);

  // Candles + volume. New data → fit the whole range (unless it's a live update of the same fitKey).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || !data) return;
    const { candles } = data;
    chart.applyOptions({ timeScale: { timeVisible: intraday, secondsVisible: false } });
    candleRef.current.setData(
      candles.map((c) => ({ time: toChartTime(c.time, intraday), open: c.open, high: c.high, low: c.low, close: c.close }))
    );
    const hasVolume = candles.some((c) => c.volume > 0); // indices have no volume
    volumeRef.current.setData(
      hasVolume
        ? candles.map((c) => ({
            time: toChartTime(c.time, intraday),
            value: c.volume,
            color: c.close >= c.open ? "rgba(38,166,154,0.5)" : "rgba(239,83,80,0.5)",
          }))
        : []
    );
    if (fitKey == null || fitKey !== fittedKeyRef.current) chart.timeScale().fitContent();
    fittedKeyRef.current = fitKey ?? null;
  }, [data, intraday, fitKey]);

  // Overlay line series (added / removed as toggled).
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const map = overlayRef.current;
    const want = overlays || {};
    for (const [name, series] of map) {
      if (!want[name]) {
        chart.removeSeries(series);
        map.delete(name);
      }
    }
    for (const [name, points] of Object.entries(want)) {
      const st = STYLE[name] || { color: "#90a4ae", lineWidth: 1, title: name };
      let s = map.get(name);
      if (!s) {
        s = chart.addSeries(
          LineSeries,
          {
            color: st.color,
            lineWidth: st.lineWidth,
            lineStyle: st.lineStyle ?? LineStyle.Solid,
            title: st.title,
            priceLineVisible: false,
            lastValueVisible: name === "rsi",
            crosshairMarkerVisible: false,
          },
          st.pane ?? 0
        );
        map.set(name, s);
        if (name === "rsi") {
          s.createPriceLine({ price: 70, color: "#5d4037", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
          s.createPriceLine({ price: 30, color: "#1b5e20", lineStyle: LineStyle.Dashed, lineWidth: 1, axisLabelVisible: false });
          chart.panes()[2]?.setStretchFactor(1.2);
        }
      }
      // lightweight-charts draws straight across whitespace, and a segment takes the colour of
      // the point it starts from. Making the last point before each gap transparent keeps
      // one session's line from joining the next.
      s.setData(
        points.map((p, k) => {
          const time = toChartTime(p.time, intraday);
          if (p.value == null) return { time };
          const next = points[k + 1];
          return next && next.value == null ? { time, value: p.value, color: "rgba(0,0,0,0)" } : { time, value: p.value };
        })
      );
    }
    // Drop an empty RSI pane.
    if (!want.rsi && chart.panes().length > 2) {
      try {
        chart.removePane(2);
      } catch {
        /* already gone */
      }
    }
  }, [overlays, intraday]);

  // Markers (patterns, trades).
  useEffect(() => {
    if (!markersRef.current) return;
    const list = (markers || [])
      .map((m) => ({
        time: toChartTime(m.time, intraday),
        position: m.position,
        shape: m.shape,
        color: m.color || MARKER_COLOR[m.direction] || "#b0bec5",
        text: m.text || "",
        size: m.size ?? 1,
      }))
      .sort((a, b) => a.time - b.time);
    markersRef.current.setMarkers(list);
  }, [markers, intraday]);

  // Horizontal key levels.
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const l of linesRef.current) series.removePriceLine(l);
    // Stretch the price scale so every level (e.g. a far-away target) stays on screen.
    const prices = (levels || []).map((l) => l.price).filter(Number.isFinite);
    series.applyOptions({
      autoscaleInfoProvider: (original) => {
        const res = original();
        if (!res?.priceRange || !prices.length) return res;
        return {
          ...res,
          priceRange: { minValue: Math.min(res.priceRange.minValue, ...prices), maxValue: Math.max(res.priceRange.maxValue, ...prices) },
        };
      },
    });
    linesRef.current = (levels || []).map((l) =>
      series.createPriceLine({
        price: l.price,
        color: l.color || "#ffd54f",
        lineWidth: 1,
        lineStyle: LineStyle.Dashed,
        axisLabelVisible: true,
        title: l.label,
      })
    );
  }, [levels]);

  // Optional zoom to a range (e.g. today's session).
  useEffect(() => {
    if (!chartRef.current || !focus || !data) return;
    try {
      chartRef.current.timeScale().setVisibleRange({ from: toChartTime(focus.from, intraday), to: toChartTime(focus.to, intraday) });
    } catch {
      /* range outside data */
    }
  }, [focus, data, intraday]);

  return <div ref={containerRef} className={className} />;
}

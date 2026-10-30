import { useEffect, useRef, useState, useCallback } from "react";
import { startToday, waitForJob, labMeta } from "./api.js";
import { istNow, isMarketOpen } from "./format.js";

// Lab metadata (strategies, patterns, overlays, provider…), loaded once.
let metaPromise = null;
export function useLabMeta() {
  const [meta, setMeta] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    metaPromise ||= labMeta();
    metaPromise.then(setMeta).catch((e) => {
      metaPromise = null;
      setError(e.message);
    });
  }, []);
  return { meta, error };
}

/**
 * Today's Top 3 + scoreboard for a target. Auto-refreshes every `refreshMinutes` between
 * 09:00 and the freeze time (10:30 IST) on weekdays; after that the server returns a frozen
 * snapshot for the day.
 */
export function useToday(target, interval, oosSessions, ranking, account = null) {
  const [result, setResult] = useState(null);
  const [progress, setProgress] = useState(null);
  const [error, setError] = useState(null);
  const [warnings, setWarnings] = useState([]);
  const [loading, setLoading] = useState(false);
  const ctrlRef = useRef(null);

  const run = useCallback(
    async (force = false) => {
      if (!target) return;
      ctrlRef.current?.abort();
      const ctrl = new AbortController();
      ctrlRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const r = await startToday({ target, interval, oosSessions, force, account });
        if (r.result) {
          setResult(r.result);
          setWarnings([]);
        } else {
          const job = await waitForJob(r.job.id, { signal: ctrl.signal, onProgress: (j) => setProgress(j.progress) });
          setResult(job.result);
          setWarnings(job.warnings || []);
        }
      } catch (e) {
        if (e.name !== "AbortError") {
          setError(e.message);
          setWarnings(e.warnings || []);
        }
      } finally {
        if (!ctrl.signal.aborted) {
          setLoading(false);
          setProgress(null);
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [target, interval, oosSessions, JSON.stringify(account)]
  );

  useEffect(() => {
    setResult(null);
    run();
    return () => ctrlRef.current?.abort();
  }, [run]);

  // Auto-refresh window.
  useEffect(() => {
    if (!ranking) return;
    const [fh, fm] = ranking.freezeAt.split(":").map(Number);
    const freeze = fh * 60 + fm;
    const id = setInterval(() => {
      const n = istNow();
      const weekday = n.weekday >= 1 && n.weekday <= 5;
      if (weekday && n.minute >= 9 * 60 && n.minute <= freeze + 1 && result?.mode !== "frozen") run();
    }, ranking.refreshMinutes * 60_000);
    return () => clearInterval(id);
  }, [run, ranking, result?.mode]);

  return { result, progress, error, warnings, loading, refresh: () => run(true) };
}

/**
 * Loads load(signal) when `key` changes, then re-loads quietly every `everyMs` while the
 * market is open and the tab is visible. Keeps the last good data if a refresh fails.
 */
export function useLiveData(load, key, { everyMs = 15_000 } = {}) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    if (!key) return;
    const ctrl = new AbortController();
    let busy = false;
    const go = (first) => {
      if (busy) return;
      busy = true;
      if (first) setLoading(true);
      loadRef.current(ctrl.signal)
        .then((d) => {
          setData(d);
          setError(null);
        })
        .catch((e) => e.name !== "AbortError" && first && setError(e.message))
        .finally(() => {
          busy = false;
          if (first && !ctrl.signal.aborted) setLoading(false);
        });
    };
    setData(null);
    go(true);
    const id = setInterval(() => isMarketOpen() && !document.hidden && go(false), everyMs);
    return () => {
      ctrl.abort();
      clearInterval(id);
    };
  }, [key, everyMs]);

  return { data, error, loading };
}

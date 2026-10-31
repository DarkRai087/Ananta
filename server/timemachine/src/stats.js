// Values at index floor(p·(n−1)) of the values sorted ascending: one sort for many p. Sorts a copy.
export function percentiles(values, ps) {
  const s = Float64Array.from(values).sort();
  return ps.map((p) => s[Math.floor(p * (s.length - 1))]);
}

export const percentile = (values, p) => percentiles(values, [p])[0];

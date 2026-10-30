export default function JobProgress({ progress }) {
  if (!progress) return null;
  const pct = progress.total ? Math.min(100, (progress.done / progress.total) * 100) : 0;
  return (
    <div className="progress">
      <div className="progress-bar">
        <div style={{ width: `${pct}%` }} />
      </div>
      <span className="small muted">
        {progress.phase === "data" ? "Data" : "Compute"} · {progress.message} {progress.total > 1 ? `(${progress.done}/${progress.total})` : ""}
      </span>
    </div>
  );
}

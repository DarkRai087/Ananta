// One plain verdict, judged against break-even (1 / (1 + R)), not against 50%.
export function verdict({ target, stop, neither, targetR, avgR, replays, until }) {
  const decided = target + stop;
  if (!decided) return ["No replay reached the stop or the target: not enough movement to judge."];
  const diff = Math.round((target / decided - 1 / (1 + targetR)) * 100 * 1e6) / 1e6; // points; rounding avoids float edges
  const lean = diff >= 5 ? "target" : diff <= -5 ? "stop" : null;
  const lines = [lean ? `${Math.abs(diff) >= 15 ? "Strongly" : "Leans"} toward the ${lean}.` : Math.abs(targetR - 1) < 0.01 ? "Close to a coin flip." : "Close to break-even."];
  if (neither / replays > 0.4) lines.push(`More than 40% of replays were still open at ${until}: the plan often runs out of time.`);
  if ((lean === "target" && avgR < 0) || (lean === "stop" && avgR > 0)) lines.push(`Average R is ${avgR.toFixed(2)}, against the lean.`);
  return lines;
}

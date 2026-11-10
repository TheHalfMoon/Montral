export function densestMonitorWindow(observations, windowSec) {
  if (!Number.isFinite(windowSec) || windowSec <= 0) throw new RangeError("windowSec must be positive");
  let max = 0;
  const histogram = {};
  let i = 0;
  const seen = new Set();
  while (i < observations.length) {
    const id = observations[i].id;
    if (typeof id !== "string" || !id) throw new TypeError("invalid monitor id");
    if (seen.has(id)) throw new Error("observations must be grouped by monitor");
    seen.add(id);
    let j = i;
    let previous = -Infinity;
    while (j < observations.length && observations[j].id === id) {
      const t = observations[j].t;
      if (typeof t !== "number" || !Number.isFinite(t) || t < previous) {
        throw new Error("observations must have finite, ordered timestamps");
      }
      previous = t;
      j++;
    }
    let worst = 0;
    for (let a = i, b = i; b < j; b++) {
      while (observations[b].t - observations[a].t >= windowSec) a++;
      worst = Math.max(worst, b - a + 1);
    }
    max = Math.max(max, worst);
    histogram[worst] = (histogram[worst] ?? 0) + 1;
    i = j;
  }
  return { max, histogram };
}
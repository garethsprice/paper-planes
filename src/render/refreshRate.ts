// Display refresh-rate probe. The landscape streams at a fixed number of
// rows per second (see TERRAIN_ROW_RATE); locking that number to the
// display's rate keeps the pace the scene was tuned at on every screen
// while making it independent of dropped frames. Measured from raw rAF
// intervals before the first render, so shader compilation can't skew it.

const COMMON_RATES = [60, 72, 75, 90, 100, 120, 144, 165, 240];

/** Snap a measured rate to a common display rate when within 6%. */
export function snapRefreshRate(hz: number): number {
  let best = hz;
  let bestErr = Infinity;
  for (const r of COMMON_RATES) {
    const err = Math.abs(r - hz) / r;
    if (err < bestErr) { bestErr = err; best = r; }
  }
  return bestErr <= 0.06 ? best : Math.round(hz);
}

/**
 * Median rAF interval over `frames` frames → Hz, snapped. Resolves null if
 * frames don't arrive within `timeoutMs` (a hidden tab), so the caller can
 * fall back and calibrate later.
 */
export function measureRefreshRate(frames = 30, timeoutMs = 1500): Promise<number | null> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let last = -1;
    let done = false;
    const timer = window.setTimeout(() => { done = true; resolve(null); }, timeoutMs);
    const tick = (now: number): void => {
      if (done) return;
      if (last >= 0) intervals.push(now - last);
      last = now;
      if (intervals.length < frames) { requestAnimationFrame(tick); return; }
      done = true;
      window.clearTimeout(timer);
      intervals.sort((a, b) => a - b);
      const median = intervals[intervals.length >> 1];
      resolve(median > 0 ? snapRefreshRate(1000 / median) : null);
    };
    requestAnimationFrame(tick);
  });
}

/** Incremental calibrator for when the probe couldn't run: feed it frame
 *  intervals; it reports a rate once it has enough clean samples. */
export function createRateCalibrator(samplesNeeded = 90): { push: (dt: number) => number | null } {
  const dts: number[] = [];
  let resolved = false;
  return {
    push(dt: number): number | null {
      if (resolved) return null;
      if (dt > 0.002 && dt < 0.05) dts.push(dt);
      if (dts.length < samplesNeeded) return null;
      resolved = true;
      dts.sort((a, b) => a - b);
      return snapRefreshRate(1 / dts[dts.length >> 1]);
    },
  };
}

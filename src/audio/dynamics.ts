// Three-time-scale loudness EMAs (short ~150 ms, mid ~2 s, long ~10 s) used
// to derive the "intensity / build / quiet / drop" semantic signals. The
// dynamics layer is what lets the visual director reason about musical
// structure (vs. just raw audio amplitude).

import { DROP_RATIO_THRESHOLD, DROP_REFRACTORY_MS, QUIET_THRESHOLD } from '../constants.ts';

export type Dynamics = {
  short: number;
  mid: number;
  long: number;
  intensity: number;
  quiet: boolean;
  build: number;
  prevShort: number;
  dropTime: number;
  dropCount: number;
  lastDropDelta: number;
};

export function createDynamics(): Dynamics {
  return {
    short: 0,
    mid: 0,
    long: 0,
    intensity: 1.0,
    quiet: false,
    build: 0,
    prevShort: 0,
    dropTime: -Infinity,
    dropCount: 0,
    lastDropDelta: 0,
  };
}

/**
 * Advance the dynamics state from a fresh frame's audio level (peak-of-FFT).
 * Returns true if a drop event fired this frame so the caller can trigger
 * downstream side effects (formation flight, FOV pulse, camera cut).
 */
export function updateDynamics(d: Dynamics, level: number, dt: number): boolean {
  const aShort = 1 - Math.exp(-dt / 0.15);
  const aMid   = 1 - Math.exp(-dt / 2.0);
  const aLong  = 1 - Math.exp(-dt / 10.0);
  d.short += (level - d.short) * aShort;
  d.mid   += (level - d.mid)   * aMid;
  d.long  += (level - d.long)  * aLong;
  d.intensity = Math.min(1.5, d.short / Math.max(0.08, d.long));
  d.quiet = d.short < QUIET_THRESHOLD;
  d.build = Math.max(0, Math.min(1, (d.short - d.mid) * 4));

  const ratio = d.short / Math.max(0.05, d.mid);
  const nowMs = performance.now();
  let dropFired = false;
  if (ratio > DROP_RATIO_THRESHOLD && d.short > 0.15 && nowMs - d.dropTime > DROP_REFRACTORY_MS) {
    d.dropTime = nowMs;
    d.dropCount++;
    d.lastDropDelta = ratio;
    dropFired = true;
  }
  d.prevShort = d.short;
  return dropFired;
}

/** Idle decay — call when no audio source is feeding fftBins. */
export function decayDynamics(d: Dynamics): void {
  d.short *= 0.95;
  d.mid   *= 0.99;
  d.long  *= 0.998;
  d.intensity = Math.min(1.5, d.short / Math.max(0.08, d.long));
  d.quiet = true;
  d.build = 0;
}

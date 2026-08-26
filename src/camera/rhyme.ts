// Visual rhyme. Music repeats — a chorus comes back, a riff returns — and
// recognition is one of the strongest frisson triggers there is. The camera
// echoes it: every shot change is tagged with a fingerprint of the music
// that led into it (smoothed energy, bass, brightness, intensity) and the
// kind of event that caused it. When a later change's fingerprint sits
// close to a remembered one, the director reuses that shot instead of
// picking a new one, so the second chorus is seen from where the first was.

import {
  RHYME_FEATURE_S, RHYME_MATCH_DIST, RHYME_MIN_AGE_S, RHYME_MAX_MEMORIES,
} from '../constants.ts';

export type RhymeKind = 'drop' | 'build' | 'quiet' | 'cadence';

type Memory = {
  kind: RhymeKind;
  fingerprint: number[];
  modeIdx: number;
  madeAt: number;
  hits: number;
};

export type Rhyme = {
  /** Smoothed feature vector — what the music has been doing lately. */
  fingerprint: number[];
  memories: Memory[];
  /** Seconds (scene time) of the last successful recall, for the status strip. */
  lastRecallAt: number;
};

export function createRhyme(): Rhyme {
  return { fingerprint: [0, 0, 0.5 * 2.5, 0.5 * 0.3], memories: [], lastRecallAt: -Infinity };
}

export type RhymeFeatures = {
  energy: number;     // 0..1 normalised spectrum level (flock energy)
  bassEnergy: number; // 0..1
  centroid: number;   // 0..1
  intensity: number;  // ~0..1.5
};

// Axis weights. Energy and bass carry the section identity; centroid
// (timbre) sits in a small numeric range so it is scaled up; intensity is
// a short/long loudness ratio that decays through any section as the long
// average catches up — it says how long a section has played, not which
// one it is — so it gets little weight.
const WEIGHTS = [1.0, 1.0, 2.5, 0.3];

/** Ease the fingerprint toward the current features (call every frame). */
export function updateRhyme(rhyme: Rhyme, f: RhymeFeatures, dt: number): void {
  const k = 1 - Math.exp(-dt / RHYME_FEATURE_S);
  const raw = [f.energy, f.bassEnergy, f.centroid, Math.min(1, f.intensity / 1.5)];
  const target = raw.map((v, i) => v * WEIGHTS[i]);
  for (let i = 0; i < target.length; i++) {
    rhyme.fingerprint[i] += (target[i] - rhyme.fingerprint[i]) * k;
  }
}

function distance(a: number[], b: number[]): number {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) * (a[i] - b[i]);
  return Math.sqrt(s);
}

/**
 * Look for a remembered shot whose lead-in matched the current one. Returns
 * its mode index, or -1. `usable` lets the caller reject modes that are not
 * available right now (a chase of a ship that has left) or the current mode.
 */
export function rhymeRecall(
  rhyme: Rhyme,
  kind: RhymeKind,
  time: number,
  usable: (modeIdx: number) => boolean,
): number {
  let best: Memory | null = null;
  let bestD = RHYME_MATCH_DIST;
  for (const m of rhyme.memories) {
    if (m.kind !== kind) continue;
    if (time - m.madeAt < RHYME_MIN_AGE_S) continue; // not the shot we just left
    if (!usable(m.modeIdx)) continue;
    const d = distance(m.fingerprint, rhyme.fingerprint);
    if (d < bestD) { bestD = d; best = m; }
  }
  if (!best) return -1;
  best.hits++;
  rhyme.lastRecallAt = time;
  return best.modeIdx;
}

/** Record a novel section → shot pairing. */
export function rhymeRemember(rhyme: Rhyme, kind: RhymeKind, modeIdx: number, time: number): void {
  rhyme.memories.push({
    kind, fingerprint: rhyme.fingerprint.slice(), modeIdx, madeAt: time, hits: 0,
  });
  if (rhyme.memories.length > RHYME_MAX_MEMORIES) rhyme.memories.shift();
}

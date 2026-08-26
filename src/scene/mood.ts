// Emotional shape of the scene, derived from the dynamics layer. Four
// slow scalars that everything downstream (exposure, fog, aurora, bloom,
// camera, flock) reads:
//   anticipation — rises through a build. Used to *withhold*: dim, fog in,
//                  push the camera in and low, tighten and lift the flock.
//   flash        — a short spike at the drop (flash-to-white).
//   afterglow    — a longer tail after the drop: the sky lit, FOV wide.
//   hush         — rises slowly in genuine quiet, falls fast on the first
//                  kick, so darkness arrives gently and light returns at once.

import {
  MOOD_ANTICIPATION_RISE_S, MOOD_ANTICIPATION_FALL_S,
  MOOD_FLASH_S, MOOD_AFTERGLOW_S, MOOD_HUSH_RISE_S, MOOD_HUSH_FALL_S,
} from '../constants.ts';
import type { Dynamics } from '../audio/dynamics.ts';

export type Mood = {
  anticipation: number;
  flash: number;
  afterglow: number;
  hush: number;
};

export function createMood(): Mood {
  return { anticipation: 0, flash: 0, afterglow: 0, hush: 0 };
}

export function updateMood(
  mood: Mood,
  d: Dynamics,
  dropFired: boolean,
  hasAudio: boolean,
  dt: number,
): void {
  // Anticipation: the build signal, smoothed, gated off in quiet and cleared
  // the instant the drop lands so the release is a step.
  const buildTarget = hasAudio && !d.quiet ? Math.min(1, d.build * 1.15) : 0;
  if (dropFired) {
    mood.anticipation = 0;
    mood.flash = 1;
    mood.afterglow = 1;
  } else {
    const tau = buildTarget > mood.anticipation
      ? MOOD_ANTICIPATION_RISE_S
      : MOOD_ANTICIPATION_FALL_S;
    mood.anticipation += (buildTarget - mood.anticipation) * (1 - Math.exp(-dt / tau));
  }
  mood.flash *= Math.exp(-dt / MOOD_FLASH_S);
  mood.afterglow *= Math.exp(-dt / MOOD_AFTERGLOW_S);

  const hushTarget = !hasAudio || d.quiet ? 1 : 0;
  const hushTau = hushTarget > mood.hush ? MOOD_HUSH_RISE_S : MOOD_HUSH_FALL_S;
  mood.hush += (hushTarget - mood.hush) * (1 - Math.exp(-dt / hushTau));
}

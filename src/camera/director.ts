// Music-driven camera director. Cuts on drops / build onsets / quiet
// onsets; otherwise paces beat-cadence cuts whose interval scales with
// musical intensity. Pilot override (arrow-key in chase/cockpit) extends
// the current shot so user control isn't snatched away mid-flight.

import { PILOT_EXTEND_MS } from '../constants.ts';
import type { Dynamics } from '../audio/dynamics.ts';
import type { CameraSelection } from './modes.ts';
import { applyCut, pickCinematicMode } from './modes.ts';

export type Director = {
  cinematicAuto: boolean;
  prevBuild: number;
  prevQuiet: boolean;
  /** ms timestamp; 6-second refractory between build cuts. */
  lastBuildCutAt: number;
  /** Beat count at which the next cadence cut may fire. */
  nextCutMinBeats: number;
  /** Pilot active until this ms timestamp; arrow keys refresh it. */
  pilotActiveUntil: number;
};

export function createDirector(): Director {
  return {
    cinematicAuto: true,
    prevBuild: 0,
    prevQuiet: false,
    lastBuildCutAt: 0,
    nextCutMinBeats: 0,
    pilotActiveUntil: 0,
  };
}

/** Refresh the pilot timer, but only if the active mode is a tracked one. */
export function bumpPilotControl(director: Director, sel: CameraSelection): void {
  const m = sel.modes[sel.currentIdx];
  if (m.kind === 'chase' || m.kind === 'cockpit') {
    director.pilotActiveUntil = performance.now() + PILOT_EXTEND_MS;
  }
}

export type DirectorContext = {
  dynamics: Dynamics;
  dropFiredThisFrame: boolean;
  beatCount: number;
  bpm: number;
};

/**
 * Run one director tick. May call applyCut to swap the camera mode and the
 * cadence baselines on the selection handle.
 */
export function runDirector(
  director: Director,
  sel: CameraSelection,
  ctx: DirectorContext,
): void {
  if (!director.cinematicAuto) return;
  const now = performance.now();
  if (now < director.pilotActiveUntil) {
    // Pilot in control: pin the cadence baselines so the next cut is
    // computed from the moment the pilot lets go (not from before they
    // grabbed the stick). prev* trackers stay current so we don't fire a
    // stale onset edge once they release.
    sel.beatsAtChange = ctx.beatCount;
    sel.modeChangedAt = now;
    director.prevBuild = ctx.dynamics.build;
    director.prevQuiet = ctx.dynamics.quiet;
    return;
  }
  const buildOnset = ctx.dynamics.build > 0.45 && director.prevBuild <= 0.45;
  const quietOnset = ctx.dynamics.quiet && !director.prevQuiet;
  const shotAgeMs = now - sel.modeChangedAt;
  // Languid pacing — events have to wait for a fresh shot to breathe.
  const MIN_SHOT_EVENT_MS = 3500;
  const MIN_SHOT_CADENCE_MS = 6000;

  if (ctx.dropFiredThisFrame && shotAgeMs > MIN_SHOT_EVENT_MS) {
    applyCut(sel, pickCinematicMode(sel, 'dramatic'), ctx.beatCount);
  } else if (buildOnset && now - director.lastBuildCutAt > 6000 && shotAgeMs > MIN_SHOT_EVENT_MS) {
    applyCut(sel, pickCinematicMode(sel, 'rush'), ctx.beatCount);
    director.lastBuildCutAt = now;
  } else if (quietOnset && shotAgeMs > MIN_SHOT_EVENT_MS) {
    applyCut(sel, pickCinematicMode(sel, 'calm'), ctx.beatCount);
    director.nextCutMinBeats = ctx.beatCount + 48;
  } else {
    // Beat cadence — long holds. Intensity narrows the interval but never
    // below ~12 beats so even peak sections feel composed.
    const I = ctx.dynamics.intensity;
    const beatsPerCut = ctx.dynamics.quiet ? 48 : I > 0.85 ? 12 : I > 0.5 ? 24 : 32;
    const beatReady =
      ctx.beatCount - sel.beatsAtChange >= beatsPerCut &&
      ctx.beatCount >= director.nextCutMinBeats &&
      shotAgeMs > MIN_SHOT_CADENCE_MS;
    // Time fallback — long enough to feel patient when the analyser hasn't
    // locked yet (BPM=0 → 20 s floor).
    const fallbackMs = ctx.bpm > 0 ? (60 / ctx.bpm) * 1000 * beatsPerCut * 2.5 : 20000;
    const timeReady = shotAgeMs >= fallbackMs;
    if (beatReady || timeReady) {
      const role = I > 0.3 ? 'active' : 'calm';
      applyCut(sel, pickCinematicMode(sel, role), ctx.beatCount);
    }
  }

  director.prevBuild = ctx.dynamics.build;
  director.prevQuiet = ctx.dynamics.quiet;
}

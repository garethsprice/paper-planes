// Spring-physics orbit state used by the cinematic preset cameras. Mouse
// drag pushes targetYaw/targetPitch; each frame we integrate yaw/pitch
// toward those targets with critically-underdamped springs (slight
// overshoot when targets change). Bass attacks add an impulse to yawVel.

import { CAM_STIFFNESS, CAM_DAMPING, CAM_BASS_IMPULSE } from '../constants.ts';

export type Orbit = {
  yaw: number;
  pitch: number;
  yawVel: number;
  pitchVel: number;
  targetYaw: number;
  targetPitch: number;
  prevBass: number;
  camRadius: number;
  camHeight: number;
  dragging: boolean;
  lastX: number;
  lastY: number;
};

export function createOrbit(): Orbit {
  return {
    yaw: 0,
    pitch: 0,
    yawVel: 0,
    pitchVel: 0,
    targetYaw: 0,
    targetPitch: 0,
    prevBass: 0,
    camRadius: 28,
    camHeight: 9,
    dragging: false,
    lastX: 0,
    lastY: 0,
  };
}

/** Wire pointer events to the orbit state for manual drag-to-look. */
export function attachOrbitInput(orbit: Orbit, canvas: HTMLCanvasElement): void {
  canvas.addEventListener('pointerdown', (e) => {
    orbit.dragging = true;
    orbit.lastX = e.clientX;
    orbit.lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointerup', (e) => {
    orbit.dragging = false;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!orbit.dragging) return;
    const dx = e.clientX - orbit.lastX;
    const dy = e.clientY - orbit.lastY;
    orbit.lastX = e.clientX;
    orbit.lastY = e.clientY;
    orbit.targetYaw += dx * 0.0035;
    orbit.targetPitch += dy * 0.0025;
    orbit.targetPitch = Math.max(-0.45, Math.min(0.55, orbit.targetPitch));
  });
}

/**
 * Integrate the spring physics for one frame. Bass attacks (sudden positive
 * delta in bassEnergy above the threshold) inject a yaw impulse so the
 * camera nudges sideways on each kick.
 */
export function updateOrbitPhysics(orbit: Orbit, bassEnergy: number, dt: number): void {
  const bassDelta = bassEnergy - orbit.prevBass;
  orbit.prevBass = bassEnergy;
  if (bassDelta > 0.05) orbit.yawVel += bassDelta * CAM_BASS_IMPULSE;

  const yawErr = orbit.targetYaw - orbit.yaw;
  const pitchErr = orbit.targetPitch - orbit.pitch;
  orbit.yawVel += yawErr * CAM_STIFFNESS * dt - orbit.yawVel * CAM_DAMPING * dt;
  orbit.pitchVel += pitchErr * CAM_STIFFNESS * dt - orbit.pitchVel * CAM_DAMPING * dt;
  orbit.yaw += orbit.yawVel * dt;
  orbit.pitch += orbit.pitchVel * dt;
}

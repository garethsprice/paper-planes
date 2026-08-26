// Spring-physics orbit state used by the cinematic preset cameras. Each
// frame yaw/pitch are integrated toward targetYaw/targetPitch with a slow,
// critically damped spring, so a preset change becomes a ~3 s glide rather
// than a cut. Mouse drag adds an offset (dragYaw/dragPitch) on top of the
// preset target; the offset relaxes back over tens of seconds so the shot
// quietly returns to its composed framing. Bass attacks add a whisper of
// sway to yawVel.

import {
  CAM_STIFFNESS, CAM_DAMPING, CAM_BASS_IMPULSE, CAM_DRAG_RELAX_S,
} from '../constants.ts';

export type Orbit = {
  yaw: number;
  pitch: number;
  yawVel: number;
  pitchVel: number;
  targetYaw: number;
  targetPitch: number;
  /** User drag offsets, added to the preset target and slowly relaxed. */
  dragYaw: number;
  dragPitch: number;
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
    dragYaw: 0,
    dragPitch: 0,
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
    orbit.dragYaw += dx * 0.0035;
    orbit.dragPitch = Math.max(-0.45, Math.min(0.55, orbit.dragPitch + dy * 0.0025));
  });
}

/**
 * Integrate the spring physics for one frame. Bass attacks (sudden positive
 * delta in bassEnergy above the threshold) inject a small yaw impulse so the
 * camera sways faintly on each kick.
 */
export function updateOrbitPhysics(orbit: Orbit, bassEnergy: number, dt: number): void {
  const bassDelta = bassEnergy - orbit.prevBass;
  orbit.prevBass = bassEnergy;
  if (bassDelta > 0.05) orbit.yawVel += bassDelta * CAM_BASS_IMPULSE;

  // Drag offsets relax while the pointer is up.
  if (!orbit.dragging) {
    const relax = 1 - Math.exp(-dt / CAM_DRAG_RELAX_S);
    orbit.dragYaw -= orbit.dragYaw * relax;
    orbit.dragPitch -= orbit.dragPitch * relax;
  }

  const yawErr = orbit.targetYaw - orbit.yaw;
  const pitchErr = orbit.targetPitch - orbit.pitch;
  orbit.yawVel += yawErr * CAM_STIFFNESS * dt - orbit.yawVel * CAM_DAMPING * dt;
  orbit.pitchVel += pitchErr * CAM_STIFFNESS * dt - orbit.pitchVel * CAM_DAMPING * dt;
  orbit.yaw += orbit.yawVel * dt;
  orbit.pitch += orbit.pitchVel * dt;
}

// Per-frame camera-position update — switches on the active mode and writes
// to the master camera. Preset orbits dolly with intensity; chase trails
// the ship with a smooth lerp; cockpit locks to the nose; vr-observer
// plants the camera at a fixed anchor and lets WebXR pose the rotation.

import * as THREE from 'three';
import type { CameraSelection } from './modes.ts';
import type { Orbit } from './orbit.ts';

// Type duck for "ship-like" — we only read these fields, so no need to
// import the full Ship type and create a circular dep with the camera modules.
type ShipLike = {
  group: THREE.Group;
  heading: number;
  zWrapDelta: number;
};

export type CameraUpdateInput = {
  bassEnergy: number;
  intensity: number;
  buildLevel: number;
  dt: number;
};

export function updateCamera(
  camera: THREE.PerspectiveCamera,
  sel: CameraSelection,
  orbit: Orbit,
  ships: ShipLike[],
  input: CameraUpdateInput,
): void {
  const camMode = sel.modes[sel.currentIdx];
  if (camMode.kind === 'preset') {
    const p = camMode.preset;
    orbit.targetYaw = p.yaw;
    orbit.targetPitch = p.pitch;
    // The orbit's spring physics + bass impulse have already been integrated
    // upstream in updateOrbitPhysics; here we just place the camera using
    // the current spring state and the preset's radius/height (which we
    // smoothly dolly toward, scaled by intensity & build).
    const dollyLerp = 1 - Math.exp(-2.0 * input.dt);
    const targetRadius = p.radius - input.bassEnergy * 2.5 * input.intensity + input.buildLevel * 5;
    const targetHeight = p.height + input.buildLevel * 2;
    orbit.camRadius += (targetRadius - orbit.camRadius) * dollyLerp;
    orbit.camHeight += (targetHeight - orbit.camHeight) * dollyLerp;
    camera.position.x = Math.sin(orbit.yaw) * orbit.camRadius;
    camera.position.z = Math.cos(orbit.yaw) * orbit.camRadius;
    camera.position.y = orbit.camHeight + orbit.pitch * 12;
    camera.lookAt(0, 1.5, 0);
  } else if (camMode.kind === 'chase') {
    // Rigid in the ship's yaw frame: X/Z snap to "5 behind heading" so the
    // view-forward axis can never desync from the nose (that desync was what
    // read as the ship "strafing sideways"). Only Y lerps, to soften terrain
    // bobs. The carried zWrapDelta keeps the camera with the ship across
    // front/back wrap so the framing doesn't pan backward when the wrap fires.
    const ship = ships[camMode.shipIdx];
    const sp = ship.group.position;
    const fwdX = -Math.sin(ship.heading);
    const fwdZ = -Math.cos(ship.heading);
    if (ship.zWrapDelta !== 0) camera.position.z += ship.zWrapDelta;
    const camY = sp.y + 2.0;
    camera.position.x = sp.x - fwdX * 5;
    camera.position.z = sp.z - fwdZ * 5;
    const ky = 1 - Math.exp(-6 * input.dt);
    camera.position.y += (camY - camera.position.y) * ky;
    // Look 18u ahead at camera height — view-forward is horizontal, so the
    // horizon stays near screen-centre and the ship rides the lower third.
    camera.lookAt(sp.x + fwdX * 18, camera.position.y, sp.z + fwdZ * 18);
  } else if (camMode.kind === 'cockpit') {
    // Locked to the ship's nose, looking forward. Hide own ship.
    const ship = ships[camMode.shipIdx];
    ship.group.visible = false;
    const sp = ship.group.position;
    const fwdX = -Math.sin(ship.heading);
    const fwdZ = -Math.cos(ship.heading);
    camera.position.set(sp.x + fwdX * 0.3, sp.y + 0.05, sp.z + fwdZ * 0.3);
    camera.lookAt(sp.x + fwdX * 12, sp.y + 0.05, sp.z + fwdZ * 12);
  } else {
    // vr-observer: stationary anchor for WebXR. WebXRManager layers the
    // headset's pose on top each frame.
    camera.position.set(0, 4, 18);
    camera.quaternion.identity();
  }
}

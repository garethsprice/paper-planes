// Per-frame camera update. Each mode computes a *desired pose* (position,
// look target, roll); a blending layer then eases the real camera toward it.
// On a mode change the blend restarts from wherever the camera currently is
// and glides — arcing slightly upward — into the new mode's live pose over a
// few seconds, so there is never a hard cut. Once the blend completes the
// camera simply follows the mode's pose (which has its own damping).
//
// Modes: preset orbits glide between compositions on the slow spring and
// drift gently while held; chase trails the ship on a damped tether with a
// hint of bank; cockpit rides the nose; vr-observer plants the camera at a
// fixed anchor and lets WebXR pose the rotation (no blending — the headset
// owns orientation).

import * as THREE from 'three';
import {
  CAM_DRIFT_YAW, CAM_DRIFT_RATE, CAM_DOLLY_LERP,
  CHASE_BACK, CHASE_UP, CHASE_LOOK_UP, CHASE_LOOK_AHEAD, CHASE_POS_LERP, CHASE_LOOK_LERP,
  CHASE_ROLL_FOLLOW, CHASE_TERRAIN_CLEAR, CAM_BLEND_ARC,
} from '../constants.ts';
import type { CameraSelection } from './modes.ts';
import type { Orbit } from './orbit.ts';

// Type duck for "ship-like" — we only read these fields, so no need to
// import the full Ship type and create a circular dep with the camera modules.
type ShipLike = {
  group: THREE.Group;
  heading: number;
  pitch: number;
  roll: number;
};

type Pose = { pos: THREE.Vector3; look: THREE.Vector3; roll: number };

function makePose(): Pose {
  return { pos: new THREE.Vector3(), look: new THREE.Vector3(), roll: 0 };
}

/** Persistent camera state: the pose actually applied, the blend origin,
 *  and the chase tether's own smoothing. */
export type CameraRig = {
  /** Pose applied to the camera last frame. */
  pose: Pose;
  /** Pose the current blend started from. */
  from: Pose;
  /** Live pose of the active mode (scratch). */
  desired: Pose;
  /** Seconds elapsed in the current blend; ≥ blendDur means "arrived". */
  blendT: number;
  blendDur: number;
  /** Mode index last frame; a change restarts the blend. */
  lastModeIdx: number;
  /** Chase tether state — camera spot and gaze ease independently. */
  chasePos: THREE.Vector3;
  chaseLook: THREE.Vector3;
};

export function createCameraRig(): CameraRig {
  return {
    pose: makePose(),
    from: makePose(),
    desired: makePose(),
    blendT: Infinity,
    blendDur: 1,
    lastModeIdx: -1,
    chasePos: new THREE.Vector3(),
    chaseLook: new THREE.Vector3(),
  };
}

export type CameraUpdateInput = {
  bassEnergy: number;
  intensity: number;
  buildLevel: number;
  dt: number;
  time: number;
  /** Terrain height at a world XZ — keeps the camera above the grid. */
  terrainHeightAt: (x: number, z: number) => number;
};

function wrapAngle(a: number): number {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function smoothstep(t: number): number {
  const s = t < 0 ? 0 : t > 1 ? 1 : t;
  return s * s * (3 - 2 * s);
}

export function updateCamera(
  camera: THREE.PerspectiveCamera,
  sel: CameraSelection,
  orbit: Orbit,
  rig: CameraRig,
  ships: ShipLike[],
  input: CameraUpdateInput,
): void {
  const camMode = sel.modes[sel.currentIdx];
  const modeChanged = rig.lastModeIdx !== sel.currentIdx;
  const firstFrame = rig.lastModeIdx === -1;
  rig.lastModeIdx = sel.currentIdx;

  if (camMode.kind === 'vr-observer') {
    // Stationary anchor for WebXR. WebXRManager layers the headset's pose on
    // top each frame; no blending so orientation is never fought.
    camera.position.set(0, 4, 18);
    camera.quaternion.identity();
    rig.pose.pos.copy(camera.position);
    rig.pose.look.set(0, 4, 0);
    rig.pose.roll = 0;
    rig.blendT = Infinity;
    return;
  }

  // ----- 1. the active mode's live pose -----
  const d = rig.desired;
  if (camMode.kind === 'preset') {
    const p = camMode.preset;
    // Slow ambient drift keeps a held shot alive; the phase is offset per
    // preset so two consecutive shots never drift in step.
    const drift = Math.sin(input.time * CAM_DRIFT_RATE + sel.currentIdx * 1.7) * CAM_DRIFT_YAW;
    // Shortest-path yaw so a preset on the far side is reached by the
    // nearer sweep — never a full wrap-around.
    const wantYaw = p.yaw + drift + orbit.dragYaw;
    orbit.targetYaw = orbit.yaw + wrapAngle(wantYaw - orbit.yaw);
    orbit.targetPitch = p.pitch + orbit.dragPitch;
    if (modeChanged) {
      // Start the spring at the preset: the pose blend below already
      // carries the camera in, so the orbit needn't swing as well.
      orbit.yaw = orbit.targetYaw;
      orbit.pitch = orbit.targetPitch;
      orbit.yawVel = 0;
      orbit.pitchVel = 0;
      orbit.camRadius = p.radius;
      orbit.camHeight = p.height;
    }
    // Radius/height dolly slowly toward the preset. Bass pushes in by a
    // fraction of a unit, builds pull back and rise — all on the slow ease.
    const dollyLerp = 1 - Math.exp(-CAM_DOLLY_LERP * input.dt);
    const breathe = Math.sin(input.time * 0.05 + sel.currentIdx) * 0.8;
    const targetRadius = p.radius + breathe - input.bassEnergy * 0.8 * input.intensity + input.buildLevel * 3;
    const targetHeight = p.height + input.buildLevel * 1.5;
    orbit.camRadius += (targetRadius - orbit.camRadius) * dollyLerp;
    orbit.camHeight += (targetHeight - orbit.camHeight) * dollyLerp;
    d.pos.set(
      Math.sin(orbit.yaw) * orbit.camRadius,
      orbit.camHeight + orbit.pitch * 12,
      Math.cos(orbit.yaw) * orbit.camRadius,
    );
    d.look.set(0, 1.5, 0);
    d.roll = 0;
  } else if (camMode.kind === 'chase') {
    // Damped tether. The ideal spot sits behind and a little above the nose
    // in the ship's yaw frame; the camera eases toward it and its gaze
    // eases toward a point ahead of and above the ship, so the ship sits
    // just below centre with the horizon behind it rather than the grid.
    // A fraction of the ship's bank tilts the horizon so turns feel carried.
    const ship = ships[camMode.shipIdx];
    const sp = ship.group.position;
    const fwdX = -Math.sin(ship.heading);
    const fwdZ = -Math.cos(ship.heading);
    const idealX = sp.x - fwdX * CHASE_BACK;
    const idealZ = sp.z - fwdZ * CHASE_BACK;
    // The ship rides a smoothed envelope, but the ground behind it can still
    // be a ridge it just crested — never let the tether sink into the grid.
    const idealY = Math.max(
      sp.y + CHASE_UP,
      input.terrainHeightAt(idealX, idealZ) + CHASE_TERRAIN_CLEAR,
    );
    if (modeChanged) {
      rig.chasePos.set(idealX, idealY, idealZ);
      rig.chaseLook.set(sp.x + fwdX * CHASE_LOOK_AHEAD, sp.y + CHASE_LOOK_UP, sp.z + fwdZ * CHASE_LOOK_AHEAD);
    } else {
      const kp = 1 - Math.exp(-CHASE_POS_LERP * input.dt);
      rig.chasePos.x += (idealX - rig.chasePos.x) * kp;
      rig.chasePos.y += (idealY - rig.chasePos.y) * kp;
      rig.chasePos.z += (idealZ - rig.chasePos.z) * kp;
      d.look.set(sp.x + fwdX * CHASE_LOOK_AHEAD, sp.y + CHASE_LOOK_UP, sp.z + fwdZ * CHASE_LOOK_AHEAD);
      rig.chaseLook.lerp(d.look, 1 - Math.exp(-CHASE_LOOK_LERP * input.dt));
    }
    d.pos.copy(rig.chasePos);
    d.look.copy(rig.chaseLook);
    d.roll = ship.roll * CHASE_ROLL_FOLLOW;
  } else {
    // Cockpit: locked to the ship's nose, looking along the flight path and
    // rolling with the wings. Hide own ship.
    const ship = ships[camMode.shipIdx];
    ship.group.visible = false;
    const sp = ship.group.position;
    const cosP = Math.cos(ship.pitch);
    const fwdX = -Math.sin(ship.heading) * cosP;
    const fwdY = Math.sin(ship.pitch);
    const fwdZ = -Math.cos(ship.heading) * cosP;
    d.pos.set(sp.x + fwdX * 0.3, sp.y + 0.05 + fwdY * 0.3, sp.z + fwdZ * 0.3);
    d.look.set(sp.x + fwdX * 12, sp.y + 0.05 + fwdY * 12, sp.z + fwdZ * 12);
    d.roll = ship.roll;
  }

  // ----- 2. blend from the previous pose into the live one -----
  if (modeChanged && !firstFrame) {
    rig.from.pos.copy(rig.pose.pos);
    rig.from.look.copy(rig.pose.look);
    rig.from.roll = rig.pose.roll;
    rig.blendT = 0;
    rig.blendDur = Math.max(0.05, sel.transitionS);
  }
  rig.blendT += input.dt;
  const out = rig.pose;
  if (rig.blendT >= rig.blendDur) {
    out.pos.copy(d.pos);
    out.look.copy(d.look);
    out.roll = d.roll;
  } else {
    const s = smoothstep(rig.blendT / rig.blendDur);
    out.pos.lerpVectors(rig.from.pos, d.pos, s);
    out.look.lerpVectors(rig.from.look, d.look, s);
    out.roll = rig.from.roll + (d.roll - rig.from.roll) * s;
    // Crane-style arc: lift through the middle of the move so the camera
    // sails over the terrain between two low shots instead of through it.
    out.pos.y += Math.sin(s * Math.PI) * CAM_BLEND_ARC;
  }
  // Whatever the path, stay above the grid.
  const floor = input.terrainHeightAt(out.pos.x, out.pos.z) + CHASE_TERRAIN_CLEAR;
  if (out.pos.y < floor) out.pos.y = floor;

  camera.position.copy(out.pos);
  camera.up.set(0, 1, 0);
  camera.lookAt(out.look);
  if (out.roll !== 0) camera.rotateZ(out.roll);
}

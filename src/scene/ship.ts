// Rapier-backed flight model. Each ship is a dynamic rigid body driven by four
// forces (thrust, drag, lift, gravity) plus PD attitude torques. Per frame:
//   1. updateShipControls() — read body state, pick a wander/pilot target, queue
//      forces and torques (no state mutations beyond cached fields).
//   2. main.ts calls world.step() once for all bodies.
//   3. syncShipFromBody() — copy body translation/rotation into the Three.js
//      group, run terrain hard-clear, Z-wrap, X-bounce, refresh ship.heading.
// The split keeps force queueing deterministic and lets every body see the same
// pre-step world state.

import * as THREE from 'three';
import RAPIER from '@dimforge/rapier3d-compat';
import {
  SHIP_X_BOUND, SHIP_Z_MIN, SHIP_Z_MAX, SHIP_Z_CENTER,
  SHIP_Y_MIN, SHIP_Y_MAX, SHIP_CLEARANCE, SHIP_HARD_CLEAR,
  SHIP_LOOKAHEAD_DIST,
  SHIP_MAX_BANK, SHIP_MAX_PITCH,
  SHIP_THRUST_BASE, SHIP_THRUST_BOOST, SHIP_THRUST_BEAT,
  SHIP_DRAG_K, SHIP_LIFT_K, SHIP_CL_SLOPE, SHIP_CL_MAX, SHIP_GRAVITY,
  SHIP_HEADING_TO_BANK, SHIP_ALT_TO_PITCH, SHIP_PITCH_VY_DAMP,
  SHIP_YAW_RATE, SHIP_PITCH_LERP, SHIP_ROLL_LERP,
  FORMATION_SLOTS,
} from '../constants.ts';
import { bilerpHeight, type Terrain } from './terrain.ts';
import { addShipBody, type Physics } from './physics.ts';

export type Ship = {
  group: THREE.Group;
  body: RAPIER.RigidBody;
  /** Kinematic attitude state (YXZ Euler order). Each frame the autopilot
   *  computes targets and these lerp toward them at controlled rates, then we
   *  setRotation() on the body. Linear motion stays dynamic — forces (thrust,
   *  drag, lift, gravity) still integrate via Rapier — but attitude no longer
   *  fights itself in a PD loop. */
  heading: number;
  pitch: number;
  roll: number;
  wanderSeed: number;
  /** Last frame's wander target — wingmen read the leader's value during formation. */
  lastTargetX: number;
  lastTargetZ: number;
  /** Z teleport applied this frame by the wrap logic; chase camera adds it
   *  to its position so the framing doesn't jolt when the wrap fires. */
  zWrapDelta: number;
};

export type Formation = {
  active: boolean;
  startedAt: number;
  endsAt: number;
  blendIn: number;
  blendOut: number;
};

export type Ships = {
  list: Ship[];
  formation: Formation;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial;
};

function buildShipGeometry(): THREE.BufferGeometry {
  // Long sharp nose at local −Z (three.js camera convention: body_forward =
  // (0,0,−1)). Wings are short and swept back so the silhouette unambiguously
  // points forward — the previous near-symmetric proportions let the eye read
  // the wing edge as the nose, which is what looked like "going backwards".
  const geom = new THREE.BufferGeometry();
  const v = new Float32Array([
     0,      0,   -1.6,   // 0: nose tip — long, prominent
    -0.65,   0,    0.6,   // 1: back-left wing tip
     0,      0,    0.3,   // 2: back-notch (top of rear face)
     0.65,   0,    0.6,   // 3: back-right wing tip
     0,     -0.5,  0.3,   // 4: keel-tail (bottom of rear face)
  ]);
  geom.setAttribute('position', new THREE.BufferAttribute(v, 3));
  geom.setIndex([
    0, 1,  1, 2,  2, 3,  3, 0,  // top outline
    0, 4,                        // diagonal belly seam
    2, 4,                        // rear vertical
    1, 4,  3, 4,                 // wing tips drop to the keel
  ]);
  return geom;
}

function makeShip(
  scene: THREE.Scene,
  physics: Physics,
  geom: THREE.BufferGeometry,
  mat: THREE.LineBasicMaterial,
  seed: number,
  x0: number,
  z0: number,
): Ship {
  const group = new THREE.Group();
  // Body quaternion drives the group directly now — no Euler order constraint.
  group.add(new THREE.LineSegments(geom, mat));
  group.position.set(x0, 4, z0);
  scene.add(group);
  const body = addShipBody(physics, x0, 4, z0);
  // Seed near-cruise forward velocity along body-forward (-Z) + 8° nose-up so
  // the wing carries weight from frame 1 (zero AoA at startup = zero lift =
  // immediate stall).
  body.setLinvel({ x: 0, y: 0, z: -5 }, true);
  body.setRotation({ x: 0.0697, y: 0, z: 0, w: 0.9976 }, true);
  return {
    group,
    body,
    heading: 0,
    pitch: 0.14, // matches the 8° initial body rotation set above
    roll: 0,
    wanderSeed: seed,
    lastTargetX: x0,
    lastTargetZ: z0,
    zWrapDelta: 0,
  };
}

export function createShips(scene: THREE.Scene, physics: Physics): Ships {
  const geometry = buildShipGeometry();
  const material = new THREE.LineBasicMaterial({ color: 0xeaffff, fog: false });
  const list = [
    makeShip(scene, physics, geometry, material, 13.7, 0, SHIP_Z_CENTER),
    makeShip(scene, physics, geometry, material, 67.3, -10, SHIP_Z_CENTER + 4),
    makeShip(scene, physics, geometry, material, 141.9, 10, SHIP_Z_CENTER - 4),
  ];
  const formation: Formation = {
    active: false, startedAt: 0, endsAt: 0, blendIn: 0, blendOut: 0,
  };
  return { list, formation, geometry, material };
}

export function activateFormation(formation: Formation, durationMs: number): void {
  if (formation.active) return;
  formation.active = true;
  formation.startedAt = performance.now();
  formation.endsAt = performance.now() + durationMs;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a: number): number {
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

export type ShipUpdateInput = {
  dt: number;
  time: number;
  level: number;
  centroid: number;
  bassEnergy: number;
  beatPulse: number;
  arrowKeys: { left: boolean; right: boolean; up: boolean; down: boolean };
};

// Reused per-frame scratch — Three.js objects are heavy to allocate.
const _q = new THREE.Quaternion();
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');
const _forward = new THREE.Vector3();
const _up = new THREE.Vector3();

/** Queue forces + torques on the ship's body. Does not advance the world or
 *  mutate body translation/rotation — those happen during world.step() and
 *  syncShipFromBody() respectively. */
export function updateShipControls(
  ship: Ship,
  idx: number,
  ships: Ship[],
  formation: Formation,
  terrain: Terrain,
  input: ShipUpdateInput,
  tracked: boolean,
): void {
  const { dt, time, centroid, bassEnergy, beatPulse, arrowKeys } = input;

  const body = ship.body;
  const tr = body.translation();
  const vel = body.linvel();

  // Attitude is *kinematic* — we don't read it from the body; ship.heading/
  // pitch/roll are our source of truth and we'll setRotation() at the end.
  const heading = ship.heading;
  const pitch = ship.pitch;
  const roll = ship.roll;

  // Build forward/up vectors from the kinematic Euler so we can compute lift,
  // thrust direction, and AoA against the current attitude. body-forward is
  // local -Z (three.js camera convention).
  _euler.set(pitch, heading, roll, 'YXZ');
  _q.setFromEuler(_euler);
  _forward.set(0, 0, -1).applyQuaternion(_q);
  _up.set(0, 1, 0).applyQuaternion(_q);

  // ----- wander target (same scheme as the previous kinematic model) -----
  let targetX: number;
  let targetZ: number;
  if (tracked) {
    // Aim at a point past the +Z bound so heading sits near π (body-forward
    // = -Z, so flying +Z means heading=π). The Z-wrap teleports the plane back
    // to −Z when it reaches the wall, so it never has to U-turn.
    const drift = terrain.noise3(time * 0.02, ship.wanderSeed, 0) * 3.0;
    targetX = clamp(drift, -SHIP_X_BOUND, SHIP_X_BOUND);
    targetZ = SHIP_Z_MAX + 8;
  } else {
    // Wander noise multipliers were halved so the target drifts slowly enough
    // for the plane to actually track it. Faster noise → constantly turning.
    const wanderX = terrain.noise3(time * 0.035, ship.wanderSeed, 0) * SHIP_X_BOUND;
    const wanderZ =
      terrain.noise3(time * 0.03, ship.wanderSeed + 100, 0) *
        (SHIP_Z_MAX - SHIP_Z_MIN) * 0.45 +
      SHIP_Z_CENTER;
    const centroidShift = (centroid - 0.5) * 2 * SHIP_X_BOUND * 0.5;
    targetX = clamp(wanderX * 0.55 + centroidShift * 0.6, -SHIP_X_BOUND, SHIP_X_BOUND);
    targetZ = clamp(wanderZ, SHIP_Z_MIN, SHIP_Z_MAX);
  }
  // Formation override — wingmen blend toward (leader + slot).
  if (idx > 0 && !tracked) {
    const blend = formation.active ? formation.blendIn : formation.blendOut;
    if (blend > 0.001) {
      const leader = ships[0];
      const slot = FORMATION_SLOTS[idx];
      const slotX = clamp(leader.lastTargetX + slot.dx, -SHIP_X_BOUND, SHIP_X_BOUND);
      const slotZ = clamp(leader.lastTargetZ + slot.dz, SHIP_Z_MIN, SHIP_Z_MAX);
      targetX = targetX + (slotX - targetX) * blend;
      targetZ = targetZ + (slotZ - targetZ) * blend;
    }
  }
  ship.lastTargetX = targetX;
  ship.lastTargetZ = targetZ;

  // ----- cruise altitude (terrain follow, no audio lift) -----
  const fwdXZmag = Math.hypot(_forward.x, _forward.z) || 1;
  const fwdXn = _forward.x / fwdXZmag;
  const fwdZn = _forward.z / fwdXZmag;
  const aheadX = tr.x + fwdXn * SHIP_LOOKAHEAD_DIST;
  const aheadZ = tr.z + fwdZn * SHIP_LOOKAHEAD_DIST;
  const tHere = bilerpHeight(terrain, tr.x, tr.z);
  const tAhead = bilerpHeight(terrain, aheadX, aheadZ);
  const cruiseY = Math.min(
    SHIP_Y_MAX,
    Math.max(Math.max(tHere, tAhead) + SHIP_CLEARANCE, SHIP_Y_MIN),
  );

  // ----- desired attitude -----
  // Bank into the turn. Bound the heading error to ±π/2 before applying gain:
  // a 180° error otherwise commands max bank instantly, and the plane barrel-
  // rolls instead of turning. With this cap the worst-case bank command is
  // (π/2)·HEADING_TO_BANK regardless of how badly the heading is off.
  const dx = targetX - tr.x;
  const dz = targetZ - tr.z;
  const desiredHeading = Math.atan2(-dx, -dz);
  const headingErr = wrapAngle(desiredHeading - heading);
  const headingErrBounded = clamp(headingErr, -Math.PI / 2, Math.PI / 2);
  let targetRoll = clamp(
    headingErrBounded * SHIP_HEADING_TO_BANK,
    -SHIP_MAX_BANK, SHIP_MAX_BANK,
  );

  // Forward airspeed (projection of velocity on body-forward). Needed for both
  // the trim calc below and the lift block further down.
  const vDotFwd = vel.x * _forward.x + vel.y * _forward.y + vel.z * _forward.z;

  // Climb/dive: targetPitch = AoA needed to balance gravity at current speed
  //              + proportional altitude correction
  //              − phugoid damper (vertical-velocity feedback).
  // The trim term is what makes level flight possible: at altErr=0 the plane
  // still needs positive AoA to generate enough lift to cancel gravity. Solve
  // K_lift · CL_slope · α · v² = g for α. Cap v² to avoid huge α at low speed
  // (where the plane is going to stall anyway).
  const vFwdSqClamped = Math.max(4, vDotFwd * vDotFwd);
  const aoaTrim = SHIP_GRAVITY / (SHIP_LIFT_K * SHIP_CL_SLOPE * vFwdSqClamped);
  const altErr = cruiseY - tr.y;
  let targetPitch = clamp(
    aoaTrim + altErr * SHIP_ALT_TO_PITCH - vel.y * SHIP_PITCH_VY_DAMP,
    -SHIP_MAX_PITCH, SHIP_MAX_PITCH,
  );

  // Pilot override — only when tracked (chase/cockpit modes).
  if (tracked) {
    const rollCmd = (arrowKeys.left ? 1 : 0) - (arrowKeys.right ? 1 : 0);
    const pitchCmd = (arrowKeys.up ? 1 : 0) - (arrowKeys.down ? 1 : 0);
    if (rollCmd !== 0) targetRoll = rollCmd * SHIP_MAX_BANK;
    if (pitchCmd !== 0) targetPitch = pitchCmd * SHIP_MAX_PITCH;
  }

  // ----- forces -----
  // Thrust along body-forward, audio-modulated.
  const thrust = SHIP_THRUST_BASE
    + bassEnergy * SHIP_THRUST_BOOST
    + beatPulse * SHIP_THRUST_BEAT;
  const speed3 = Math.hypot(vel.x, vel.y, vel.z);
  // Drag opposite velocity, quadratic: F = -K · |v| · v
  const dragK = SHIP_DRAG_K * speed3;

  // Lift uses an AoA-bounded CL — the previous K·|v|² along body-up generated
  // runaway lift at any speed above cruise. Here:
  //   AoA = angle from velocity to body-forward, in the body's pitch plane.
  //         Positive AoA = nose above the airflow (typical for level cruise).
  //   CL  = clamp(slope · AoA, ±CL_MAX) — linear up to stall, then saturated.
  //   |L| = K_lift · CL · |v|², direction along body-up.
  // Self-limits: as the plane climbs, the velocity vector rotates up, AoA
  // shrinks, CL shrinks → the plane can't keep accelerating skyward.
  let liftMag = 0;
  if (vDotFwd > 0.5) {
    const vDotUp = vel.x * _up.x + vel.y * _up.y + vel.z * _up.z;
    const aoa = Math.atan2(-vDotUp, vDotFwd);
    const CL = clamp(aoa * SHIP_CL_SLOPE, -SHIP_CL_MAX, SHIP_CL_MAX);
    // Lift uses *forward* airspeed only — if the plane is moving vertically
    // (e.g. mid-bounce), |v| would be large but the wing isn't generating
    // lift against the airflow direction. v_forward² also self-zeros when
    // the plane is going backwards (vDotFwd < 0).
    const liftCap = 1.5 * SHIP_GRAVITY;
    liftMag = clamp(SHIP_LIFT_K * CL * vDotFwd * vDotFwd, -liftCap, liftCap);
  }

  body.addForce(
    {
      x: _forward.x * thrust - dragK * vel.x + _up.x * liftMag,
      y: _forward.y * thrust - dragK * vel.y + _up.y * liftMag,
      z: _forward.z * thrust - dragK * vel.z + _up.z * liftMag,
    },
    true,
  );

  // ----- kinematic attitude -----
  // Heading follows the *velocity vector* so the mesh always points where the
  // plane is actually moving — no more visual strafing. Banking still turns
  // the plane: rolled lift produces sideways force → velocity acquires a
  // sideways component → heading swings to match. The autopilot's heading
  // error feeds the roll command (above), not yaw directly. Pitch and roll
  // lerp toward their autopilot targets as before.
  const hvel = Math.hypot(vel.x, vel.z);
  if (hvel > 0.5) {
    // body-forward is -Z. atan2(-vx, -vz) is the yaw whose body-forward axis
    // points along the velocity vector.
    const velHeading = Math.atan2(-vel.x, -vel.z);
    const headingLerp = 1 - Math.exp(-SHIP_YAW_RATE * dt);
    ship.heading = wrapAngle(heading + wrapAngle(velHeading - heading) * headingLerp);
  }
  const pitchLerp = 1 - Math.exp(-SHIP_PITCH_LERP * dt);
  const rollLerp = 1 - Math.exp(-SHIP_ROLL_LERP * dt);
  ship.pitch = pitch + (targetPitch - pitch) * pitchLerp;
  ship.roll = roll + (targetRoll - roll) * rollLerp;

  _euler.set(ship.pitch, ship.heading, ship.roll, 'YXZ');
  _q.setFromEuler(_euler);
  body.setRotation({ x: _q.x, y: _q.y, z: _q.z, w: _q.w }, true);
  // Zero angVel so any residual angular motion from physics resolution can't
  // accumulate — rotation is fully kinematic.
  body.setAngvel({ x: 0, y: 0, z: 0 }, true);

  ship.zWrapDelta = 0;
}

/** Post-step: copy body state into the Three.js group, enforce terrain floor
 *  and X / Z bounds, refresh the cached heading. */
export function syncShipFromBody(
  ship: Ship,
  terrain: Terrain,
  tracked: boolean,
): void {
  const body = ship.body;
  let tr = body.translation();

  // Hard terrain clearance: clamp up and bleed any downward velocity.
  const tSafe = bilerpHeight(terrain, tr.x, tr.z);
  if (tr.y < tSafe + SHIP_HARD_CLEAR) {
    body.setTranslation({ x: tr.x, y: tSafe + SHIP_HARD_CLEAR, z: tr.z }, false);
    const v = body.linvel();
    if (v.y < 0) body.setLinvel({ x: v.x, y: 0, z: v.z }, false);
    tr = body.translation();
  }

  // X bounds: clamp + zero outward velocity (soft wall).
  if (tr.x > SHIP_X_BOUND) {
    body.setTranslation({ x: SHIP_X_BOUND, y: tr.y, z: tr.z }, false);
    const v = body.linvel();
    if (v.x > 0) body.setLinvel({ x: 0, y: v.y, z: v.z }, false);
    tr = body.translation();
  } else if (tr.x < -SHIP_X_BOUND) {
    body.setTranslation({ x: -SHIP_X_BOUND, y: tr.y, z: tr.z }, false);
    const v = body.linvel();
    if (v.x < 0) body.setLinvel({ x: 0, y: v.y, z: v.z }, false);
    tr = body.translation();
  }

  // Z handling: tracked wraps front↔back (the chase camera reads zWrapDelta);
  // untracked clamps so wandering ships don't pop across the screen.
  if (tracked) {
    const wrapSpan = SHIP_Z_MAX - SHIP_Z_MIN;
    if (tr.z < SHIP_Z_MIN) {
      body.setTranslation({ x: tr.x, y: tr.y, z: tr.z + wrapSpan }, true);
      ship.zWrapDelta = wrapSpan;
      tr = body.translation();
    } else if (tr.z > SHIP_Z_MAX) {
      body.setTranslation({ x: tr.x, y: tr.y, z: tr.z - wrapSpan }, true);
      ship.zWrapDelta = -wrapSpan;
      tr = body.translation();
    }
  } else {
    if (tr.z > SHIP_Z_MAX) {
      body.setTranslation({ x: tr.x, y: tr.y, z: SHIP_Z_MAX }, false);
      const v = body.linvel();
      if (v.z > 0) body.setLinvel({ x: v.x, y: v.y, z: 0 }, false);
      tr = body.translation();
    } else if (tr.z < SHIP_Z_MIN) {
      body.setTranslation({ x: tr.x, y: tr.y, z: SHIP_Z_MIN }, false);
      const v = body.linvel();
      if (v.z < 0) body.setLinvel({ x: v.x, y: v.y, z: 0 }, false);
      tr = body.translation();
    }
  }

  // Sync the Three.js visual transform. Rotation comes from the kinematic
  // Euler set in updateShipControls; we don't read body.rotation() because
  // that's just the same value we wrote there.
  const rot = body.rotation();
  ship.group.position.set(tr.x, tr.y, tr.z);
  ship.group.quaternion.set(rot.x, rot.y, rot.z, rot.w);
}

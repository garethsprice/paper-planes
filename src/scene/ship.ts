// Asteroids-style triangle ships with a simple flight model. Each frame:
// pick a wandering target (audio centroid + slow simplex noise), rotate
// heading toward it at a limited turn rate, accelerate speed toward
// (base + bass*boost), integrate position with dt, then bank/pitch from
// turn-input and climb-rate. Three.js Euler order 'YXZ' = aircraft yaw→pitch→roll.

import * as THREE from 'three';
import {
  SHIP_X_BOUND, SHIP_Z_MIN, SHIP_Z_MAX, SHIP_Z_CENTER,
  SHIP_Y_MIN, SHIP_Y_MAX, SHIP_CLEARANCE, SHIP_HARD_CLEAR,
  SHIP_LOOKAHEAD_DIST, SHIP_BASE_SPEED, SHIP_SPEED_BOOST,
  SHIP_ACCEL_RATE, SHIP_TURN_RATE, SHIP_TURN_GAIN, SHIP_TURN_SLOWDOWN,
  SHIP_MAX_BANK, SHIP_MAX_PITCH, SHIP_PITCH_GAIN,
  FORMATION_SLOTS,
} from '../constants.ts';
import { bilerpHeight, type Terrain } from './terrain.ts';

export type Ship = {
  group: THREE.Group;
  heading: number;
  speed: number;
  pitch: number;
  roll: number;
  prevY: number;
  wanderSeed: number;
  /** Last frame's chosen target — wingmen read the leader's value during formation. */
  lastTargetX: number;
  lastTargetZ: number;
  /** Z teleport applied this frame by the tracked-ship wrap-forward logic.
   *  The chase camera adds this to its position before the lerp so the framing
   *  doesn't jolt when the ship hops front↔back of the play area. */
  zWrapDelta: number;
};

export type Formation = {
  active: boolean;
  startedAt: number;
  endsAt: number;
  blendIn: number;  // 0..1, eased over ~0.6s on enter
  blendOut: number; // 1..0, eased over ~0.8s on exit
};

export type Ships = {
  list: Ship[];
  formation: Formation;
  geometry: THREE.BufferGeometry;
  material: THREE.LineBasicMaterial;
};

function buildShipGeometry(): THREE.BufferGeometry {
  // Wedge with a sharp nose: triangle on top, single keel-tail vertex at
  // the back-bottom; diagonal belly seam runs nose → keel-tail. Reads as
  // an arrowhead from any angle.
  const geom = new THREE.BufferGeometry();
  const s = 1.1;
  const k = 0.7; // back-keel depth
  const v = new Float32Array([
    0,         0,  -1.3 * s,  // 0: nose
    -0.75 * s, 0,   0.85 * s, // 1: back-left wing
    0,         0,   0.45 * s, // 2: back-notch (top of rear face)
    0.75 * s,  0,   0.85 * s, // 3: back-right wing
    0,        -k,   0.45 * s, // 4: keel-tail (bottom of rear face)
  ]);
  geom.setAttribute('position', new THREE.BufferAttribute(v, 3));
  geom.setIndex([
    0, 1,  1, 2,  2, 3,  3, 0,  // top outline
    0, 4,                       // diagonal belly seam
    2, 4,                       // rear vertical (notch ↔ keel-tail)
    1, 4,  3, 4,                // wing tips drop to the keel
  ]);
  return geom;
}

function makeShip(
  scene: THREE.Scene,
  geom: THREE.BufferGeometry,
  mat: THREE.LineBasicMaterial,
  seed: number,
  x0: number,
  z0: number,
): Ship {
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  group.add(new THREE.LineSegments(geom, mat));
  group.position.set(x0, 4, z0);
  scene.add(group);
  return {
    group,
    heading: 0,
    speed: SHIP_BASE_SPEED,
    pitch: 0,
    roll: 0,
    prevY: 4,
    wanderSeed: seed,
    lastTargetX: x0,
    lastTargetZ: z0,
    zWrapDelta: 0,
  };
}

export function createShips(scene: THREE.Scene): Ships {
  const geometry = buildShipGeometry();
  const material = new THREE.LineBasicMaterial({ color: 0xeaffff, fog: false });
  // Three ships, staggered so they don't pile up at the same point.
  const list = [
    makeShip(scene, geometry, material, 13.7, 0, SHIP_Z_CENTER),
    makeShip(scene, geometry, material, 67.3, -10, SHIP_Z_CENTER + 4),
    makeShip(scene, geometry, material, 141.9, 10, SHIP_Z_CENTER - 4),
  ];
  const formation: Formation = {
    active: false,
    startedAt: 0,
    endsAt: 0,
    blendIn: 0,
    blendOut: 0,
  };
  return { list, formation, geometry, material };
}

/** Lock all three ships into a delta formation centered on the leader's
 *  wander target, hold for `durationMs`, then disperse. */
export function activateFormation(formation: Formation, durationMs: number): void {
  if (formation.active) return; // don't restart mid-pass
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

/** Advance a single ship one frame; tracked=true relaxes wander and gives
 *  the player joystick override on heading + altitude. */
export function updateShip(
  ship: Ship,
  idx: number,
  ships: Ship[],
  formation: Formation,
  terrain: Terrain,
  input: ShipUpdateInput,
  tracked: boolean,
): void {
  const { dt, time, level, centroid, bassEnergy, beatPulse, arrowKeys } = input;
  const pos = ship.group.position;
  // Tracked ship flies calmer (relaxed turn rate + bank). 0.4 strikes a
  // balance — initial 180° turn settles in ~4s, then heading barely moves
  // because the target is nearly aligned.
  const turnScale = tracked ? 0.4 : 1.0;
  const bankScale = tracked ? 0.4 : 1.0;
  let targetX: number;
  let targetZ: number;
  if (tracked) {
    // World-frame forward target: aim toward +Z, where new spectrogram peaks
    // emerge — flying +Z makes terrain rush toward the ship (proper "flying
    // forward" sensation; -Z would let terrain overtake and look reverse).
    // Wrap-back (further down) teleports the ship from the back to the
    // front of the play area so it never has to U-turn.
    const drift = terrain.noise3(time * 0.04, ship.wanderSeed, 0) * 3.0;
    targetX = clamp(drift, -SHIP_X_BOUND, SHIP_X_BOUND);
    targetZ = SHIP_Z_MAX + 8; // outside the bounds so heading stays near π
  } else {
    // wandering target — slow simplex noise + audio centroid pull
    const wanderX = terrain.noise3(time * 0.07, ship.wanderSeed, 0) * SHIP_X_BOUND;
    const wanderZ =
      terrain.noise3(time * 0.06, ship.wanderSeed + 100, 0) *
        (SHIP_Z_MAX - SHIP_Z_MIN) * 0.45 +
      SHIP_Z_CENTER;
    const centroidShift = (centroid - 0.5) * 2 * SHIP_X_BOUND * 0.5;
    targetX = clamp(wanderX * 0.55 + centroidShift * 0.6, -SHIP_X_BOUND, SHIP_X_BOUND);
    targetZ = clamp(wanderZ, SHIP_Z_MIN, SHIP_Z_MAX);
  }

  // formation override — wingmen blend their target toward (leader + slot).
  // Skip when this ship is being tracked: formation snaps cause sharp turns.
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

  // heading toward target — autopilot, unless the player is steering with
  // the arrow keys in chase/cockpit mode.
  const playerYaw = tracked
    ? (arrowKeys.left ? 1 : 0) - (arrowKeys.right ? 1 : 0)
    : 0;
  let turnInput: number;
  if (playerYaw !== 0) {
    // Joystick: full-rate yaw. Bank still feels gentle because bankScale
    // is 0.4 in tracked mode.
    turnInput = playerYaw;
    ship.heading = wrapAngle(ship.heading + turnInput * SHIP_TURN_RATE * dt);
  } else {
    const dx = targetX - pos.x;
    const dz = targetZ - pos.z;
    const dist = Math.hypot(dx, dz);
    let desiredHeading = ship.heading;
    if (dist > 0.5) desiredHeading = Math.atan2(-dx, -dz);
    const headingErr = wrapAngle(desiredHeading - ship.heading);
    turnInput = clamp(headingErr * SHIP_TURN_GAIN * turnScale, -1, 1);
    ship.heading = wrapAngle(ship.heading + turnInput * SHIP_TURN_RATE * turnScale * dt);
  }

  // speed
  let targetSpeed: number;
  if (tracked) {
    // Spring along forward direction toward home — works whichever way the
    // player has steered. Speed can briefly go negative when the ship has
    // overshot home in its facing direction (oscillates around home without
    // ever needing a U-turn or a wrap).
    const TRACKED_HOME_X = 0;
    const TRACKED_HOME_Z = SHIP_Z_CENTER;
    const fwdX_now = -Math.sin(ship.heading);
    const fwdZ_now = -Math.cos(ship.heading);
    const homeAhead =
      (TRACKED_HOME_X - pos.x) * fwdX_now +
      (TRACKED_HOME_Z - pos.z) * fwdZ_now;
    const SPRING = 0.85;
    const audioBoost = bassEnergy * 8 + beatPulse * 3;
    targetSpeed = homeAhead * SPRING + audioBoost;
  } else {
    targetSpeed = SHIP_BASE_SPEED + bassEnergy * SHIP_SPEED_BOOST;
  }
  ship.speed += (targetSpeed - ship.speed) * SHIP_ACCEL_RATE * dt;
  const effSpeed = tracked
    ? ship.speed
    : ship.speed * (1 - SHIP_TURN_SLOWDOWN * Math.abs(turnInput))
      * (1 + beatPulse * 0.45);

  // integrate position
  const fwdX = -Math.sin(ship.heading);
  const fwdZ = -Math.cos(ship.heading);
  pos.x = clamp(pos.x + fwdX * effSpeed * dt, -SHIP_X_BOUND, SHIP_X_BOUND);
  pos.z = pos.z + fwdZ * effSpeed * dt;
  // Tracked ship wraps Z front-to-back; chase camera shifts by zWrapDelta to
  // avoid a framing jolt. Untracked ships clamp to the bounds.
  ship.zWrapDelta = 0;
  if (tracked) {
    const wrapSpan = SHIP_Z_MAX - SHIP_Z_MIN;
    if (pos.z < SHIP_Z_MIN) {
      pos.z += wrapSpan;
      ship.zWrapDelta = wrapSpan;
    } else if (pos.z > SHIP_Z_MAX) {
      pos.z -= wrapSpan;
      ship.zWrapDelta = -wrapSpan;
    }
  } else {
    pos.z = clamp(pos.z, SHIP_Z_MIN, SHIP_Z_MAX);
  }

  // altitude — terrain follow + audio lift, with optional pilot pitch bias
  const aheadX = pos.x + fwdX * SHIP_LOOKAHEAD_DIST;
  const aheadZ = pos.z + fwdZ * SHIP_LOOKAHEAD_DIST;
  const tHere = bilerpHeight(terrain, pos.x, pos.z);
  const tAhead = bilerpHeight(terrain, aheadX, aheadZ);
  const audioLift = level * 3.0;
  let targetY = Math.max(Math.max(tHere, tAhead) + SHIP_CLEARANCE, SHIP_Y_MIN + audioLift);
  if (tracked) {
    const playerPitch = (arrowKeys.up ? 1 : 0) - (arrowKeys.down ? 1 : 0);
    targetY += playerPitch * 5;
  }
  targetY = Math.min(SHIP_Y_MAX, targetY);
  ship.prevY = pos.y;
  pos.y += (targetY - pos.y) * (1 - Math.exp(-6 * dt));
  const tSafe = bilerpHeight(terrain, pos.x, pos.z);
  if (pos.y < tSafe + SHIP_HARD_CLEAR) pos.y = tSafe + SHIP_HARD_CLEAR;

  // orientation
  const climbRate = (pos.y - ship.prevY) / Math.max(dt, 1e-3);
  const targetRoll = turnInput * SHIP_MAX_BANK * bankScale;
  const targetPitch = clamp(climbRate * SHIP_PITCH_GAIN, -SHIP_MAX_PITCH, SHIP_MAX_PITCH);
  const orientLerp = 1 - Math.exp(-7 * dt);
  ship.roll += (targetRoll - ship.roll) * orientLerp;
  ship.pitch += (targetPitch - ship.pitch) * orientLerp;
  ship.group.rotation.set(ship.pitch, ship.heading, ship.roll);
}

// Kinematic coordinated-flight model in the landscape's reference frame.
//
// The spectrogram streams toward −Z one grid row per frame, so the ground is
// a conveyor. A plane's velocity over that ground must equal its airspeed
// vector — so each frame a ship moves along its nose by speed·dt *and* is
// carried −Z by exactly one row. To hold station it flies into the flow (+Z)
// at airspeed ≈ flow; it cannot circle (it would be swept away) and every
// visible motion is the physical consequence of bank, pitch and throttle:
//   bank → coordinated turn (ω = g·tan φ / v) → heading deviates → lateral drift
//   pitch → climb/dive along the path (dives speed up, climbs bleed speed)
//   throttle → surge forward / fall back against the flow
//
// Per frame, updateShip():
//   1. picks a wander/formation target (noise + spectral centroid),
//   2. commands bank from lateral guidance, pitch from altitude error,
//      airspeed from Z station-keeping plus the music,
//   3. eases roll/pitch/speed toward those commands (rate-limited, first-order),
//   4. integrates heading, position (nose motion − flow advection),
//   5. enforces the terrain floor and X/Z bounds, and writes the mesh transform.

import * as THREE from 'three';
import {
  SHIP_X_BOUND, SHIP_Z_MIN, SHIP_Z_MAX, SHIP_Z_CENTER,
  SHIP_Y_MIN, SHIP_Y_MAX, SHIP_CLEARANCE, SHIP_HARD_CLEAR,
  SHIP_LOOKAHEAD_DIST,
  SHIP_MAX_BANK, SHIP_MAX_PITCH,
  SHIP_SURGE_Z_GAIN, SHIP_SURGE_MAX, SHIP_SURGE_BASS, SHIP_SURGE_BEAT,
  SHIP_SPEED_LERP, SHIP_SPEED_MIN, SHIP_GRAVITY_PATH, SHIP_TURN_G,
  SHIP_LAT_GAIN, SHIP_LAT_MAX, SHIP_HEADING_TO_BANK, SHIP_YAW_DAMP,
  SHIP_ROLL_RATE, SHIP_ROLL_LERP, SHIP_PITCH_LERP,
  SHIP_ALT_GAIN, SHIP_VY_MAX, SHIP_ALT_WANDER, SHIP_VISUAL_AOA,
  SHIP_ENVELOPE_RISE, SHIP_ENVELOPE_SINK,
  SHIP_ACCEL_TO_PITCH, SHIP_ACCEL_TO_NOSE, SHIP_ACCEL_SMOOTH_S,
  TERRAIN_ROW_SPACING,
  FORMATION_SLOTS, SHIP_MAX,
  FLOCK_JOIN_SURGE, FLOCK_LEAVE_DROP, FLOCK_FADE_S,
  MOOD_FLOCK_TIGHTEN, MOOD_FLOCK_LIFT, MOOD_SCATTER_S, MOOD_DIVE_S, MOOD_DIVE_PITCH,
  TRAIL_LOAD_SMOOTH_S, SUN_SHIP_RIM,
} from '../constants.ts';
import { bilerpHeight, type Terrain } from './terrain.ts';

/** Flock membership. dormant ships are hidden and skipped; joining ships
 *  surge in from behind; leaving ships throttle back, bank outward and
 *  fade as the landscape carries them away. */
export type ShipPhase = 'dormant' | 'joining' | 'active' | 'leaving';

export type Ship = {
  group: THREE.Group;
  phase: ShipPhase;
  /** 0..1 opacity, eased during join/leave. */
  fade: number;
  /** Which way (±X) a leaving ship peels away. */
  leaveSide: number;
  edgeMaterial: THREE.LineBasicMaterial;
  panelMaterial: THREE.MeshBasicMaterial;
  /** Yaw (rad). Body-forward is local −Z, so heading π flies into the flow (+Z). */
  heading: number;
  /** Flight-path angle (rad), positive = climbing. */
  pitch: number;
  /** Bank (rad), positive = left wing down = turning left (heading increases). */
  roll: number;
  /** Airspeed along the nose (world units / s). */
  speed: number;
  /** Smoothed along-path acceleration (u/s²) — pitches the nose. */
  accel: number;
  /** 0..1 aerodynamic load (bank g, acceleration, dive) — drives vapour. */
  load: number;
  /** Drop response: a lateral scatter target that holds until scatterUntil,
   *  and a nose-down dive until diveUntil (both absolute seconds). */
  scatterX: number;
  scatterUntil: number;
  diveUntil: number;
  /** Slow-relaxing cruise altitude: rises quickly onto a loud passage's
   *  terrain envelope, sinks gently after it. See updateShip. */
  cruiseY: number;
  wanderSeed: number;
  /** Last frame's wander target — wingmen read the leader's value during formation. */
  lastTargetX: number;
  lastTargetZ: number;
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
  panelGeometry: THREE.BufferGeometry;
};

// Shared wedge vertices — the edge outline and the paper panels index into
// the same five points.
const SHIP_VERTS = new Float32Array([
   0,      0,   -1.6,   // 0: nose tip — long, prominent
  -0.65,   0,    0.6,   // 1: back-left wing tip
   0,      0,    0.3,   // 2: back-notch (top of rear face)
   0.65,   0,    0.6,   // 3: back-right wing tip
   0,     -0.5,  0.3,   // 4: keel-tail (bottom of rear face)
]);

function buildShipGeometry(): THREE.BufferGeometry {
  // Long sharp nose at local −Z (three.js camera convention: body_forward =
  // (0,0,−1)). Wings are short and swept back so the silhouette unambiguously
  // points forward.
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(SHIP_VERTS, 3));
  geom.setIndex([
    0, 1,  1, 2,  2, 3,  3, 0,  // top outline
    0, 4,                        // diagonal belly seam
    2, 4,                        // rear vertical
    1, 4,  3, 4,                 // wing tips drop to the keel
  ]);
  return geom;
}

/** Translucent paper panels filling the wedge. Their only job is
 *  legibility: a bare wireframe plane vanishes against the bright grid
 *  behind it, whereas a dim, slightly see-through body occludes the lines
 *  and gives the eye a silhouette — like frosted paper against neon. */
function buildShipPanels(): THREE.BufferGeometry {
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(SHIP_VERTS, 3));
  geom.setIndex([
    0, 1, 2,  0, 2, 3,   // top wing surfaces
    0, 4, 1,  0, 3, 4,   // belly panels down to the keel
    1, 4, 2,  2, 4, 3,   // rear face
  ]);
  return geom;
}

function makeShip(
  scene: THREE.Scene,
  geom: THREE.BufferGeometry,
  panelGeom: THREE.BufferGeometry,
  seed: number,
  x0: number,
  z0: number,
  present: boolean,
): Ship {
  // Materials are per ship so each can fade independently. Edges: glowing
  // near-white. Panels: deep blue-black, mostly opaque, depthWrite on so
  // grid lines behind the body are hidden rather than blended through;
  // added first so the outline always draws on top.
  const edgeMaterial = new THREE.LineBasicMaterial({
    color: 0xeaffff, fog: false, transparent: true, opacity: present ? 1 : 0,
  });
  const panelMaterial = new THREE.MeshBasicMaterial({
    color: 0x0b1024,
    transparent: true,
    opacity: present ? 0.82 : 0,
    side: THREE.DoubleSide,
    fog: false,
  });
  const group = new THREE.Group();
  group.add(new THREE.Mesh(panelGeom, panelMaterial));
  group.add(new THREE.LineSegments(geom, edgeMaterial));
  group.position.set(x0, 4, z0);
  group.visible = present;
  scene.add(group);
  return {
    group,
    phase: present ? 'active' : 'dormant',
    fade: present ? 1 : 0,
    leaveSide: 1,
    edgeMaterial,
    panelMaterial,
    heading: Math.PI, // nose into the flow
    pitch: 0,
    roll: 0,
    speed: 20,
    accel: 0,
    load: 0,
    scatterX: 0,
    scatterUntil: -Infinity,
    diveUntil: -Infinity,
    cruiseY: 4,
    wanderSeed: seed,
    lastTargetX: x0,
    lastTargetZ: z0,
  };
}

/** All SHIP_MAX ships are created up front; only the leader starts present.
 *  The flock controller (scene/flock.ts) wakes and retires the rest. */
export function createShips(scene: THREE.Scene): Ships {
  const geometry = buildShipGeometry();
  const panelGeometry = buildShipPanels();
  const list = Array.from({ length: SHIP_MAX }, (_, i) =>
    makeShip(scene, geometry, panelGeometry, 13.7 + i * 53.6, 0, SHIP_Z_CENTER, i === 0),
  );
  const formation: Formation = {
    active: false, startedAt: 0, endsAt: 0, blendIn: 0, blendOut: 0,
  };
  return { list, formation, geometry, panelGeometry };
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
  /** Ground flow speed (u/s) — how fast the landscape streams past. */
  groundFlow: number;
  level: number;
  centroid: number;
  bassEnergy: number;
  beatPulse: number;
  /** 0..1 build anticipation — tightens and lifts the flock. */
  anticipation: number;
  arrowKeys: { left: boolean; right: boolean; up: boolean; down: boolean };
};

const _up = new THREE.Vector3();
const SHIP_EDGE_BASE = new THREE.Color(0xeaffff);

/** Rim light from the horizon sun: the wing surface facing the light
 *  brightens and warms, so a banking plane visibly turns toward or away
 *  from it. Lines have no normals, so the wing's up vector stands in. */
export function applyShipLighting(
  ship: Ship,
  lightDir: THREE.Vector3,
  sunColor: THREE.Color,
  sun: number,
): void {
  if (ship.phase === 'dormant') return;
  _up.set(0, 1, 0).applyQuaternion(ship.group.quaternion);
  const facing = Math.max(0, _up.dot(lightDir) * 0.5 + 0.5);
  const k = facing * facing * sun * SUN_SHIP_RIM;
  const c = ship.edgeMaterial.color;
  c.copy(SHIP_EDGE_BASE).multiplyScalar(0.85 + k * 0.6);
  c.lerp(sunColor, k * 0.6);
}

/** Fire the drop response on a ship: scatter sideways and dive. */
export function scatterShip(ship: Ship, time: number, lateral: number): void {
  ship.scatterX = lateral;
  ship.scatterUntil = time + MOOD_SCATTER_S;
  ship.diveUntil = time + MOOD_DIVE_S;
}

// Reused per-frame scratch — Three.js objects are heavy to allocate.
const _euler = new THREE.Euler(0, 0, 0, 'YXZ');

/** Advance one ship by dt and write its mesh transform. Ships must be
 *  updated in index order: wingmen read the leader's target from this frame.
 *  `piloted` ships (chase/cockpit) accept arrow-key overrides and skip
 *  formation so the stick is never fought. */
export function updateShip(
  ship: Ship,
  idx: number,
  ships: Ship[],
  formation: Formation,
  terrain: Terrain,
  input: ShipUpdateInput,
  piloted: boolean,
): void {
  if (ship.phase === 'dormant') return;
  const { dt, time, groundFlow, centroid, bassEnergy, beatPulse, anticipation, arrowKeys } = input;
  const p = ship.group.position;
  const leaving = ship.phase === 'leaving';

  // ----- wander target -----
  // Slow noise so the target drifts gently enough for the plane to actually
  // settle on it — faster noise means the plane is forever mid-correction.
  const wanderX = terrain.noise3(time * 0.035, ship.wanderSeed, 0) * SHIP_X_BOUND;
  const wanderZ =
    terrain.noise3(time * 0.03, ship.wanderSeed + 100, 0) *
      (SHIP_Z_MAX - SHIP_Z_MIN) * 0.45 +
    SHIP_Z_CENTER;
  const centroidShift = (centroid - 0.5) * 2 * SHIP_X_BOUND * 0.5;
  let targetX = clamp(wanderX * 0.55 + centroidShift * 0.6, -SHIP_X_BOUND, SHIP_X_BOUND);
  let targetZ = clamp(wanderZ, SHIP_Z_MIN, SHIP_Z_MAX);
  // Formation override — wingmen blend toward (leader + slot). A build
  // pulls the flock into formation on its own, so the drop has something
  // to break.
  if (idx > 0 && !piloted && ship.phase === 'active') {
    const blend = Math.max(
      formation.active ? formation.blendIn : formation.blendOut,
      anticipation * MOOD_FLOCK_TIGHTEN,
    );
    if (blend > 0.001) {
      const leader = ships[0];
      const slot = FORMATION_SLOTS[idx];
      const slotX = clamp(leader.lastTargetX + slot.dx, -SHIP_X_BOUND, SHIP_X_BOUND);
      const slotZ = clamp(leader.lastTargetZ + slot.dz, SHIP_Z_MIN, SHIP_Z_MAX);
      targetX = targetX + (slotX - targetX) * blend;
      targetZ = targetZ + (slotZ - targetZ) * blend;
    }
  }
  // The drop scatters the flock: each plane holds a sideways target for a
  // few seconds, fading back to its wander.
  if (time < ship.scatterUntil) {
    const w = Math.min(1, (ship.scatterUntil - time) / MOOD_SCATTER_S * 1.5);
    targetX = clamp(targetX + ship.scatterX * w, -SHIP_X_BOUND, SHIP_X_BOUND);
  }
  // A leaving plane aims well outside the box so it banks away from the
  // flock; a joining one simply chases its normal target from behind.
  if (leaving) targetX = ship.leaveSide * (SHIP_X_BOUND + 14);
  ship.lastTargetX = targetX;
  ship.lastTargetZ = targetZ;

  // ----- bank command from lateral guidance -----
  // Desired sideways speed from X error, turned into a heading deviation
  // from straight-into-the-flow. Bank is commanded from the heading error,
  // damped on the current turn rate so it rolls out before the heading
  // arrives rather than sailing through it.
  const turnRate = (SHIP_TURN_G / ship.speed) * Math.tan(ship.roll);
  const vxDes = clamp((targetX - p.x) * SHIP_LAT_GAIN, -SHIP_LAT_MAX, SHIP_LAT_MAX);
  const vzAir = Math.sqrt(Math.max(1, ship.speed * ship.speed - vxDes * vxDes));
  const desiredHeading = Math.atan2(-vxDes, -vzAir);
  const headingErr = wrapAngle(desiredHeading - ship.heading);
  let targetRoll = clamp(
    (headingErr - turnRate * SHIP_YAW_DAMP) * SHIP_HEADING_TO_BANK,
    -SHIP_MAX_BANK, SHIP_MAX_BANK,
  );

  // ----- pitch command from altitude error -----
  // The terrain streams past far faster than the plane could ever contour
  // it, so the plane rides a slow *envelope*: the highest terrain in a patch
  // ahead and to either side, which cruiseY climbs onto quickly and sinks
  // away from gently. Loud passages lift the whole flight; quiet ones let it
  // drift back down to skim the grid. A slow noise offset keeps the line
  // from going flat.
  const fwdX = -Math.sin(ship.heading);
  const fwdZ = -Math.cos(ship.heading);
  const rightX = fwdZ;
  const rightZ = -fwdX;
  let envelope = -Infinity;
  for (let i = 0; i <= 4; i++) {
    const ax = p.x + fwdX * SHIP_LOOKAHEAD_DIST * i * 0.25;
    const az = p.z + fwdZ * SHIP_LOOKAHEAD_DIST * i * 0.25;
    for (let side = -1; side <= 1; side++) {
      const h = bilerpHeight(terrain, ax + rightX * side * 2, az + rightZ * side * 2);
      if (h > envelope) envelope = h;
    }
  }
  const altWander = terrain.noise3(time * 0.05, ship.wanderSeed + 200, 0) * SHIP_ALT_WANDER;
  // A build lifts the whole flock; the drop lets it dive back down.
  const lift = anticipation * MOOD_FLOCK_LIFT;
  const envelopeY = clamp(envelope + SHIP_CLEARANCE + altWander + lift, SHIP_Y_MIN, SHIP_Y_MAX + lift);
  if (envelopeY > ship.cruiseY) {
    ship.cruiseY += (envelopeY - ship.cruiseY) * (1 - Math.exp(-SHIP_ENVELOPE_RISE * dt));
  } else {
    ship.cruiseY = Math.max(envelopeY, ship.cruiseY - SHIP_ENVELOPE_SINK * dt);
  }
  // Command a vertical *speed* proportional to the error, then the path
  // angle that produces it at the current airspeed. Because the loop is
  // closed on velocity (not on pitch directly) it settles without a phugoid.
  const vyDes = clamp((ship.cruiseY - p.y) * SHIP_ALT_GAIN, -SHIP_VY_MAX, SHIP_VY_MAX);
  let targetPitch = clamp(
    Math.asin(clamp(vyDes / ship.speed, -0.9, 0.9)),
    -SHIP_MAX_PITCH, SHIP_MAX_PITCH,
  );

  // ----- airspeed command -----
  // Cruise at the ground flow (station), surge to close Z error, and let the
  // music push: bass drives the flock forward, a beat gives a nudge.
  const surge = clamp((targetZ - p.z) * SHIP_SURGE_Z_GAIN, -SHIP_SURGE_MAX, SHIP_SURGE_MAX);
  let speedCmd = groundFlow + surge + bassEnergy * SHIP_SURGE_BASS + beatPulse * SHIP_SURGE_BEAT;
  // Arrivals catch up hard from behind; departures shed speed and lift
  // their nose so the flow carries them up and away.
  if (ship.phase === 'joining') speedCmd += FLOCK_JOIN_SURGE;
  if (leaving) {
    speedCmd = groundFlow - FLOCK_LEAVE_DROP;
    targetPitch = clamp(targetPitch + 0.12, -SHIP_MAX_PITCH, SHIP_MAX_PITCH);
  }

  // Drop dive: nose down for a beat, then the altitude hold recovers.
  if (time < ship.diveUntil) {
    targetPitch = clamp(targetPitch - MOOD_DIVE_PITCH, -SHIP_MAX_PITCH, SHIP_MAX_PITCH);
  }

  // Pilot override — only when tracked (chase/cockpit modes).
  if (piloted) {
    const rollCmd = (arrowKeys.left ? 1 : 0) - (arrowKeys.right ? 1 : 0);
    const pitchCmd = (arrowKeys.up ? 1 : 0) - (arrowKeys.down ? 1 : 0);
    if (rollCmd !== 0) targetRoll = rollCmd * SHIP_MAX_BANK;
    if (pitchCmd !== 0) targetPitch = pitchCmd * SHIP_MAX_PITCH;
  }

  // ----- acceleration → nose -----
  // Speed eases toward the command; gravity along the path adds the
  // paper-plane feel — dives pick up pace, climbs bleed it. The resulting
  // acceleration is smoothed and fed back into pitch: accelerating drops
  // the nose (the plane dives for its speed), decelerating flares it up.
  const accelRaw =
    (speedCmd - ship.speed) * SHIP_SPEED_LERP - SHIP_GRAVITY_PATH * Math.sin(ship.pitch);
  ship.accel += (accelRaw - ship.accel) * (1 - Math.exp(-dt / SHIP_ACCEL_SMOOTH_S));
  targetPitch = clamp(
    targetPitch - ship.accel * SHIP_ACCEL_TO_PITCH,
    -SHIP_MAX_PITCH, SHIP_MAX_PITCH,
  );

  // ----- ease attitude + speed toward commands -----
  // Roll is first-order with a rate cap, so a large heading error rolls in
  // at a steady, visible pace instead of snapping to full bank.
  const rollLerp = 1 - Math.exp(-SHIP_ROLL_LERP * dt);
  const rollMaxStep = SHIP_ROLL_RATE * dt;
  ship.roll += clamp((targetRoll - ship.roll) * rollLerp, -rollMaxStep, rollMaxStep);
  const pitchLerp = 1 - Math.exp(-SHIP_PITCH_LERP * dt);
  ship.pitch += (targetPitch - ship.pitch) * pitchLerp;
  ship.speed = Math.max(SHIP_SPEED_MIN, ship.speed + accelRaw * dt);

  // Load: what the wings are working against. A coordinated turn at bank φ
  // pulls 1/cos φ g; hard acceleration and the drop dive add to it. Smoothed
  // so vapour blooms and fades rather than flickering frame to frame.
  const gLoad = 1 / Math.max(0.2, Math.cos(ship.roll)) - 1;
  const loadRaw = clamp(
    gLoad * 2.4 + Math.abs(ship.accel) * 0.05
      + (time < ship.diveUntil ? 0.7 : 0)
      + (ship.phase === 'joining' ? 0.5 : 0),
    0, 1,
  );
  ship.load += (loadRaw - ship.load) * (1 - Math.exp(-dt / TRAIL_LOAD_SMOOTH_S));

  // ----- integrate -----
  // Coordinated turn: bank → turn rate. Positive roll = left bank = heading
  // increases (body-forward −Z rotates toward −X).
  ship.heading = wrapAngle(ship.heading + turnRate * dt);
  // Nose motion plus advection: the landscape carries the plane −Z by one
  // grid row per frame, exactly as it carries the terrain.
  const cosP = Math.cos(ship.pitch);
  const step = ship.speed * dt;
  p.x += -Math.sin(ship.heading) * cosP * step;
  p.y += Math.sin(ship.pitch) * step;
  p.z += -Math.cos(ship.heading) * cosP * step - TERRAIN_ROW_SPACING;

  // ----- bounds -----
  // Hard terrain clearance: never let the keel dip into the grid. If it
  // fires, level the path angle so the plane climbs away rather than
  // scraping along the floor.
  const floorY = bilerpHeight(terrain, p.x, p.z) + SHIP_HARD_CLEAR;
  if (p.y < floorY) {
    p.y = floorY;
    if (ship.pitch < 0.08) ship.pitch = 0.08;
  }
  if (p.y > SHIP_Y_MAX + 2) p.y = SHIP_Y_MAX + 2;
  // Soft walls: guidance always steers toward an in-box target, so these
  // only trim the overshoot of a wide correction (or a pilot's excursion).
  // Arrivals and departures live outside the box by design.
  if (ship.phase === 'active') {
    p.x = clamp(p.x, -SHIP_X_BOUND, SHIP_X_BOUND);
    p.z = clamp(p.z, SHIP_Z_MIN - 4, SHIP_Z_MAX + 4);
  } else {
    p.x = clamp(p.x, -SHIP_X_BOUND - 18, SHIP_X_BOUND + 18);
  }

  // ----- phase transitions + fade -----
  if (ship.phase === 'joining') {
    ship.fade = Math.min(1, ship.fade + dt / FLOCK_FADE_S);
    if (p.z >= SHIP_Z_MIN) ship.phase = 'active';
  } else if (leaving) {
    // Hold full opacity until the plane has actually pulled away, then fade.
    const clear = Math.abs(p.x) > SHIP_X_BOUND + 2 || p.z < SHIP_Z_MIN - 6;
    if (clear) ship.fade = Math.max(0, ship.fade - dt / FLOCK_FADE_S);
    if (ship.fade <= 0 || p.z < SHIP_Z_MIN - 40) {
      ship.phase = 'dormant';
      ship.fade = 0;
      ship.group.visible = false;
    }
  }
  ship.edgeMaterial.opacity = ship.fade;
  ship.panelMaterial.opacity = 0.82 * ship.fade;

  // ----- mesh attitude -----
  // The nose rides a few degrees above the flight path (angle of attack),
  // which is what makes a gliding paper plane read as *flying* rather than
  // sliding along a rail — and it leads the acceleration: pushing forward
  // tips it down beyond the path, easing off lifts it.
  const nose = clamp(
    ship.pitch + SHIP_VISUAL_AOA - ship.accel * SHIP_ACCEL_TO_NOSE,
    -0.9, 0.9,
  );
  _euler.set(nose, ship.heading, ship.roll, 'YXZ');
  ship.group.quaternion.setFromEuler(_euler);
}

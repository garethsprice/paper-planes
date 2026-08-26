// Flock-size controller. Derives a self-normalising musical energy from the
// per-frame audio scalars and grows or shrinks the flock toward the size
// that energy asks for — one plane in quiet, SHIP_MAX at full intensity.
// Arrivals and departures are rate-limited and hysteresis-gated so the
// flock breathes with the music rather than flickering with it.

import {
  SHIP_MAX, SHIP_X_BOUND, SHIP_Z_MIN, SHIP_Y_MAX,
  FLOCK_ENERGY_RISE_S, FLOCK_ENERGY_FALL_S, FLOCK_MAX_MEMORY_S,
  FLOCK_JOIN_HOLD_S, FLOCK_LEAVE_HOLD_S,
  FLOCK_JOIN_INTERVAL_S, FLOCK_LEAVE_INTERVAL_S, FLOCK_JOIN_DIST,
} from '../constants.ts';
import type { Ship } from './ship.ts';

export type Flock = {
  /** 0..1 musical energy, normalised and smoothed. */
  energy: number;
  /** Slowly decaying running maximum of the raw energy — the normaliser. */
  runMax: number;
  /** How many planes the energy is asking for. */
  desired: number;
  /** How many planes are present (anything not dormant). */
  present: number;
  aboveFor: number;
  belowFor: number;
  lastJoinAt: number;
  lastLeaveAt: number;
};

export function createFlock(): Flock {
  return {
    energy: 0,
    runMax: 0.2,
    desired: 1,
    present: 1,
    aboveFor: 0,
    belowFor: 0,
    lastJoinAt: -Infinity,
    lastLeaveAt: -Infinity,
  };
}

export type FlockInput = {
  dt: number;
  time: number;
  level: number;
  bassEnergy: number;
  quiet: boolean;
  intensity: number;
  hasAudio: boolean;
};

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/** Position a dormant ship far behind the box, high and off to one side,
 *  ready to surge in. */
function stageArrival(ship: Ship, time: number): void {
  const p = ship.group.position;
  const side = Math.sin(ship.wanderSeed * 7.3 + time) > 0 ? 1 : -1;
  p.set(
    side * SHIP_X_BOUND * (0.3 + 0.5 * Math.abs(Math.sin(ship.wanderSeed))),
    SHIP_Y_MAX + 1.5,
    SHIP_Z_MIN - FLOCK_JOIN_DIST,
  );
  ship.heading = Math.PI;
  ship.pitch = -0.1;
  ship.roll = 0;
  ship.speed = 30;
  ship.accel = 0;
  ship.scatterUntil = -Infinity;
  ship.diveUntil = -Infinity;
  ship.cruiseY = p.y;
  ship.fade = 0;
  ship.phase = 'joining';
  ship.group.visible = true;
}

export function updateFlock(flock: Flock, ships: Ship[], input: FlockInput): void {
  const { dt, time } = input;

  // ----- energy -----
  // Mean spectrum level is the signal: it swings 2–3× between a verse and a
  // chorus, whereas bass sits near its ceiling whenever there's a kick, so
  // it only gets a small weight. Normalised against a relative-decaying
  // running maximum (≈90 s memory), so it self-calibrates to the source and
  // the song: a passage at 35% of the recent peak flies alone, one at 95%
  // fills the sky.
  const raw = !input.hasAudio || input.quiet
    ? 0
    : input.level + input.bassEnergy * 0.04;
  flock.runMax = Math.max(raw, 0.03, flock.runMax * Math.exp(-dt / FLOCK_MAX_MEMORY_S));
  const norm = Math.min(1, raw / flock.runMax);
  const tau = norm > flock.energy ? FLOCK_ENERGY_RISE_S : FLOCK_ENERGY_FALL_S;
  flock.energy += (norm - flock.energy) * (1 - Math.exp(-dt / tau));
  flock.desired = 1 + Math.round(smoothstep(0.35, 0.95, flock.energy) * (SHIP_MAX - 1));

  // ----- census -----
  let present = 0;
  for (const s of ships) if (s.phase !== 'dormant') present++;
  flock.present = present;

  // ----- hysteresis + rate limits -----
  if (flock.desired > present) {
    flock.aboveFor += dt;
    flock.belowFor = 0;
  } else if (flock.desired < present) {
    flock.belowFor += dt;
    flock.aboveFor = 0;
  } else {
    flock.aboveFor = 0;
    flock.belowFor = 0;
  }

  if (
    flock.aboveFor > FLOCK_JOIN_HOLD_S &&
    time - flock.lastJoinAt > FLOCK_JOIN_INTERVAL_S
  ) {
    // Lowest-index dormant ship arrives, so present ships stay a prefix.
    const ship = ships.find((s) => s.phase === 'dormant');
    if (ship) {
      stageArrival(ship, time);
      flock.lastJoinAt = time;
      flock.present++;
    }
  } else if (
    flock.belowFor > FLOCK_LEAVE_HOLD_S &&
    time - flock.lastLeaveAt > FLOCK_LEAVE_INTERVAL_S
  ) {
    // Highest-index present ship peels away; ship 0 never leaves.
    for (let i = ships.length - 1; i >= 1; i--) {
      const s = ships[i];
      if (s.phase === 'active' || s.phase === 'joining') {
        s.phase = 'leaving';
        s.leaveSide = s.group.position.x >= 0 ? 1 : -1;
        flock.lastLeaveAt = time;
        break;
      }
    }
  }
}

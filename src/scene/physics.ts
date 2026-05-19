// Rapier rigid-body integrator. One shared world; each ship is a dynamic body.
// Forces (thrust/drag/lift) and PD attitude torques are computed in ship.ts;
// this module only owns world setup and the body factory.

import RAPIER from '@dimforge/rapier3d-compat';
import { SHIP_GRAVITY } from '../constants.ts';

export type Physics = {
  rapier: typeof RAPIER;
  world: RAPIER.World;
};

export async function createPhysics(): Promise<Physics> {
  await RAPIER.init();
  const world = new RAPIER.World({ x: 0, y: -SHIP_GRAVITY, z: 0 });
  // Fixed timestep — Rapier is most stable at 1/60. The animate loop drives one
  // step per frame; if frames hitch the sim slows down rather than exploding.
  world.timestep = 1 / 60;
  return { rapier: RAPIER, world };
}

/** Dynamic body for a ship: short capsule rotated so its long axis lies along
 *  local -Z (the nose direction). Mass=1 keeps force tunables intuitive. */
export function addShipBody(
  p: Physics, x: number, y: number, z: number,
): RAPIER.RigidBody {
  const desc = p.rapier.RigidBodyDesc.dynamic()
    .setTranslation(x, y, z)
    // Real ambient drag in addition to the quadratic K·|v|·v in ship.ts.
    // Caps top speed and stops the plane from feeling rocket-propelled.
    .setLinearDamping(0.3)
    // High angular damping: with no real aerodynamic stability surfaces, the
    // PD attitude controller is the only thing resisting spin. Heavy damping
    // means ω can't run away when control torques momentarily fight each other.
    .setAngularDamping(5.0)
    .setCanSleep(false);
  const body = p.world.createRigidBody(desc);
  // Default Rapier capsule is Y-aligned; rotate 90° about X so its axis is along
  // ±Z, matching the wedge mesh's long axis. q = (sin 45°, 0, 0, cos 45°).
  const ROOT_HALF = Math.SQRT1_2;
  const col = p.rapier.ColliderDesc.capsule(0.6, 0.4)
    .setRotation({ x: ROOT_HALF, y: 0, z: 0, w: ROOT_HALF })
    .setMass(1.0);
  p.world.createCollider(col, body);
  return body;
}

/** Musical state has a slower timescale than individual note attacks. */
export type Dynamics = {
  short: number; mid: number; long: number; intensity: number; quiet: boolean;
  build: number; prevShort: number; dropTime: number; dropCount: number; lastDropDelta: number;
  age: number; initialized: boolean; quietFor: number; buildFor: number;
  armedUntil: number; onsetUntil: number; phase: 'settle' | 'anticipate' | 'release' | 'recover';
};
export function createDynamics(): Dynamics {
  return { short: 0, mid: 0, long: 0, intensity: 0, quiet: true, build: 0, prevShort: 0,
    dropTime: -Infinity, dropCount: 0, lastDropDelta: 0, age: 0, initialized: false,
    quietFor: 0, buildFor: 0, armedUntil: -Infinity, onsetUntil: -Infinity, phase: 'settle' };
}
export function releaseDynamics(d: Dynamics, time: number, strength = 1): void {
  d.dropTime = time * 1000;
  d.dropCount++;
  d.lastDropDelta = strength;
  d.armedUntil = -Infinity;
  d.buildFor = 0;
  d.phase = 'release';
  d.build = 0;
}
export function updateDynamics(d: Dynamics, level: number, dt: number, onset = false, forecast = 0): boolean {
  d.age += dt;
  if (!d.initialized && level > 0.02) {
    d.short = d.mid = d.long = level;
    d.initialized = true;
    d.age = 0;
  }
  d.short += (level - d.short) * (1 - Math.exp(-dt / 0.12));
  d.mid += (level - d.mid) * (1 - Math.exp(-dt / 2));
  d.long += (level - d.long) * (1 - Math.exp(-dt / 10));
  d.intensity = Math.min(1.5, d.short / Math.max(0.08, d.long));
  d.quiet = d.short < 0.08;
  const recovering = d.age * 1000 - d.dropTime < 6500;
  d.build = recovering ? 0 : Math.max(forecast, Math.max(0, Math.min(1, (d.mid - d.long) * 5)));
  d.quietFor = d.quiet ? d.quietFor + dt : Math.max(0, d.quietFor - dt * 0.5);
  d.buildFor = d.build > 0.2 ? d.buildFor + dt : Math.max(0, d.buildFor - dt);
  if (!recovering && d.age > 2.5 && (d.quietFor > 0.8 || d.buildFor > 1.2)) d.armedUntil = d.age + 3;
  if (onset) d.onsetUntil = d.age + 0.22;
  const ratio = d.short / Math.max(0.08, d.mid);
  const canRelease = d.age > 2.5 && d.age < d.armedUntil && d.age < d.onsetUntil
    && ratio > 1.22 && d.short - d.mid > 0.09 && d.short > 0.22
    && d.age * 1000 - d.dropTime > 8000;
  if (canRelease) releaseDynamics(d, d.age, ratio);
  else if (d.age * 1000 - d.dropTime < 1800) d.phase = 'release';
  else if (d.age * 1000 - d.dropTime < 6500) d.phase = 'recover';
  else d.phase = d.build > 0.2 ? 'anticipate' : 'settle';
  d.prevShort = d.short;
  return canRelease;
}
export function decayDynamics(d: Dynamics, dt: number): void {
  updateDynamics(d, 0, dt);
  d.quiet = true;
  d.build = 0;
}

// Per-frame context object reused across the animation loop. Subsystems
// write the fields they own and read whatever upstream stages have already
// produced. Reusing one mutable object avoids per-frame allocations.

export type Frame = {
  dt: number;
  t: number;
  // audio signals (extracted by audio/analyser → consumed by everyone downstream)
  bassEnergy: number;
  level: number;
  centroid: number;
  beatPulse: number;
  // dynamics (audio/dynamics → director, ships, uniforms)
  intensity: number;
  build: number;
  quiet: boolean;
  dropCount: number;
  dropFiredThisFrame: boolean;
  // pacing
  bpm: number;
  beatCount: number;
  // mode flags
  stereoEnabled: boolean;
  isPresenting: boolean;   // renderer.xr.isPresenting
  trackedShipIdx: number;  // -1 unless current cam mode is chase/cockpit
};

export function createFrame(): Frame {
  return {
    dt: 0,
    t: 0,
    bassEnergy: 0,
    level: 0,
    centroid: 0.5,
    beatPulse: 0,
    intensity: 0,
    build: 0,
    quiet: true,
    dropCount: 0,
    dropFiredThisFrame: false,
    bpm: 0,
    beatCount: 0,
    stereoEnabled: false,
    isPresenting: false,
    trackedShipIdx: -1,
  };
}

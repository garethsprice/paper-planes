// Per-frame extraction from the AnalyserNode: reads fftBins, computes the
// scalar features (bass / level / centroid / peak) used downstream by the
// dynamics layer, ships, and post-fx. Pure derivation — no state of its own.

import type { Frame } from '../frame.ts';
import type { AudioState } from './sources.ts';

export type AudioSnapshot = {
  fftBins: Uint8Array<ArrayBuffer> | null;
  /** 0..1 peak across all FFT bins — what the dynamics layer feeds on. */
  peakLevel: number;
};

/**
 * Pulls a fresh FFT into the audio state's internal buffer and writes the
 * derived scalars onto the frame. Returns fftBins so the terrain row-write
 * can sample it. When no audio source is attached, frame fields are zeroed
 * and the returned fftBins is null.
 */
export function extractAudio(state: AudioState | null, frame: Frame): AudioSnapshot {
  if (!state) {
    frame.bassEnergy = 0;
    frame.level = 0;
    frame.centroid = 0.5;
    return { fftBins: null, peakLevel: 0 };
  }
  const { analyser, fftBins } = state;
  analyser.getByteFrequencyData(fftBins);

  // bass band (bins 1..19, ~40-800 Hz at fftSize=1024) drives bloom + thrust
  let bs = 0;
  const bMax = Math.min(20, fftBins.length);
  for (let i = 1; i < bMax; i++) bs += fftBins[i];
  frame.bassEnergy = bs / ((bMax - 1) * 255);

  // peak across any bin → loudest active band, robust to silent bins
  let peak = 0;
  for (let i = 1; i < fftBins.length; i++) if (fftBins[i] > peak) peak = fftBins[i];
  const peakLevel = peak / 255;

  // overall mean level + spectral centroid (used by ships' wander pull)
  let sumAll = 0;
  let cn = 0;
  let cd = 0;
  for (let i = 1; i < fftBins.length; i++) {
    sumAll += fftBins[i];
    cn += i * fftBins[i];
    cd += fftBins[i];
  }
  frame.level = sumAll / (fftBins.length * 255);
  frame.centroid = cd > 0 ? cn / cd / (fftBins.length - 1) : 0.5;

  return { fftBins, peakLevel };
}

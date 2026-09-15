import type { Frame } from '../frame.ts';
import type { AudioState } from './sources.ts';
export type AudioSnapshot = { fftBins: Uint8Array<ArrayBuffer> | null; peakLevel: number; onset: boolean; rms: number };
export function extractAudio(state: AudioState | null, frame: Frame): AudioSnapshot {
  if (!state?.currentSourceNode || state.ctx.state !== 'running' || (state.kind === 'file' && state.audioEl.paused)) {
    frame.bassEnergy = frame.level = 0;
    frame.centroid = 0.5;
    return { fftBins: null, peakLevel: 0, onset: false, rms: 0 };
  }
  state.analyser.getByteFrequencyData(state.fftBins);
  state.featureAnalyser.getFloatTimeDomainData(state.waveform);
  state.featureAnalyser.getFloatFrequencyData(state.spectrum);
  const f = state.features.read(state.waveform, state.spectrum, state.ctx.sampleRate, state.ctx.currentTime);
  frame.bassEnergy = f.bass;
  frame.level = f.level;
  frame.centroid = f.centroid;
  return { fftBins: state.fftBins, peakLevel: f.level, onset: f.onset, rms: f.rms };
}

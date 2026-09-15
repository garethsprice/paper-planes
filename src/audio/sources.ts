// AudioContext + AnalyserNode + audio element. Source attach helpers
// (file/mic/tab) live here too — the *button click* handlers stay in
// ui/buttons.ts and call into these.

import type { BpmHandle } from './bpm.ts';
import { connectBpmSource } from './bpm.ts';
import { BPM_GAIN_FILE, BPM_GAIN_MIC } from '../constants.ts';
import { createFeatureTracker } from './features.ts';

export type AudioState = {
  ctx: AudioContext;
  analyser: AnalyserNode;
  featureAnalyser: AnalyserNode;
  waveform: Float32Array<ArrayBuffer>;
  spectrum: Float32Array<ArrayBuffer>;
  features: ReturnType<typeof createFeatureTracker>;
  kind: 'none' | 'file' | 'mic' | 'tab';
  generation: number;
  fftBins: Uint8Array<ArrayBuffer>;
  audioEl: HTMLAudioElement;
  /** Currently-attached MediaElementSource / MediaStreamSource. */
  currentSourceNode: AudioNode | null;
  /** Stream from getUserMedia / getDisplayMedia (so we can stop tracks). */
  micStream: MediaStream | null;
  /** Active file URL — revoked on disconnect. */
  currentObjectUrl: string | null;
};

let cached: AudioState | null = null;

/**
 * Lazily construct the AudioContext + AnalyserNode on first use. Browsers
 * gate AudioContext creation on a user gesture; the caller (a button click
 * handler) provides that gesture.
 */
export function ensureAudio(): AudioState {
  if (cached) return cached;
  const Ctor = window.AudioContext ||
    (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const ctx = new Ctor();
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.8;
  const fftBins = new Uint8Array(analyser.frequencyBinCount) as Uint8Array<ArrayBuffer>;
  const featureAnalyser = ctx.createAnalyser();
  featureAnalyser.fftSize = 2048;
  featureAnalyser.smoothingTimeConstant = 0;
  const waveform = new Float32Array(featureAnalyser.fftSize);
  const spectrum = new Float32Array(featureAnalyser.frequencyBinCount);
  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  cached = {
    ctx,
    analyser, featureAnalyser, waveform, spectrum,
    features: createFeatureTracker(spectrum.length), kind: 'none', generation: 0,
    fftBins,
    audioEl,
    currentSourceNode: null,
    micStream: null,
    currentObjectUrl: null,
  };
  return cached;
}

/** Returns the cached state if audio has been initialised, else null. */
export function getAudio(): AudioState | null {
  return cached;
}

/** Disconnect whatever source is currently feeding the analyser + BPM chain. */
export function disconnectCurrent(state: AudioState, bpm: BpmHandle): void {
  state.generation++;
  state.kind = 'none';
  state.audioEl.pause();
  state.audioEl.removeAttribute('src');
  state.audioEl.load();
  if (state.currentObjectUrl) { URL.revokeObjectURL(state.currentObjectUrl); state.currentObjectUrl = null; }
  state.features.reset();
  bpm.connectionVersion++;
  if (state.currentSourceNode) {
    try { state.currentSourceNode.disconnect(); } catch { /* ignore */ }
    state.currentSourceNode = null;
  }
  // No-arg disconnect already severed source→bpmGain; clear the cached ref so
  // connectBpmSource doesn't try to undo a connection that's already gone.
  bpm.lastSourceNode = null;
  if (state.micStream) {
    state.micStream.getTracks().forEach((t) => t.stop());
    state.micStream = null;
  }
}

/** Wire a MediaStream (mic / tab capture) into the analyser. */
export function attachStream(
  state: AudioState,
  bpm: BpmHandle,
  stream: MediaStream,
  kind: 'mic' | 'tab' = 'mic',
): void {
  state.audioEl.pause();
  disconnectCurrent(state, bpm);
  state.micStream = stream; // reuse cleanup path (track stop on disconnect)
  const src = state.ctx.createMediaStreamSource(stream);
  src.connect(state.analyser);
  src.connect(state.featureAnalyser);
  state.kind = kind;
  // Never connect captured streams to destination. Tab audio's source tab
  // already plays through the OS mixer, and mic would feedback. This tab
  // stays silent and uses the stream only for analysis.
  connectBpmSource(bpm, state.ctx, src, kind === 'mic' ? BPM_GAIN_MIC : BPM_GAIN_FILE);
  state.currentSourceNode = src;
}

/** Load and prep an <audio>-driven file source. */
export function loadAudioFile(state: AudioState, bpm: BpmHandle, f: File): void {
  disconnectCurrent(state, bpm);
  state.audioEl.pause();
  if (state.currentObjectUrl) URL.revokeObjectURL(state.currentObjectUrl);
  state.currentObjectUrl = URL.createObjectURL(f);
  state.audioEl.src = state.currentObjectUrl;
  state.audioEl.load();
  // MediaElementAudioSourceNode can only be created once per element; cache it.
  type ElWithSrc = HTMLAudioElement & { __src?: MediaElementAudioSourceNode };
  const el = state.audioEl as ElWithSrc;
  let mediaSrc = el.__src;
  if (!mediaSrc) {
    mediaSrc = state.ctx.createMediaElementSource(state.audioEl);
    el.__src = mediaSrc;
  }
  mediaSrc.connect(state.analyser);
  mediaSrc.connect(state.featureAnalyser);
  // Only a file source may play through the speakers. Both analysers are sinks.
  mediaSrc.connect(state.ctx.destination);
  state.kind = 'file';
  connectBpmSource(bpm, state.ctx, mediaSrc, BPM_GAIN_FILE);
  state.currentSourceNode = mediaSrc;
}

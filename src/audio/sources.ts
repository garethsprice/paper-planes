// AudioContext + AnalyserNode + audio element. Source attach helpers
// (file/mic/tab) live here too — the *button click* handlers stay in
// ui/buttons.ts and call into these.

import type { BpmHandle } from './bpm.ts';
import { connectBpmSource } from './bpm.ts';
import { BPM_GAIN_FILE, BPM_GAIN_MIC } from '../constants.ts';

export type AudioState = {
  ctx: AudioContext;
  analyser: AnalyserNode;
  fftBins: Uint8Array<ArrayBuffer>;
  audioEl: HTMLAudioElement;
  /** Currently-attached MediaElementSource / MediaStreamSource. */
  currentSourceNode: AudioNode | null;
  /** Stream from getUserMedia / getDisplayMedia (so we can stop tracks). */
  micStream: MediaStream | null;
  /** Last blob URL we created — revoked when the next file loads. */
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
  const audioEl = new Audio();
  audioEl.crossOrigin = 'anonymous';
  cached = {
    ctx,
    analyser,
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
): void {
  state.audioEl.pause();
  disconnectCurrent(state, bpm);
  state.micStream = stream; // reuse cleanup path (track stop on disconnect)
  const src = state.ctx.createMediaStreamSource(stream);
  src.connect(state.analyser);
  // Never connect captured streams to destination. Tab audio's source tab
  // already plays through the OS mixer, and mic would feedback. This tab
  // stays silent and uses the stream only for analysis.
  connectBpmSource(bpm, state.ctx, src, BPM_GAIN_MIC);
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
  state.analyser.connect(state.ctx.destination);
  connectBpmSource(bpm, state.ctx, mediaSrc, BPM_GAIN_FILE);
  state.currentSourceNode = mediaSrc;
}

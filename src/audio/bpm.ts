// Realtime-BPM analyser wrapper. The library is async (creates an
// AudioWorkletNode) so we cache both the resolved analyser and the in-flight
// promise. We low-pass at 200 Hz before feeding the worklet so peak detection
// only sees kick/bass transients, not hi-hats or vocals.
//
// Per-source gain matters: mic input is typically -20 to -30 dBFS; the
// analyser's peak threshold descends to 0.2, so quiet mic audio never
// qualifies. Boosting ~8× brings it into the working range. File sources are
// usually near full-scale and use unity gain.

import {
  createRealtimeBpmAnalyzer,
  getBiquadFilter,
  type BpmAnalyzer,
} from 'realtime-bpm-analyzer';
import { BPM_GAIN_FILE } from '../constants.ts';

export type BpmHandle = {
  /** Resolved BPM analyser, populated lazily on first source attach. */
  analyzer: BpmAnalyzer | null;
  filter: BiquadFilterNode | null;
  gain: GainNode | null;
  /** Locked tempo (0 until the analyser reports a stable estimate). */
  bpm: number;
  /** Current top candidate (early feedback before lock). */
  bpmCandidate: number;
  /** Increments once per validPeak (gated to ~250 ms / 240 BPM ceiling). */
  beatCount: number;
  /** 0..1, set to 1 on each peak; the animation loop decays it each frame. */
  beatPulse: number;
  /** Most recent peak timestamp (used for the 250 ms gate). */
  lastPeakAt: number;
  /** Last source connected to .gain — tracked so we can disconnect cleanly. */
  lastSourceNode: AudioNode | null;
};

export function createBpmHandle(): BpmHandle {
  return {
    analyzer: null,
    filter: null,
    gain: null,
    bpm: 0,
    bpmCandidate: 0,
    beatCount: 0,
    beatPulse: 0,
    lastPeakAt: 0,
    lastSourceNode: null,
  };
}

let promise: Promise<BpmAnalyzer | null> | null = null;

/**
 * Lazily construct the BPM analyser worklet for this AudioContext. Idempotent.
 * Resolves to null if the worklet fails to load (e.g., browser doesn't
 * support AudioWorklet).
 */
export async function ensureBpm(handle: BpmHandle, ctx: AudioContext): Promise<BpmAnalyzer | null> {
  if (handle.analyzer) return handle.analyzer;
  if (promise) return promise;
  handle.gain = ctx.createGain();
  handle.gain.gain.value = BPM_GAIN_FILE;
  handle.filter = getBiquadFilter(ctx);
  handle.gain.connect(handle.filter);
  promise = createRealtimeBpmAnalyzer(ctx, { continuousAnalysis: false, debug: true })
    .then((a) => {
      handle.filter!.connect(a.node);
      // The worklet only reads inputs; outputs are silent. Connect to
      // destination anyway so Chrome doesn't prune it from the graph.
      a.node.connect(ctx.destination);

      a.on('bpm', (data) => {
        const top = data.bpm[0];
        if (top) handle.bpmCandidate = top.tempo;
      });
      a.on('bpmStable', (data) => {
        const top = data.bpm[0];
        if (top) handle.bpm = top.tempo; // snap; we lock once
      });
      a.on('error', (e) => console.error('[bpm] analyzer error:', e));
      a.on('validPeak', () => {
        // The analyser descends through thresholds (0.95 → 0.2) and may emit
        // multiple validPeak events per audio peak. Gate to 250 ms.
        const now = performance.now();
        if (now - handle.lastPeakAt > 250) {
          handle.beatPulse = 1.0;
          handle.lastPeakAt = now;
          handle.beatCount++;
        }
      });
      handle.analyzer = a;
      return a;
    })
    .catch((err) => {
      console.warn('[bpm] analyzer unavailable:', err);
      return null;
    });
  return promise;
}

/** Wire a fresh source (file/mic/tab) into the analyser at the given gain. */
export function connectBpmSource(
  handle: BpmHandle,
  ctx: AudioContext,
  src: AudioNode,
  gain: number,
): void {
  ensureBpm(handle, ctx).then((a) => {
    if (!a || !handle.gain) return;
    if (handle.lastSourceNode) {
      try { handle.lastSourceNode.disconnect(handle.gain); } catch { /* ignore */ }
    }
    handle.gain.gain.value = gain;
    src.connect(handle.gain);
    handle.lastSourceNode = src;
    // fresh source — reset lock + analyser state
    handle.bpm = 0;
    handle.bpmCandidate = 0;
    a.reset();
  });
}

/** Reset the lock without disconnecting (used by the 'R' key). */
export function resetBpm(handle: BpmHandle): void {
  handle.bpm = 0;
  handle.bpmCandidate = 0;
  handle.analyzer?.reset();
}

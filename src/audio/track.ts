import type { MusicalCue } from './trackFeatures.ts';
/** Cancellable, local analysis. Playback remains available while this runs. */
export function createTrackAnalysis() {
  let generation = 0;
  let worker: Worker | null = null;
  const state = { cues: [] as MusicalCue[], preparing: false, cancel, load };
  function cancel() {
    generation++;
    worker?.terminate(); worker = null;
    state.cues = []; state.preparing = false;
  }
  async function load(file: File): Promise<void> {
    cancel();
    if (file.size > 50 * 1024 * 1024 || typeof OfflineAudioContext === 'undefined' || typeof Worker === 'undefined') return;
    const ticket = generation;
    state.preparing = true;
    try {
      const decoder = new OfflineAudioContext(1, 1, 8000);
      const buffer = await decoder.decodeAudioData(await file.arrayBuffer());
      if (ticket !== generation) return;
      if (buffer.duration > 900) { state.preparing = false; return; }
      const mono = new Float32Array(buffer.length);
      for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
        const data = buffer.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += data[i] / buffer.numberOfChannels;
      }
      worker = new Worker(new URL('./track.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (event: MessageEvent<MusicalCue[]>) => {
        if (ticket !== generation) return;
        state.cues = event.data; state.preparing = false;
        worker?.terminate(); worker = null;
      };
      worker.onerror = () => { if (ticket === generation) cancel(); };
      worker.postMessage({ samples: mono, sampleRate: buffer.sampleRate }, [mono.buffer]);
    } catch { if (ticket === generation) cancel(); }
  }
  return state;
}

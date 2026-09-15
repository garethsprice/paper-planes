import { analyseTrack } from './trackFeatures.ts';
self.onmessage = (event: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => {
  self.postMessage(analyseTrack(event.data.samples, event.data.sampleRate));
};

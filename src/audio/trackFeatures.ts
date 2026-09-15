export type MusicalCue = { time: number; confidence: number };
/** Offline RMS envelopes identify sustained arrivals, excluding startup and isolated hits. */
export function analyseTrack(samples: Float32Array, sampleRate: number): MusicalCue[] {
  const hop = Math.max(1, Math.round(sampleRate * 0.02));
  const n = Math.ceil(samples.length / hop);
  const energy = new Float32Array(n);
  const sums = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    let power = 0;
    const end = Math.min(samples.length, (i + 1) * hop);
    for (let j = i * hop; j < end; j++) power += samples[j] * samples[j];
    energy[i] = Math.sqrt(power / Math.max(1, end - i * hop));
    sums[i + 1] = sums[i] + energy[i];
  }
  const mean = (start: number, end: number) => {
    start = Math.max(0, Math.min(n, start)); end = Math.max(start + 1, Math.min(n, end));
    return (sums[end] - sums[start]) / (end - start);
  };
  const cues: MusicalCue[] = [];
  for (let i = 300; i < n - 60; i++) {
    const before = mean(i - 45, i - 5);
    const baseline = mean(i - 250, i - 45);
    const after = mean(i + 5, i + 55);
    const contrast = after / Math.max(0.003, Math.min(before, baseline));
    const attack = energy[i] / Math.max(0.003, mean(i - 8, i));
    const time = i * hop / sampleRate;
    if (after > 0.015 && contrast > 1.9 && attack > 1.65 &&
        time - (cues[cues.length - 1]?.time ?? -Infinity) > 8) {
      cues.push({ time, confidence: Math.min(1, 0.6 + (contrast - 1.9) * 0.2) });
      i += 50;
    }
  }
  return cues;
}
export function upcomingCue(cues: MusicalCue[], time: number): MusicalCue | undefined {
  return cues.find(c => c.confidence >= 0.65 && c.time > time && c.time - time <= 8);
}

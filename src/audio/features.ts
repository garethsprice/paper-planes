/** Fast, unsmoothed features. The display spectrum has its own analyser. */
export type Features = { rms: number; level: number; bass: number; centroid: number; onset: boolean; flux: number };
export function frequencyBin(hz: number, sampleRate: number, fftSize: number): number {
  return Math.max(1, Math.round(hz * fftSize / sampleRate));
}
export function createFeatureTracker(size: number) {
  const previous = new Float32Array(size);
  const result: Features = { rms: 0, level: 0, bass: 0, centroid: 0.5, onset: false, flux: 0 };
  let meanFlux = 0, age = 0, lastOnset = -Infinity, lastTime = -Infinity;
  return {
    reset() { previous.fill(0); meanFlux = 0; age = 0; lastOnset = lastTime = -Infinity; },
    read(wave: Float32Array, spectrum: Float32Array, sampleRate: number, time: number): Features {
      result.onset = false;
      if (time <= lastTime) return result;
      const dt = Number.isFinite(lastTime) ? Math.min(0.1, time - lastTime) : 0;
      lastTime = time;
      age += dt;
      let power = 0;
      for (const v of wave) power += v * v;
      result.rms = Math.sqrt(power / wave.length);
      result.level = Math.max(0, Math.min(1, (20 * Math.log10(Math.max(1e-8, result.rms)) + 65) / 59));
      let flux = 0, sum = 0, weighted = 0, bassPower = 0;
      const bassEnd = frequencyBin(250, sampleRate, spectrum.length * 2);
      const bassStart = frequencyBin(35, sampleRate, spectrum.length * 2);
      const end = Math.min(spectrum.length, frequencyBin(16000, sampleRate, spectrum.length * 2));
      for (let i = 1; i < end; i++) {
        const amplitude = Math.pow(10, spectrum[i] / 20);
        const magnitude = Math.sqrt(amplitude);
        flux += Math.max(0, magnitude - previous[i]);
        previous[i] = magnitude;
        sum += amplitude;
        weighted += amplitude * Math.log2(1 + i * sampleRate / (spectrum.length * 2) / 40);
        if (i >= bassStart && i <= bassEnd) bassPower += amplitude * amplitude;
      }
      flux /= end;
      result.flux = flux;
      result.onset = age > 0.5 && result.rms > 0.0006 && flux > Math.max(0.001, meanFlux * 2.2)
        && time - lastOnset > 0.18;
      if (result.onset) lastOnset = time;
      meanFlux += (flux - meanFlux) * (1 - Math.exp(-dt / 0.7));
      result.bass = Math.min(1, Math.sqrt(bassPower) * 4);
      result.centroid = sum > 1e-7 ? Math.min(1, weighted / sum / Math.log2(401)) : 0.5;
      return result;
    },
  };
}

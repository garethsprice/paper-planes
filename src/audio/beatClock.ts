/** Beat phase is evidence-weighted. Tempo alone never establishes a bar. */
export type BeatClock = {
  bpm: number; confidence: number; phase: number; count: number; pulse: number;
  anchor: number; lastOnset: number; lastBeat: number; interval: number; agreements: number;
};
export function createBeatClock(): BeatClock {
  return { bpm: 0, confidence: 0, phase: 0, count: 0, pulse: 0,
    anchor: 0, lastOnset: -Infinity, lastBeat: -Infinity, interval: 0, agreements: 0 };
}
export function updateBeatClock(clock: BeatClock, time: number, onset: boolean, candidate: number, dt: number): boolean {
  clock.pulse *= Math.exp(-9 * dt);
  if (onset) {
    const gap = time - clock.lastOnset;
    if (gap >= 0.23 && gap < 1.2) {
      const period = candidate >= 55 && candidate <= 210 ? 60 / candidate : (clock.interval || gap);
      const beats = candidate >= 55 && candidate <= 210 && gap < period * 0.75
        ? 0.5 : Math.max(1, Math.round(gap / period));
      const error = Math.abs(gap / beats - period) / period;
      if (error < 0.16) {
        clock.agreements++;
        clock.interval = clock.interval ? clock.interval * 0.85 + gap / beats * 0.15 : gap / beats;
        clock.bpm = 60 / clock.interval;
        clock.confidence = Math.min(1, clock.confidence + 0.16);
        if (clock.agreements < 3) clock.anchor = time;
        else {
          const nearest = clock.anchor + Math.round((time - clock.anchor) / clock.interval) * clock.interval;
          // Subdivision attacks reinforce tempo without pulling phase halfway off a beat.
          if (Math.abs(time - nearest) < clock.interval * 0.2) {
            clock.anchor += Math.max(-0.035, Math.min(0.035, (time - nearest) * 0.2));
          }
        }
      } else {
        clock.confidence *= 0.65;
        clock.agreements = 0;
        if (clock.confidence < 0.2) { clock.interval = gap; clock.anchor = time; }
      }
    }
    clock.lastOnset = time;
  }
  if (time - clock.lastOnset > 2) clock.confidence *= Math.exp(-dt / 2);
  let edge = false;
  if (clock.interval > 0 && clock.confidence >= 0.55) {
    const beat = Math.floor((time - clock.anchor) / clock.interval + 0.06);
    clock.phase = ((time - clock.anchor) / clock.interval % 1 + 1) % 1;
    if (beat > clock.lastBeat) { edge = true; clock.lastBeat = beat; }
  } else {
    edge = onset;
    clock.lastBeat = -Infinity;
    clock.phase = 0;
  }
  if (edge) { clock.count++; clock.pulse = 1; }
  return edge;
}
/** Audio time currently audible at the output, including a user adjustment. */
export function presentationTime(ctx: AudioContext, playsHere: boolean, offsetMs = 0): number {
  let time = ctx.currentTime;
  if (playsHere && typeof ctx.getOutputTimestamp === 'function') {
    const stamp = ctx.getOutputTimestamp();
    const contextTime = stamp.contextTime ?? 0;
    const performanceTime = stamp.performanceTime ?? 0;
    if (contextTime > 0 && performanceTime > 0) {
      time = contextTime + (performance.now() - performanceTime) / 1000;
    }
  }
  return Math.max(0, Math.min(ctx.currentTime, time) + offsetMs / 1000);
}

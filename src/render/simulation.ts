/** A bounded fixed step. After suspension every subsystem resumes on the same clock. */
export const SIMULATION_STEP = 1 / 60;
export function createSimulationClock() {
  let accumulator = 0;
  let time = 0;
  return {
    reset() { accumulator = 0; },
    advance(elapsed: number, step: (dt: number, time: number) => void): number {
      accumulator += Math.max(0, Math.min(elapsed, 0.1));
      while (accumulator + 1e-9 >= SIMULATION_STEP) {
        accumulator = Math.max(0, accumulator - SIMULATION_STEP);
        time += SIMULATION_STEP;
        step(SIMULATION_STEP, time);
      }
      return accumulator / SIMULATION_STEP;
    },
  };
}

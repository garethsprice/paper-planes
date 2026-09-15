export type Quality = { level: number; slowFor: number; fastFor: number; cooldown: number };
// Preserve line resolution on the first downgrade; reduce secondary effects first.
export const QUALITY_LEVELS = [
  { pixelScale: 1, bloomScale: 1, detail: 1, reflection: true },
  { pixelScale: 1, bloomScale: 0.65, detail: 0.6, reflection: false },
  { pixelScale: 0.85, bloomScale: 0.5, detail: 0.45, reflection: false },
  { pixelScale: 0.7, bloomScale: 0.35, detail: 0.3, reflection: false },
];
export function createQuality(): Quality { return { level: 0, slowFor: 0, fastFor: 0, cooldown: 3 }; }
export function updateQuality(q: Quality, frameMs: number, workMs: number, dt: number): boolean {
  if (!Number.isFinite(dt) || dt <= 0) return false;
  dt = Math.min(dt, 0.5); // include severe rendering stalls without overreacting to one pause
  q.cooldown = Math.max(0, q.cooldown - dt);
  const slow = frameMs > 20 || workMs > 14;
  const fast = frameMs < 18 && workMs < 10;
  q.slowFor = slow ? q.slowFor + dt : Math.max(0, q.slowFor - dt);
  q.fastFor = fast ? q.fastFor + dt : 0;
  if (q.cooldown > 0) return false;
  if (q.slowFor > 2 && q.level < QUALITY_LEVELS.length - 1) {
    q.level++; q.slowFor = q.fastFor = 0; q.cooldown = 4; return true;
  }
  if (q.fastFor > 12 && q.level > 0) {
    q.level--; q.slowFor = q.fastFor = 0; q.cooldown = 6; return true;
  }
  return false;
}
export function createFrameMetrics() {
  const frames = new Float32Array(180);
  let cursor = 0, count = 0, lastSummary = 0;
  const state = { cpuMs: 0, frameMs: 0, gpuMs: null as number | null, p95Ms: 0,
    sample(cpuMs: number, frameMs: number, now: number) {
      state.cpuMs += (cpuMs - state.cpuMs) * 0.08;
      state.frameMs += (frameMs - state.frameMs) * 0.08;
      if (Number.isFinite(frameMs) && frameMs > 0) { frames[cursor++ % frames.length] = frameMs; count = Math.min(count + 1, frames.length); }
      if (now - lastSummary > 1000 && count) {
        const sorted = frames.slice(0, count).sort();
        state.p95Ms = sorted[Math.max(0, Math.ceil(count * 0.95) - 1)];
        lastSummary = now;
      }
    },
  };
  return state;
}
/** Nonblocking GPU queries. Missing extensions are reported as unavailable, never as zero. */
export function createGpuTimer(gl: WebGL2RenderingContext) {
  const ext = gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
  const pending: WebGLQuery[] = [];
  let active: WebGLQuery | null = null;
  return {
    begin() {
      if (!ext || active || pending.length >= 4 || gl.isContextLost()) return;
      active = gl.createQuery();
      if (active) gl.beginQuery(ext.TIME_ELAPSED_EXT, active);
    },
    end() {
      if (!ext || !active) return;
      gl.endQuery(ext.TIME_ELAPSED_EXT); pending.push(active); active = null;
    },
    poll(): number | null {
      if (!ext || !pending.length || gl.isContextLost()) return null;
      if (gl.getParameter(ext.GPU_DISJOINT_EXT)) { for (const q of pending) gl.deleteQuery(q); pending.length = 0; return null; }
      if (!gl.getQueryParameter(pending[0], gl.QUERY_RESULT_AVAILABLE)) return null;
      const q = pending.shift()!;
      const ms = gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(q); return ms;
    },
  };
}

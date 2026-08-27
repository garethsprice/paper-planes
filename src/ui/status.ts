// HTML-overlay status updates: BPM readout + dot pulse, debug telemetry
// panel, and UI strip auto-hide. All called per frame from the animation
// loop or wired up once at install time.

import type { BpmHandle } from '../audio/bpm.ts';
import type { Dynamics } from '../audio/dynamics.ts';
import type { Formation } from '../scene/ship.ts';

export type StatusDeps = {
  uiEl: HTMLElement;
  bpmNumEl: HTMLElement;
  bpmDotEl: HTMLElement;
  dbgEl: HTMLElement;
};

export type Interaction = {
  lastAt: number;
  pointerInWindow: boolean;
};

export function installInteractionTracking(): Interaction {
  const interaction: Interaction = {
    lastAt: performance.now(),
    pointerInWindow: false,
  };
  const mark = () => { interaction.lastAt = performance.now(); };
  ['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((ev) => {
    document.addEventListener(ev, mark, { passive: true });
  });
  // While the cursor is inside the window the UI never hides; 3 s after it
  // leaves it fades out.
  document.body.addEventListener('pointerenter', () => { interaction.pointerInWindow = true; });
  document.body.addEventListener('pointerleave', () => {
    interaction.pointerInWindow = false;
    interaction.lastAt = performance.now();
  });
  return interaction;
}

/** Toggle the UI strip's idle class based on cursor presence + idle time.
 *  Returns whether the strip is idle (hidden), so per-frame readouts can be
 *  skipped while nobody can see them. */
export function updateUiVisibility(uiEl: HTMLElement, interaction: Interaction): boolean {
  const idle = !interaction.pointerInWindow && performance.now() - interaction.lastAt > 3000;
  uiEl.classList.toggle('idle', idle);
  return idle;
}

let lastDotOpacity = -1;
let lastBpmText = '';

/** Per-frame BPM readout + beat-dot opacity (decays via bpmHandle.beatPulse).
 *  Every DOM write here invalidates style/layout for the strip, so only
 *  write what has actually changed: the dot's opacity is quantised to
 *  1/100 (it decays to rest within a few frames of each beat) and the text
 *  is compared before it is replaced. */
export function updateBpmReadout(deps: StatusDeps, bpm: BpmHandle): void {
  const opacity = Math.round((0.2 + bpm.beatPulse * 0.8) * 100) / 100;
  if (opacity !== lastDotOpacity) {
    lastDotOpacity = opacity;
    deps.bpmDotEl.style.opacity = String(opacity);
  }
  const text = bpm.bpm > 0
    ? `${Math.round(bpm.bpm)} bpm`
    : bpm.bpmCandidate > 0
      ? `~${Math.round(bpm.bpmCandidate)} bpm`
      : '— bpm';
  if (text !== lastBpmText) {
    lastBpmText = text;
    deps.bpmNumEl.textContent = text;
  }
}

let dbgFrameCounter = 0;

/** Smoothed frame timing for the strip: `cpuMs` is main-thread time inside
 *  the animation callback, `frameMs` the interval between frames. */
export type FrameTiming = { cpuMs: number; frameMs: number };

/** Throttled (every 6 frames ≈ 10 Hz) debug-panel rebuild. */
export function updateDebugPanel(
  dbgEl: HTMLElement,
  dynamics: Dynamics,
  formation: Formation,
  dropBoost: number,
  flock: { present: number; desired: number; energy: number },
  mood: { anticipation: number; hush: number; afterglow: number },
  rhymed: boolean,
  timing: FrameTiming,
): void {
  if ((dbgFrameCounter++ % 6) !== 0) return;
  dbgEl.innerHTML =
    `<span class="num">✈ ${flock.present}</span>` +
    (flock.desired !== flock.present
      ? `<span style="opacity:0.5">→${flock.desired}</span>`
      : '') +
    `<span class="num"> · E ${flock.energy.toFixed(2)}</span>` +
    `<span class="num"> · I ${dynamics.intensity.toFixed(2)}</span>` +
    (mood.anticipation > 0.05 ? `<span class="num"> · A ${mood.anticipation.toFixed(2)}</span>` : '') +
    (mood.hush > 0.05 ? `<span class="num"> · H ${mood.hush.toFixed(2)}</span>` : '') +
    (mood.afterglow > 0.05 ? '<span class="tag drop"> RELEASE</span>' : '') +
    (rhymed ? '<span class="tag on"> RHYME</span>' : '') +
    `<span class="num"> · B ${dynamics.build.toFixed(2)}</span>` +
    (dynamics.quiet ? '<span class="tag on"> QUIET</span>' : '') +
    (dropBoost > 0.05
      ? `<span class="tag drop"> DROP×${dynamics.dropCount}</span>`
      : ` <span style="opacity:0.5">drp ${dynamics.dropCount}</span>`) +
    (formation.active ? '<span class="tag on"> FORM</span>' : '') +
    (dynamics.build > 0.3 ? '<span class="tag on"> BUILD</span>' : '') +
    `<span class="num"> · ${timing.cpuMs.toFixed(1)}/${timing.frameMs.toFixed(1)} ms</span>`;
}

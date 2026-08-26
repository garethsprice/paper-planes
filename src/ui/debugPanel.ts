// Lyrics debug panel: a live feed of what the recogniser hears — interim
// guesses faintly, final results with confidence and the exact reason the
// gate accepted or rejected them — plus sliders bound to the live gate and
// timing settings, and a button to fire a test banner.

import { lyricsSettings, type Lyrics, type LyricEvent } from '../audio/lyrics.ts';

export type DebugPanel = {
  el: HTMLDivElement;
  toggle: () => void;
  /** Re-render the feed and state (throttled internally). `note` describes the pending phrase. */
  update: (lyrics: Lyrics, note: string) => void;
};

type SliderSpec = {
  key: keyof typeof lyricsSettings;
  label: string;
  min: number;
  max: number;
  step: number;
};

const SLIDERS: SliderSpec[] = [
  { key: 'minConfidence', label: 'confidence · 3+ words', min: 0.5, max: 1, step: 0.01 },
  { key: 'minConfidenceShort', label: 'confidence · 1–2 words', min: 0.5, max: 1, step: 0.01 },
  { key: 'maxWords', label: 'max words', min: 1, max: 20, step: 1 },
  { key: 'minWordLen', label: 'min word length', min: 1, max: 6, step: 1 },
  { key: 'minContentRatio', label: 'min content words (0 = allow filler)', min: 0, max: 1, step: 0.05 },
  { key: 'minIntervalS', label: 'min gap between banners (s)', min: 0, max: 40, step: 1 },
  { key: 'fallbackS', label: 'show anyway after (s)', min: 0, max: 20, step: 1 },
  { key: 'fallbackEnergy', label: '…if energy ≥', min: 0, max: 1, step: 0.05 },
  { key: 'freshS', label: 'phrase freshness (s)', min: 2, max: 60, step: 1 },
  { key: 'holdS', label: 'banner hold (s)', min: 1, max: 12, step: 0.5 },
];

export function createDebugPanel(onTestBanner: (text: string) => void): DebugPanel {
  const el = document.createElement('div');
  el.id = 'debug-panel';
  el.innerHTML = `
    <div class="dp-head">
      <span>lyrics · debug</span>
      <span class="dp-state" id="dp-state">—</span>
      <button class="btn dp-close" id="dp-close">×</button>
    </div>
    <div class="dp-sliders" id="dp-sliders"></div>
    <div class="dp-actions">
      <button class="btn" id="dp-test">test banner</button>
      <button class="btn" id="dp-clear">clear feed</button>
    </div>
    <div class="dp-pending" id="dp-pending"></div>
    <div class="dp-feed" id="dp-feed"></div>
  `;
  document.body.appendChild(el);

  const sliders = el.querySelector('#dp-sliders') as HTMLDivElement;
  for (const spec of SLIDERS) {
    const row = document.createElement('label');
    row.className = 'dp-row';
    const value = document.createElement('span');
    value.className = 'dp-val';
    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(spec.min);
    input.max = String(spec.max);
    input.step = String(spec.step);
    input.value = String(lyricsSettings[spec.key]);
    const fmt = (v: number) => (spec.step < 1 ? v.toFixed(2) : String(v));
    value.textContent = fmt(lyricsSettings[spec.key]);
    input.addEventListener('input', () => {
      const v = parseFloat(input.value);
      (lyricsSettings as Record<string, number>)[spec.key] = v;
      value.textContent = fmt(v);
    });
    const name = document.createElement('span');
    name.className = 'dp-name';
    name.textContent = spec.label;
    row.append(name, input, value);
    sliders.appendChild(row);
  }

  const feedEl = el.querySelector('#dp-feed') as HTMLDivElement;
  const pendingEl = el.querySelector('#dp-pending') as HTMLDivElement;
  const stateEl = el.querySelector('#dp-state') as HTMLSpanElement;
  (el.querySelector('#dp-close') as HTMLButtonElement).addEventListener('click', () => el.classList.remove('open'));
  (el.querySelector('#dp-test') as HTMLButtonElement).addEventListener('click', () =>
    onTestBanner('and the light came back'),
  );
  let clearedBefore = 0;
  (el.querySelector('#dp-clear') as HTMLButtonElement).addEventListener('click', () => {
    clearedBefore = performance.now();
    feedEl.innerHTML = '';
    lastRendered = -1;
  });

  let lastRendered = -1;
  let frame = 0;
  const render = (lyrics: Lyrics): void => {
    stateEl.textContent = !lyrics.supported
      ? 'unsupported'
      : !lyrics.enabled
        ? 'off'
        : lyrics.listening
          ? 'listening'
          : `idle${lyrics.lastError ? ` · ${lyrics.lastError}` : ''}`;
    stateEl.className = `dp-state ${lyrics.listening && lyrics.enabled ? 'live' : ''}`;

    // Rebuild only when the feed changed (by length + last event time).
    const feed = lyrics.feed.filter((e) => e.at > clearedBefore);
    // (also ticks every 2 s so a stale interim line clears itself)
    const sig = (feed.length ? feed[feed.length - 1].at + feed.length * 1e-3 : 0) + Math.floor(performance.now() / 2000) * 1e-6;
    if (sig === lastRendered) return;
    lastRendered = sig;
    const lines: string[] = [];
    // Show the newest interim as a live "hearing" line, then finals newest first.
    const latestInterim = [...feed].reverse().find((e) => e.kind === 'interim');
    const finals = feed.filter((e) => e.kind !== 'interim').slice(-30).reverse();
    if (latestInterim && (performance.now() - latestInterim.at) < 4000) {
      lines.push(`<div class="dp-line interim">… ${esc(latestInterim.transcript)}</div>`);
    }
    for (const e of finals) lines.push(renderEvent(e));
    feedEl.innerHTML = lines.join('');
  };

  return {
    el,
    toggle: () => el.classList.toggle('open'),
    update: (lyrics, note) => {
      if (!el.classList.contains('open')) return;
      if ((frame++ % 10) !== 0) return; // ~6 Hz
      pendingEl.textContent = note;
      render(lyrics);
    },
  };
}

function esc(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
}

function renderEvent(e: LyricEvent): string {
  const t = new Date(performance.timeOrigin + e.at).toLocaleTimeString([], { hour12: false });
  if (e.kind === 'error') return `<div class="dp-line err">${t} · error: ${esc(e.transcript)}</div>`;
  if (e.kind === 'state') return `<div class="dp-line state">${t} · ${esc(e.transcript)}</div>`;
  const conf = e.confidence.toFixed(2);
  return e.accepted
    ? `<div class="dp-line ok">${t} · <b>${esc(e.transcript)}</b> <span class="dp-conf">${conf}</span> ✓</div>`
    : `<div class="dp-line no">${t} · ${esc(e.transcript)} <span class="dp-conf">${conf}</span> <span class="dp-why">${esc(e.reason)}</span></div>`;
}

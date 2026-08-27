// Ethereal text banner in the sky. A DOM overlay (crisp type, no font
// atlases) that fades and drifts in over ~1.5 s, holds, and dissolves —
// letter-spaced light serif with a soft glow, screen-blended over the
// scene. One banner at a time; a new one replaces the old.

import { lyricsSettings } from '../audio/lyrics.ts';

export type Banner = {
  el: HTMLDivElement;
  show: (text: string) => void;
  /** Seconds (performance.now-based) since the last show, or Infinity. */
  age: () => number;
};

export function createBanner(): Banner {
  const el = document.createElement('div');
  el.id = 'banner';
  el.className = 'skytext';
  el.setAttribute('aria-live', 'polite');
  document.body.appendChild(el);
  let shownAt = -Infinity;
  let hideTimer: number | undefined;

  const show = (text: string): void => {
    el.textContent = text;
    el.classList.remove('in', 'out');
    // Long lines set smaller and tighter so they wrap into a few graceful rows.
    el.classList.toggle('long', text.length > 36);
    // reflow so the transition restarts even for the same class sequence
    void el.offsetWidth;
    el.classList.add('in');
    shownAt = performance.now();
    if (hideTimer !== undefined) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(() => {
      el.classList.remove('in');
      el.classList.add('out');
    }, lyricsSettings.holdS * 1000);
  };

  return { el, show, age: () => (performance.now() - shownAt) / 1000 };
}

/** The "click anywhere to start the mic" invite (index.html `#invite`), set
 *  in the same sky type as the banner. It drifts in shortly after load and
 *  breathes until the first source connects, then dissolves like a banner
 *  and is removed from layout. */
export function revealInvite(): void {
  window.setTimeout(() => {
    const el = document.getElementById('invite');
    if (el && !el.classList.contains('out')) el.classList.add('in');
  }, 500);
}

export function dismissInvite(): void {
  const el = document.getElementById('invite');
  if (!el || el.classList.contains('out')) return;
  el.classList.add('out');
  el.addEventListener('transitionend', () => el.classList.add('gone'), { once: true });
  // If transitions are disabled (reduced motion), still remove it.
  window.setTimeout(() => el.classList.add('gone'), 3000);
}

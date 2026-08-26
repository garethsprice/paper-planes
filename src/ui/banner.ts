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

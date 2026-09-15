export type Preferences = { motion: number; flash: number; syncMs: number; quality: 'auto' | 'high' | 'low' };
const KEY = 'paper-planes-preferences-v1';
const QUALITY_VERSION = 2;
export function loadPreferences(): Preferences {
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const base: Preferences = { motion: reduced ? 0 : 0.8, flash: reduced ? 0 : 0.35, syncMs: 0, quality: 'high' };
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || '{}');
    for (const key of ['motion', 'flash'] as const) if (Number.isFinite(saved[key])) base[key] = Math.max(0, Math.min(1, saved[key]));
    if (Number.isFinite(saved.syncMs)) base.syncMs = Math.max(-300, Math.min(300, saved.syncMs));
    // Older releases saved Automatic even when only another slider changed.
    // Adopt High once for that legacy default; preserve explicit choices from here on.
    if (saved.quality === 'high' || saved.quality === 'low'
      || (saved.quality === 'auto' && saved.qualityVersion === QUALITY_VERSION)) base.quality = saved.quality;
  } catch { /* private browsing and unavailable storage use defaults */ }
  if (reduced) { base.motion = 0; base.flash = 0; }
  return base;
}
export function savePreferences(preferences: Preferences): void {
  try { localStorage.setItem(KEY, JSON.stringify({ ...preferences, qualityVersion: QUALITY_VERSION })); } catch { /* session-only preferences */ }
}

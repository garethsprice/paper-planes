// Camera mode catalogue + selection state. The 5 cinematic presets, chase
// and cockpit views per ship, plus the WebXR observer mode all live in one
// flat list addressed by index. The director picks from role pools rather
// than the full list.

import { CAM_BLEND_S } from '../constants.ts';

export type CamPreset = { yaw: number; pitch: number; radius: number; height: number };
export type CamMode =
  | { kind: 'preset'; preset: CamPreset; label: string }
  | { kind: 'chase'; shipIdx: number; label: string }
  | { kind: 'cockpit'; shipIdx: number; label: string }
  | { kind: 'vr-observer'; label: string };

export const CAM_PRESETS: CamPreset[] = [
  { yaw: 0,        pitch: 0.0,  radius: 30, height: 6.5 }, // eye-level — low, so peaks tower
  { yaw: 0.6,      pitch: 0.25, radius: 32, height: 14 }, // 3/4 high-side
  { yaw: -0.5,     pitch: -0.1, radius: 32, height: 4.5 }, // low-left — outside the ship box
  { yaw: Math.PI,  pitch: 0.35, radius: 36, height: 18 }, // overhead reverse
  // High crane. A modest forward offset keeps the up-vector well-defined —
  // the old near-vertical (radius 2, height 42) framing was degenerate for
  // lookAt and rolled unpredictably as the orbit drifted.
  { yaw: 0.35,     pitch: 0.0,  radius: 18, height: 32 }, // high crane
];

/** Director role pools — indices into the full CAM_MODES list.
 *  0–4 presets, 5–7 chase (one per ship), 8–10 cockpit. Cockpit is
 *  deliberately absent: the hard cut into a nose-mounted view is the most
 *  jarring transition we have, so it's reachable only via the C key. */
export const MODE_ROLES = {
  calm:     [0, 1, 2],
  active:   [0, 1, 2, 5, 6, 7],
  dramatic: [3, 4, 1],          // wide reveals — the drop pulls back, never in
  rush:     [5, 6, 7],
} as const;
export type ModeRole = keyof typeof MODE_ROLES;

export type CameraSelection = {
  modes: CamMode[];
  vrObserverIdx: number;
  currentIdx: number;
  modeChangedAt: number;
  beatsAtChange: number;
  /** last 2 picks; rejection-sample to avoid repeats. */
  recentIdxs: number[];
  /** Seconds the camera takes to glide into the current mode. */
  transitionS: number;
  /** Number of ships currently in the flock (a prefix of the ship list);
   *  chase/cockpit modes for ships beyond this are unavailable. */
  presentShips: number;
};

export function createCameraSelection(shipCount: number): CameraSelection {
  const modes: CamMode[] = [
    ...CAM_PRESETS.map((preset, i): CamMode => ({ kind: 'preset', preset, label: `preset ${i + 1}` })),
    ...Array.from({ length: shipCount }, (_, i): CamMode => ({ kind: 'chase', shipIdx: i, label: `chase ship ${i + 1}` })),
    ...Array.from({ length: shipCount }, (_, i): CamMode => ({ kind: 'cockpit', shipIdx: i, label: `cockpit ship ${i + 1}` })),
    // VR observer — used only inside a WebXR session. Director never picks it.
    { kind: 'vr-observer', label: 'vr observer' },
  ];
  return {
    modes,
    vrObserverIdx: modes.length - 1,
    currentIdx: 0,
    modeChangedAt: 0,
    beatsAtChange: 0,
    recentIdxs: [],
    transitionS: CAM_BLEND_S,
    presentShips: 1,
  };
}

/** True if the mode can be shown now — tracked modes need their ship present. */
export function isModeAvailable(sel: CameraSelection, idx: number): boolean {
  const m = sel.modes[idx];
  if (m.kind === 'chase' || m.kind === 'cockpit') return m.shipIdx < sel.presentShips;
  return m.kind !== 'vr-observer';
}

/**
 * Pick a mode index from a role pool, avoiding the current mode, the last
 * two picks, and any tracked mode whose ship isn't in the flock. Falls back
 * gracefully when the constraint set empties.
 */
export function pickCinematicMode(sel: CameraSelection, role: ModeRole): number {
  const pool = MODE_ROLES[role].filter((idx) => isModeAvailable(sel, idx));
  const fresh = pool.filter((idx) => idx !== sel.currentIdx && !sel.recentIdxs.includes(idx));
  const candidates = fresh.length > 0
    ? fresh
    : pool.filter((idx) => idx !== sel.currentIdx);
  const choice = candidates.length > 0
    ? candidates[(Math.random() * candidates.length) | 0]
    : pool[0] ?? 0;
  sel.recentIdxs.push(choice);
  if (sel.recentIdxs.length > 2) sel.recentIdxs.shift();
  return choice;
}

/** Switch to a mode and reset the cadence baselines so timing starts fresh.
 *  The camera glides into the new mode over `transitionS` seconds. */
export function applyCut(
  sel: CameraSelection,
  idx: number,
  beatCount: number,
  transitionS: number = CAM_BLEND_S,
): void {
  sel.currentIdx = idx;
  sel.modeChangedAt = performance.now();
  sel.beatsAtChange = beatCount;
  sel.transitionS = transitionS;
}

/** Next available mode after the current one (wrapping), for the C key. */
export function nextAvailableMode(sel: CameraSelection): number {
  const n = sel.modes.length;
  for (let step = 1; step < n; step++) {
    const idx = (sel.currentIdx + step) % n;
    if (isModeAvailable(sel, idx)) return idx;
  }
  return sel.currentIdx;
}

/** Index of the ship being tracked by chase/cockpit, or -1 otherwise. */
export function trackedShipIdx(sel: CameraSelection): number {
  const m = sel.modes[sel.currentIdx];
  return (m.kind === 'chase' || m.kind === 'cockpit') ? m.shipIdx : -1;
}

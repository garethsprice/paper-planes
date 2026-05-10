// Camera mode catalogue + selection state. The 5 cinematic presets, chase
// and cockpit views per ship, plus the WebXR observer mode all live in one
// flat list addressed by index. The director picks from role pools rather
// than the full list.

export type CamPreset = { yaw: number; pitch: number; radius: number; height: number };
export type CamMode =
  | { kind: 'preset'; preset: CamPreset; label: string }
  | { kind: 'chase'; shipIdx: number; label: string }
  | { kind: 'cockpit'; shipIdx: number; label: string }
  | { kind: 'vr-observer'; label: string };

export const CAM_PRESETS: CamPreset[] = [
  { yaw: 0,        pitch: 0.0,  radius: 28, height: 9  }, // eye-level
  { yaw: 0.6,      pitch: 0.25, radius: 32, height: 14 }, // 3/4 high-side
  { yaw: -0.5,     pitch: -0.1, radius: 22, height: 6  }, // low-left
  { yaw: Math.PI,  pitch: 0.35, radius: 36, height: 18 }, // overhead reverse
  // True top-down. Tiny radius (=> small forward offset) keeps the camera's
  // up-vector well-defined; a pure (0, h, 0) → lookAt(0,0,0) is degenerate.
  { yaw: 0,        pitch: 0.0,  radius: 2,  height: 42 }, // straight overhead
];

/** Director role pools — indices into the full CAM_MODES list. */
export const MODE_ROLES = {
  calm:     [0, 2],
  active:   [0, 2, 5, 6, 7],
  dramatic: [1, 3, 4],
  rush:     [5, 6, 7, 8, 9, 10],
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
  };
}

/**
 * Pick a mode index from a role pool, avoiding the current mode and the last
 * two picks. Falls back gracefully when the constraint set empties.
 */
export function pickCinematicMode(sel: CameraSelection, role: ModeRole): number {
  const pool = MODE_ROLES[role];
  const fresh = pool.filter((idx) => idx !== sel.currentIdx && !sel.recentIdxs.includes(idx));
  const candidates = fresh.length > 0
    ? fresh
    : pool.filter((idx) => idx !== sel.currentIdx);
  const choice = candidates.length > 0
    ? candidates[(Math.random() * candidates.length) | 0]
    : pool[0];
  sel.recentIdxs.push(choice);
  if (sel.recentIdxs.length > 2) sel.recentIdxs.shift();
  return choice;
}

/** Switch to a mode and reset the cadence baselines so timing starts fresh. */
export function applyCut(sel: CameraSelection, idx: number, beatCount: number): void {
  sel.currentIdx = idx;
  sel.modeChangedAt = performance.now();
  sel.beatsAtChange = beatCount;
}

/** Index of the ship being tracked by chase/cockpit, or -1 otherwise. */
export function trackedShipIdx(sel: CameraSelection): number {
  const m = sel.modes[sel.currentIdx];
  return (m.kind === 'chase' || m.kind === 'cockpit') ? m.shipIdx : -1;
}

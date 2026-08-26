// Numeric constants used across the app. Pure data; no side effects.

// ----- terrain grid -----
export const COLS = 129; // freq axis (PlaneGeometry(_, _, 128, 128) → 129 verts)
export const ROWS = 129; // time axis
export const WIDTH = 50;
export const DEPTH = 50;
export const HEIGHT_SCALE = 7.0;
export const NOISE_AMP = 0.18;
// Row shaping — see the front-row write in main.ts. ROW_BLEND is how much of
// a new row is the fresh FFT vs. the previous row (1 = raw spikes); SWELL is
// the amplitude (u) of the slow rolling ground swell at full intensity.
export const TERRAIN_ROW_BLEND = 0.55;
export const TERRAIN_SWELL = 0.9;
// Beat breath envelope (1/s attack and release) and amplitude (fraction of
// height at full intensity). ~70 ms attack, ~350 ms release.
export const TERRAIN_BREATH_ATTACK = 14;
export const TERRAIN_BREATH_RELEASE = 2.8;
export const TERRAIN_BREATH_AMP = 0.07;

// ----- mood (see scene/mood.ts) -----
export const MOOD_ANTICIPATION_RISE_S = 1.2;
export const MOOD_ANTICIPATION_FALL_S = 2.5;
export const MOOD_FLASH_S = 0.28;          // flash-to-white decay
export const MOOD_AFTERGLOW_S = 2.2;       // lit sky / wide lens after the drop
export const MOOD_HUSH_RISE_S = 3.0;       // darkness arrives gently…
export const MOOD_HUSH_FALL_S = 0.5;       // …light returns at once
// What anticipation withholds and the drop releases.
export const MOOD_DIM_BUILD = 0.25;        // exposure fraction removed at full build
export const MOOD_DIM_HUSH = 0.6;          // terrain brightness removed in full hush
export const MOOD_FOG_BUILD = 0.35;        // fog range fraction pulled in at full build
export const MOOD_FLASH_EXPOSURE = 0.5;    // exposure added at the flash peak
export const MOOD_FLASH_BLOOM = 0.6;       // bloom strength added at the flash peak
export const MOOD_FOV_AFTERGLOW = 6;       // degrees of extra FOV at the drop
export const MOOD_CAM_PUSH = 7;            // preset dolly-in (u) at full build
export const MOOD_CAM_LOWER = 3.5;         // preset height drop (u) at full build
export const MOOD_FLOCK_TIGHTEN = 0.85;    // formation pull at full build
export const MOOD_FLOCK_LIFT = 3.0;        // cruise altitude added at full build (u)
export const MOOD_SCATTER_X = 14;          // lateral scatter impulse at the drop (u)
export const MOOD_SCATTER_S = 3.0;         // how long the scatter target holds
export const MOOD_DIVE_S = 1.1;            // dive after the drop
export const MOOD_DIVE_PITCH = 0.22;       // rad of nose-down during the dive

// ----- wingtip vapour (see scene/trails.ts) -----
// Vapour forms only under load: bank g-load, hard acceleration, the drop
// dive, an arrival surging in. LOAD_ON..LOAD_FULL is the smoothstep window
// on the smoothed load; the ribbon holds TRAIL_SAMPLES frames of history.
export const TRAIL_SAMPLES = 42;
export const TRAIL_ALPHA = 0.65;
export const TRAIL_LOAD_ON = 0.2;
export const TRAIL_LOAD_FULL = 0.7;
export const TRAIL_LOAD_SMOOTH_S = 0.18;

// ----- horizon light (see scene/sky.ts) -----
export const SKY_RADIUS = 190;             // inside camera.far (200), beyond the stars
// Azimuth of the light in the XZ plane: behind the grid from the presets'
// point of view, a little to the left, so a sunrise frames the far peaks.
export const SUN_AZIMUTH_X = -0.32;
export const SUN_AZIMUTH_Z = -1.0;
export const SUN_ELEV_MIN_DEG = -3;        // quiet: a glow below the horizon
export const SUN_ELEV_MAX_DEG = 14;        // full energy: risen
export const SUN_ARC_S = 8;                // time constant of the elevation's long arc
export const SUN_INTENSITY_MIN = 0.35;
export const SUN_HUSH_DIM = 0.55;          // fraction of light the hush removes
export const SUN_SHIP_RIM = 0.45;          // how strongly the ships' sun side brightens/warms
// Ship panels: frosted paper. Lighter and more translucent than a solid
// body so the sun shows through rather than being cut out.
export const SHIP_PANEL_COLOR = 0x141c40;
export const SHIP_PANEL_OPACITY = 0.58;
export const SUN_MOUNTAIN_HAZE = 0.85;     // how fully mountain lines take the haze colour against the glow
export const SUN_MOUNTAIN_RIM = 0.55;      // glow on crests facing the light

// ----- mountain ring (see scene/mountains.ts) -----
export const MOUNTAIN_RADII = [66, 72, 78, 84, 90, 97, 104, 112];
export const MOUNTAIN_SEGMENTS = 160;

// ----- post-processing -----
// Bloom RT divisor — half the canvas size keeps bloom roughly the same look
// at quarter the fragment cost (5-mip pyramid × 2 blurs each).
export const BLOOM_DIVISOR = 2;

// ----- terrain motion -----
// The spectrogram advances one grid row per frame toward −Z. Ships live in
// the landscape's reference frame, so they are advected by exactly this much
// each frame and must fly into the flow (+Z) to hold station.
export const TERRAIN_ROW_SPACING = DEPTH / (ROWS - 1);

// ----- ship flight model (kinematic coordinated flight, landscape frame) -----
export const SHIP_X_BOUND = WIDTH * 0.40;
export const SHIP_Z_MIN = -16;
export const SHIP_Z_MAX = 20;                // close enough to the front presets for near passes, never through them
export const SHIP_Z_CENTER = (SHIP_Z_MIN + SHIP_Z_MAX) * 0.5;
export const SHIP_Y_MIN = 1.4;
export const SHIP_Y_MAX = HEIGHT_SCALE * 1.5 + 1;
export const SHIP_CLEARANCE = 2.2;       // cruise height above the terrain envelope
export const SHIP_HARD_CLEAR = 0.95;     // hard collision safety margin (clears keel)
export const SHIP_LOOKAHEAD_DIST = 14.0; // envelope sample span ahead of the nose (u)
export const SHIP_MAX_BANK = 0.75;       // rad (≈43°)
export const SHIP_MAX_PITCH = 0.42;      // rad, flight-path angle

// Airspeed. Cruise ≈ ground flow (~23 u/s at 60 Hz) so a plane pointed into
// the flow holds station; the autopilot adds a surge to close Z error and the
// music adds its own — bass pushes the flock forward, quiet lets it fall back.
export const SHIP_SURGE_Z_GAIN = 0.6;     // u/s of airspeed per u of Z error
export const SHIP_SURGE_MAX = 7;          // station-keeping surge cap (u/s)
export const SHIP_SURGE_BASS = 6;         // extra airspeed at full bass (u/s)
export const SHIP_SURGE_BEAT = 2;         // per-beat nudge (u/s)
export const SHIP_SPEED_LERP = 1.2;       // 1/s ease toward commanded airspeed
export const SHIP_SPEED_MIN = 8;          // never slower than this (no stalls)
export const SHIP_GRAVITY_PATH = 5;       // a = -G · sin(pitch): dives speed up, climbs slow

// Coordinated turn: turnRate = TURN_G · tan(roll) / speed ≈ 0.5 rad/s at
// cruise and max bank.
export const SHIP_TURN_G = 12;
// Lateral guidance: desired sideways speed = LAT_GAIN × X error (capped),
// turned into a heading deviation from straight-into-the-flow.
export const SHIP_LAT_GAIN = 0.6;
export const SHIP_LAT_MAX = 10;           // u/s
export const SHIP_HEADING_TO_BANK = 1.6;  // rad of bank per rad of heading error
export const SHIP_YAW_DAMP = 0.5;         // bank command damping on current turn rate
export const SHIP_ROLL_RATE = 1.4;        // rad/s cap on roll — rolls in visibly, never snaps
export const SHIP_ROLL_LERP = 2.2;        // 1/s first-order ease toward the bank command
export const SHIP_PITCH_LERP = 1.6;       // 1/s first-order ease toward the pitch command

// Altitude hold. Commands a vertical speed (ALT_GAIN × error, capped at VY_MAX)
// and derives the path angle from it, so the loop closes on velocity and
// settles without a phugoid bounce.
export const SHIP_ALT_GAIN = 0.9;
export const SHIP_VY_MAX = 5;
export const SHIP_ALT_WANDER = 1.2;       // noise-driven cruise-altitude offset (u)
// Envelope follow: climb onto a rising envelope at this rate (1/s), sink
// away from a falling one at this speed (u/s) — fast up, lazy down.
export const SHIP_ENVELOPE_RISE = 3.0;
export const SHIP_ENVELOPE_SINK = 0.5;
export const SHIP_VISUAL_AOA = 0.07;      // nose-above-path angle for the mesh (rad)
// Acceleration → pitch. A paper plane gains speed by dropping its nose and
// sheds it by flaring, so the commanded path angle dips by ACCEL_TO_PITCH
// per u/s² of acceleration and the visible nose leads further by
// ACCEL_TO_NOSE. Smoothed over ACCEL_SMOOTH_S so beats read as a nod, not a
// twitch. At a full-bass onset (~7 u/s²) the nose drops ≈16°.
export const SHIP_ACCEL_TO_PITCH = 0.02;  // rad per u/s², flight path
export const SHIP_ACCEL_TO_NOSE = 0.02;   // rad per u/s², extra on the mesh
export const SHIP_ACCEL_SMOOTH_S = 0.25;

// ----- flock size -----
// Quiet music flies a single plane; the flock grows toward SHIP_MAX as the
// music intensifies and disperses again as it calms. Energy is normalised
// against a slowly decaying running maximum, so any source level works.
export const SHIP_MAX = 12;
export const FLOCK_ENERGY_RISE_S = 2.0;    // EMA time constant while energy is rising
export const FLOCK_ENERGY_FALL_S = 5.0;    // …and while falling — the flock lingers
export const FLOCK_MAX_MEMORY_S = 90;      // running-max memory (relative decay time constant)
export const FLOCK_JOIN_HOLD_S = 0.8;      // energy must ask for more for this long
export const FLOCK_LEAVE_HOLD_S = 2.5;     // …or for fewer for this long
export const FLOCK_JOIN_INTERVAL_S = 1.4;  // min spacing between arrivals
export const FLOCK_LEAVE_INTERVAL_S = 1.6; // min spacing between departures
export const FLOCK_JOIN_DIST = 26;         // arrivals spawn this far behind the box (u)
export const FLOCK_JOIN_SURGE = 14;        // extra airspeed while catching up (u/s)
export const FLOCK_LEAVE_DROP = 9;         // airspeed shed while peeling away (u/s)
export const FLOCK_FADE_S = 1.6;           // opacity fade in/out (s)

// Formation slots, leader-relative, for up to SHIP_MAX planes: a widening V
// trailing the leader. Noses point +Z (into the flow), so "behind" is −Z.
export const FORMATION_SLOTS: { dx: number; dz: number }[] = Array.from(
  { length: SHIP_MAX },
  (_, k) => {
    if (k === 0) return { dx: 0, dz: 0 };
    const rank = Math.ceil(k / 2);
    const side = k % 2 === 1 ? -1 : 1;
    return { dx: side * 3.2 * rank, dz: -2.6 * rank };
  },
);

// ----- camera spring (preset orbit) -----
// Critically damped and slow (ω ≈ 1.5 rad/s, ζ ≈ 1): a preset change glides
// over ~3 s with no overshoot. The old underdamped spring (ζ ≈ 0.6, ω ≈ 7)
// is what made every cut and bass kick read as a lurch.
export const CAM_STIFFNESS = 2.2;
export const CAM_DAMPING = 3.0;
export const CAM_BASS_IMPULSE = 0.03;     // whisper of sway on a kick
// Manual drag offsets relax back to the preset over this time constant (s).
export const CAM_DRAG_RELAX_S = 25;
// Slow ambient orbit drift so static shots keep breathing.
export const CAM_DRIFT_YAW = 0.10;        // rad amplitude
export const CAM_DRIFT_RATE = 0.06;       // rad/s
// Dolly ease toward a preset's radius/height (1/s).
export const CAM_DOLLY_LERP = 0.7;

// ----- chase camera -----
export const CHASE_BACK = 6.0;            // u behind the ship
export const CHASE_UP = 1.1;              // u above the ship — low, so the ship reads against sky
export const CHASE_LOOK_UP = 1.0;         // look-target lift above the ship (u)
export const CHASE_TERRAIN_CLEAR = 1.2;   // camera never dips closer than this to the grid
export const CHASE_LOOK_AHEAD = 4.0;      // look-target lead along the nose (u)
export const CHASE_POS_LERP = 3.0;        // 1/s ease of camera position
export const CHASE_LOOK_LERP = 4.5;       // 1/s ease of look target
export const CHASE_ROLL_FOLLOW = 0.35;    // fraction of ship bank the camera adopts

// ----- camera transitions -----
// Every mode change is a glide, never a cut: the camera pose eases from where
// it is to the new mode's live pose over this many seconds, arcing upward so
// it never ploughs through the grid on the way.
export const CAM_BLEND_S = 3.2;
export const CAM_BLEND_DROP_S = 1.8;      // drops earn a quicker move
export const CAM_BLEND_MANUAL_S = 2.0;    // C key
export const CAM_BLEND_ARC = 3.0;         // u of upward arc at mid-transition

// ----- audio gain stages feeding the BPM analyser -----
export const BPM_GAIN_FILE = 1.0;
export const BPM_GAIN_MIC = 8.0;

// ----- dynamics (drop/quiet/build detection) -----
export const DROP_RATIO_THRESHOLD = 1.4;   // short/mid ratio above this triggers a drop
export const DROP_REFRACTORY_MS = 1500;
export const QUIET_THRESHOLD = 0.05;

// ----- cinematic director pacing -----
export const SHOT_MIN_EVENT_MS = 14000;   // a drop/build/quiet may cut only after this
export const SHOT_MIN_CADENCE_MS = 18000; // beat-cadence cuts wait at least this long
export const BUILD_CUT_REFRACTORY_MS = 20000;
export const SHOT_FALLBACK_MS = 28000;    // no BPM lock → cut this often

// ----- visual rhyme (see camera/rhyme.ts) -----
export const RHYME_FEATURE_S = 3.0;        // fingerprint smoothing (s)
export const RHYME_MATCH_DIST = 0.14;      // max distance (4-D, 0..1 axes) to count as the same section
export const RHYME_MIN_AGE_S = 45;         // a memory must be at least this old to be recalled
export const RHYME_MAX_MEMORIES = 24;

// ----- pilot override -----
// Arrow-key presses in chase/cockpit extend the current shot by this much,
// preventing the music director from cutting away mid-flight.
export const PILOT_EXTEND_MS = 5000;

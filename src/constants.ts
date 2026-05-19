// Numeric constants used across the app. Pure data; no side effects.

// ----- terrain grid -----
export const COLS = 129; // freq axis (PlaneGeometry(_, _, 128, 128) → 129 verts)
export const ROWS = 129; // time axis
export const WIDTH = 50;
export const DEPTH = 50;
export const HEIGHT_SCALE = 7.0;
export const NOISE_AMP = 0.18;

// ----- post-processing -----
// Bloom RT divisor — half the canvas size keeps bloom roughly the same look
// at quarter the fragment cost (5-mip pyramid × 2 blurs each).
export const BLOOM_DIVISOR = 2;

// ----- ship flight model (Rapier rigid-body dynamics) -----
export const SHIP_X_BOUND = WIDTH * 0.40;
export const SHIP_Z_MIN = -16;
export const SHIP_Z_MAX = 18;
export const SHIP_Z_CENTER = (SHIP_Z_MIN + SHIP_Z_MAX) * 0.5;
export const SHIP_Y_MIN = 1.4;
export const SHIP_Y_MAX = HEIGHT_SCALE * 1.5 + 1;
export const SHIP_CLEARANCE = 1.5;       // soft clearance above forward-sampled terrain
export const SHIP_HARD_CLEAR = 0.95;     // hard collision safety margin (clears keel)
export const SHIP_LOOKAHEAD_DIST = 5.0;  // world units ahead to sample for altitude
export const SHIP_MAX_BANK = 0.95;       // rad
export const SHIP_MAX_PITCH = 0.55;      // rad

// Forces (N at 1 kg mass). Paper-plane drift: cruise ≈ sqrt(0.8/0.05) ≈ 4 u/s
// baseline, sqrt(1.5/0.05) ≈ 5.5 u/s at full bass.
export const SHIP_THRUST_BASE = 0.8;
export const SHIP_THRUST_BOOST = 0.7;     // additional with full bass
export const SHIP_THRUST_BEAT = 0.2;      // per-beat impulse
export const SHIP_DRAG_K = 0.05;          // F_drag = K · |v| · v

// Lift = K · CL(α) · |v|², along body-up. K_lift is high to compensate for the
// slow cruise speed (lift goes as v²; halving v ⇒ ¼ the lift, so K up to keep
// lift in the right range to balance gravity).
export const SHIP_LIFT_K = 0.15;
export const SHIP_CL_SLOPE = 6.28;        // ∂CL/∂α at low AoA
export const SHIP_CL_MAX = 1.4;           // saturation (real airfoils stall here)
// Autopilot mapping. The pitch target also includes a velocity-aware AoA trim
// (computed in ship.ts) so the plane carries the AoA needed to balance gravity
// at its current speed.
export const SHIP_HEADING_TO_BANK = 0.5;
export const SHIP_ALT_TO_PITCH = 0.30;
export const SHIP_PITCH_VY_DAMP = 0.04;   // gentle phugoid damper (used to be a feedback amplifier when too high)

// Kinematic attitude rates. All three are first-order-lerp coefficients (1/s).
// SHIP_YAW_RATE now governs how fast the mesh's heading slews toward the
// velocity vector (so the nose tracks motion direction); lower = floatier
// turn-in lag, higher = nose snaps to velocity.
export const SHIP_YAW_RATE = 3.0;
export const SHIP_PITCH_LERP = 1.5;
export const SHIP_ROLL_LERP = 1.5;

// World gravity — light so the paper plane glides at low cruise speeds.
// Cruise AoA solves K_lift·CL_slope·α·v² = g → α ≈ 7° at v=5.5, which fits
// comfortably below MAX_PITCH and stall.
export const SHIP_GRAVITY = 3.5;

// Slot offsets in the formation, leader-relative. ships[0] is the leader.
export const FORMATION_SLOTS: { dx: number; dz: number }[] = [
  { dx: 0,    dz: 0 },    // leader
  { dx: -3.5, dz: 2.5 },  // wing-left, slightly behind
  { dx: 3.5,  dz: 2.5 },  // wing-right, slightly behind
];

// ----- camera spring (preset orbit) -----
export const CAM_STIFFNESS = 50;
export const CAM_DAMPING = 9;
export const CAM_BASS_IMPULSE = 0.6;

// ----- audio gain stages feeding the BPM analyser -----
export const BPM_GAIN_FILE = 1.0;
export const BPM_GAIN_MIC = 8.0;

// ----- dynamics (drop/quiet/build detection) -----
export const DROP_RATIO_THRESHOLD = 1.4;   // short/mid ratio above this triggers a drop
export const DROP_REFRACTORY_MS = 1500;
export const QUIET_THRESHOLD = 0.05;

// ----- pilot override -----
// Arrow-key presses in chase/cockpit extend the current shot by this much,
// preventing the music director from cutting away mid-flight.
export const PILOT_EXTEND_MS = 5000;

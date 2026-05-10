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

// ----- ship flight model -----
export const SHIP_X_BOUND = WIDTH * 0.40;
export const SHIP_Z_MIN = -16;
export const SHIP_Z_MAX = 18;
export const SHIP_Z_CENTER = (SHIP_Z_MIN + SHIP_Z_MAX) * 0.5;
export const SHIP_Y_MIN = 1.4;
export const SHIP_Y_MAX = HEIGHT_SCALE * 1.5 + 1;
export const SHIP_CLEARANCE = 1.5;       // soft clearance above forward-sampled terrain
export const SHIP_HARD_CLEAR = 0.95;     // hard collision safety margin (clears keel)
export const SHIP_LOOKAHEAD_DIST = 5.0;  // world units ahead to sample for altitude
export const SHIP_BASE_SPEED = 8;        // units/sec at idle
export const SHIP_SPEED_BOOST = 14;      // additional with full bass
export const SHIP_ACCEL_RATE = 1.6;      // 1/sec lerp toward target speed
export const SHIP_TURN_RATE = 1.8;       // rad/sec maximum yaw rate
export const SHIP_TURN_GAIN = 2.5;       // P-controller on heading error
export const SHIP_TURN_SLOWDOWN = 0.30;  // fractional speed loss at full turn input
export const SHIP_MAX_BANK = 0.95;       // rad
export const SHIP_MAX_PITCH = 0.55;      // rad
export const SHIP_PITCH_GAIN = 0.06;     // pitch per (unit/sec) of climb rate

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

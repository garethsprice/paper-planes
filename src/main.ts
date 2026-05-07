import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { createNoise3D } from 'simplex-noise';
import { createRealtimeBpmAnalyzer, getBiquadFilter, type BpmAnalyzer } from 'realtime-bpm-analyzer';

// ----- grid params -----
const COLS = 129; // freq axis (PlaneGeometry(_, _, 128, 128) → 129 verts)
const ROWS = 129; // time axis
const WIDTH = 50;
const DEPTH = 50;
const HEIGHT_SCALE = 7.0;
const NOISE_AMP = 0.18;

// ----- DOM -----
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const fileInput = document.getElementById('file') as HTMLInputElement;
const playBtn = document.getElementById('play') as HTMLButtonElement;
const micBtn = document.getElementById('mic') as HTMLButtonElement;
const tabBtn = document.getElementById('tab') as HTMLButtonElement;
const uiEl = document.getElementById('ui') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const bpmNumEl = document.querySelector('#bpm .num') as HTMLSpanElement;
const bpmDotEl = document.getElementById('bpm-dot') as HTMLSpanElement;

// ----- three.js core -----
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x000308);
const fog = new THREE.Fog(0x000308, 18, 60);
scene.fog = fog;

const camera = new THREE.PerspectiveCamera(
  55,
  window.innerWidth / window.innerHeight,
  0.1,
  200,
);
camera.position.set(0, 9, 26);
camera.lookAt(0, 0, 0);

const renderer = new THREE.WebGLRenderer({
  canvas,
  antialias: true,
  powerPreference: 'high-performance',
});
// DPR cap of 1.5 (was 2): on HiDPI screens this halves per-pixel fragment
// work vs an uncapped 2.0 with negligible visual cost on glow-heavy lines.
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
renderer.setSize(window.innerWidth, window.innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

// ----- post-processing (bloom for the Tron-grid glow) -----
// Bloom resolution is the dominant GPU cost (5-mip pyramid × 2 blurs each).
// Pass half the canvas size so the internal pyramid is quarter-area —
// bloom is intrinsically blurry, the difference is barely visible.
const BLOOM_DIVISOR = 2;
const bloomRes = new THREE.Vector2(
  window.innerWidth / BLOOM_DIVISOR,
  window.innerHeight / BLOOM_DIVISOR,
);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(
  bloomRes,
  0.65, // strength (was 0.85; lower-res RT needs less amplification)
  0.55, // radius
  0.05, // threshold
);
composer.addPass(bloom);

// Chromatic aberration: subtle radial RGB split, expands on bass.
const ChromaticAberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0.002 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float r = texture2D(tDiffuse, vUv - dir * uAmount).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv + dir * uAmount).b;
      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `,
};
const chromaticPass = new ShaderPass(ChromaticAberrationShader);
composer.addPass(chromaticPass);

composer.addPass(new OutputPass());

// ----- terrain geometry: a regular grid drawn as line segments -----
// We build positions ourselves so we can mutate Y per-frame; index buffer
// defines horizontal + vertical edges.
const positions = new Float32Array(COLS * ROWS * 3);
for (let iy = 0; iy < ROWS; iy++) {
  for (let ix = 0; ix < COLS; ix++) {
    const i = (iy * COLS + ix) * 3;
    positions[i] = (ix / (COLS - 1) - 0.5) * WIDTH;
    positions[i + 1] = 0;
    // iy=0 is far (oldest); iy=ROWS-1 is closest to camera (newest)
    positions[i + 2] = (iy / (ROWS - 1) - 0.5) * DEPTH;
  }
}

const lineIndex: number[] = [];
// horizontal edges (along freq axis)
for (let iy = 0; iy < ROWS; iy++) {
  for (let ix = 0; ix < COLS - 1; ix++) {
    lineIndex.push(iy * COLS + ix, iy * COLS + ix + 1);
  }
}
// vertical edges (along time axis)
for (let ix = 0; ix < COLS; ix++) {
  for (let iy = 0; iy < ROWS - 1; iy++) {
    lineIndex.push(iy * COLS + ix, (iy + 1) * COLS + ix);
  }
}

const geometry = new THREE.BufferGeometry();
const posAttr = new THREE.BufferAttribute(positions, 3);
posAttr.setUsage(THREE.DynamicDrawUsage);
geometry.setAttribute('position', posAttr);
geometry.setIndex(lineIndex);
geometry.computeBoundingSphere();

// ----- shader material: height→color, fog, distance fade -----
// Shared uniform refs — both the real and mirror materials see the SAME
// {value:...} objects for everything except uOpacity. JS-side updates to
// uTime/uHeightMul/uHueShift propagate to both meshes via shared reference.
// (Don't reassign material.uniforms.X = {value:...}; mutate .value only.)
const sharedUniforms = {
  uTime: { value: 0 },
  uFogNear: { value: fog.near },
  uFogFar: { value: fog.far },
  uFogColor: { value: new THREE.Color(0x000308) },
  uHeightScale: { value: HEIGHT_SCALE },
  uDepthHalf: { value: DEPTH * 0.5 },
  uHeightMul: { value: 1.0 },  // beat-pulse pumps the whole landscape vertically
  uHueShift: { value: 0.0 },   // BPM-driven hue rotation
};
const uniforms = {
  ...sharedUniforms,
  uOpacity: { value: 1.0 },
};

const TERRAIN_VERTEX_SHADER = /* glsl */ `
  varying float vHeight;
  varying float vViewDist;
  varying float vRowAge;
  varying vec2 vWorldXZ;
  uniform float uDepthHalf;
  uniform float uHeightMul;

  void main() {
    vec3 p = vec3(position.x, position.y * uHeightMul, position.z);
    vHeight = p.y;
    vWorldXZ = vec2(position.x, position.z); // grid has no x/z transform — local == world
    // rowAge: 0 at front (newest) → 1 at back (oldest)
    vRowAge = clamp((uDepthHalf - p.z) / (uDepthHalf * 2.0), 0.0, 1.0);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    vViewDist = -mv.z;
    gl_Position = projectionMatrix * mv;
  }
`;
const material = new THREE.ShaderMaterial({
  uniforms,
  transparent: false, // depth writes preserved on the real grid
  vertexShader: TERRAIN_VERTEX_SHADER,
  fragmentShader: '',
});
const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
  varying float vHeight;
  varying float vViewDist;
  varying float vRowAge;
  varying vec2 vWorldXZ;
  uniform float uTime;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform vec3 uFogColor;
  uniform float uHeightScale;
  uniform float uHueShift;
  uniform float uOpacity;

  // cool → hot gradient
  vec3 grade(float t) {
    vec3 c0 = vec3(0.02, 0.05, 0.18);
    vec3 c1 = vec3(0.05, 0.30, 0.75);
    vec3 c2 = vec3(0.10, 0.85, 0.95);
    vec3 c3 = vec3(0.95, 0.25, 0.60);
    vec3 c4 = vec3(1.00, 0.65, 0.20);
    vec3 c5 = vec3(1.00, 0.98, 0.85);
    if (t < 0.2)  return mix(c0, c1, t / 0.2);
    if (t < 0.45) return mix(c1, c2, (t - 0.2) / 0.25);
    if (t < 0.7)  return mix(c2, c3, (t - 0.45) / 0.25);
    if (t < 0.88) return mix(c3, c4, (t - 0.7) / 0.18);
    return mix(c4, c5, (t - 0.88) / 0.12);
  }

  vec3 rgb2hsv(vec3 c) {
    vec4 K = vec4(0.0, -1.0/3.0, 2.0/3.0, -1.0);
    vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
    vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
    float d = q.x - min(q.w, q.y);
    float e = 1.0e-10;
    return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
  }
  vec3 hsv2rgb(vec3 c) {
    vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
    vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
    return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
  }

  void main() {
    float h = clamp(vHeight / uHeightScale, 0.0, 1.0);
    vec3 col = grade(h);

    // brightness boost on peaks → bloom catches them
    col *= 0.8 + 1.6 * h;

    // iridescent hue: BPM offset + position+time noise (oil-slick shimmer)
    float hueNoise =
      sin(vWorldXZ.x * 0.18 + uTime * 0.30) *
      cos(vWorldXZ.y * 0.18 + uTime * 0.22) * 0.06;
    float totalHue = uHueShift + hueNoise;
    if (abs(totalHue) > 0.001) {
      vec3 hsv = rgb2hsv(col);
      hsv.x = fract(hsv.x + totalHue);
      col = hsv2rgb(hsv);
    }

    // fade old rows toward black for depth
    float ageFade = 1.0 - smoothstep(0.55, 1.0, vRowAge);
    col *= ageFade;

    // distance fog
    float fogF = smoothstep(uFogNear, uFogFar, vViewDist);
    col = mix(col, uFogColor, fogF);

    gl_FragColor = vec4(col, uOpacity);
  }
`;
material.fragmentShader = TERRAIN_FRAGMENT_SHADER;
material.needsUpdate = true;

// ----- mirror world: same geometry/shader, flipped Y, dimmer -----
const mirrorMaterial = new THREE.ShaderMaterial({
  uniforms: { ...sharedUniforms, uOpacity: { value: 0.10 } },
  vertexShader: TERRAIN_VERTEX_SHADER,
  fragmentShader: TERRAIN_FRAGMENT_SHADER,
  transparent: true,
  depthWrite: false, // don't occlude the real terrain
});

const grid = new THREE.LineSegments(geometry, material);
scene.add(grid);

const mirrorGrid = new THREE.LineSegments(geometry, mirrorMaterial);
mirrorGrid.scale.y = -1; // reflects the terrain straight down through the y=0 plane
scene.add(mirrorGrid);

// ----- star field — points at far radius, slow rotation for parallax -----
const stars = (() => {
  const STAR_COUNT = 600;
  const starPos = new Float32Array(STAR_COUNT * 3);
  for (let i = 0; i < STAR_COUNT; i++) {
    // upper-hemisphere bias so stars sit above the camera horizon, not under
    // the terrain.
    const r = 90 + Math.random() * 40;
    const theta = Math.random() * Math.PI * 2;
    const phi = (0.05 + Math.random() * 0.55) * Math.PI;
    starPos[i * 3]     = r * Math.sin(phi) * Math.cos(theta);
    starPos[i * 3 + 1] = r * Math.cos(phi);
    starPos[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const starGeom = new THREE.BufferGeometry();
  starGeom.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  const starMat = new THREE.PointsMaterial({
    color: 0xc8d8ff,
    size: 0.45,
    sizeAttenuation: true,
    fog: false,
    transparent: true,
    opacity: 0.75,
    depthWrite: false,
  });
  const s = new THREE.Points(starGeom, starMat);
  scene.add(s);
  return s;
})();

// ----- particle nebula — soft glowing dots between camera and terrain -----
const nebula = (() => {
  const N = 400;
  const positions = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    // cylindrical region: radius 8-30, mid-altitude, bias slightly toward
    // foreground so the haze layers in front of the spectrogram.
    const theta = Math.random() * Math.PI * 2;
    const r = 8 + Math.random() * 22;
    const y = 1.5 + Math.random() * 16;
    positions[i * 3]     = Math.cos(theta) * r;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = Math.sin(theta) * r;
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    size: 1.3,
    sizeAttenuation: true,
    transparent: true,
    opacity: 0.32,
    blending: THREE.AdditiveBlending,
    depthWrite: false,
    fog: true,
    color: 0x80b8ff,
  });
  const p = new THREE.Points(geom, mat);
  p.visible = false; // hidden by default — N toggles
  scene.add(p);
  return p;
})();

// ----- ship: Asteroids-style triangle, autopiloted with a simple flight model -----
// State: heading angle (yaw around world Y), scalar speed, separate altitude.
// Each frame: pick a wandering target (audio centroid + slow simplex noise),
// rotate heading toward it at a limited turn rate, accelerate speed toward
// (base + bass*boost), integrate position with dt, then bank/pitch from
// turn-input and climb-rate. Three.js Euler order 'YXZ' = aircraft yaw→pitch→roll.
const SHIP_X_BOUND = WIDTH * 0.40;
const SHIP_Z_MIN = -16;
const SHIP_Z_MAX = 18;
const SHIP_Z_CENTER = (SHIP_Z_MIN + SHIP_Z_MAX) * 0.5;
const SHIP_Y_MIN = 1.4;
const SHIP_Y_MAX = HEIGHT_SCALE * 1.5 + 1;
const SHIP_CLEARANCE = 1.5;       // soft clearance above forward-sampled terrain
const SHIP_HARD_CLEAR = 0.95;     // hard collision safety margin (clears keel)
const SHIP_LOOKAHEAD_DIST = 5.0;  // world units ahead to sample for altitude
const SHIP_BASE_SPEED = 8;        // units/sec at idle
const SHIP_SPEED_BOOST = 14;      // additional with full bass
const SHIP_ACCEL_RATE = 1.6;      // 1/sec lerp toward target speed
const SHIP_TURN_RATE = 1.8;       // rad/sec maximum yaw rate
const SHIP_TURN_GAIN = 2.5;       // P-controller on heading error
const SHIP_TURN_SLOWDOWN = 0.30;  // fractional speed loss at full turn input
const SHIP_MAX_BANK = 0.95;       // rad
const SHIP_MAX_PITCH = 0.55;      // rad
const SHIP_PITCH_GAIN = 0.06;     // pitch per (unit/sec) of climb rate

const shipGeom = new THREE.BufferGeometry();
{
  // Wedge with a sharp nose: the existing flat triangle on top, plus a
  // single keel-tail vertex at the back-bottom. The "line down the middle"
  // is now a diagonal from the nose tapering down-and-back to the keel-tail
  // — looks more aerodynamic, like an arrowhead. Back keeps its height.
  const s = 1.1;
  const k = 0.7; // back-keel depth
  const v = new Float32Array([
    // top (Asteroids triangle outline)
    0,         0,  -1.3 * s,  // 0: nose (single sharp point)
    -0.75 * s, 0,   0.85 * s, // 1: back-left wing
    0,         0,   0.45 * s, // 2: back-notch (top of rear face)
    0.75 * s,  0,   0.85 * s, // 3: back-right wing
    // keel — only at the back; tapers to the nose point
    0,        -k,   0.45 * s, // 4: keel-tail (bottom of rear face)
  ]);
  shipGeom.setAttribute('position', new THREE.BufferAttribute(v, 3));
  shipGeom.setIndex([
    // top outline
    0, 1,  1, 2,  2, 3,  3, 0,
    // diagonal belly seam: nose tapers down to the back keel
    0, 4,
    // rear vertical (notch ↔ keel-tail) — gives the back its height
    2, 4,
    // wing tips drop to the keel — defines the side panels
    1, 4,  3, 4,
  ]);
}
const shipMat = new THREE.LineBasicMaterial({ color: 0xeaffff, fog: false });

// ----- ships: 3 instances, each with its own wander phase, position, and trail.
type Ship = {
  group: THREE.Group;
  heading: number;
  speed: number;
  pitch: number;
  roll: number;
  prevY: number;
  wanderSeed: number;
};

function makeShip(seed: number, x0: number, z0: number): Ship {
  const group = new THREE.Group();
  group.rotation.order = 'YXZ';
  group.add(new THREE.LineSegments(shipGeom, shipMat));
  group.position.set(x0, 4, z0);
  scene.add(group);
  return {
    group,
    heading: 0,
    speed: SHIP_BASE_SPEED,
    pitch: 0,
    roll: 0,
    prevY: 4,
    wanderSeed: seed,
  };
}

// Three ships, staggered so they don't pile up at the same point
const ships: Ship[] = [
  makeShip(13.7, 0, SHIP_Z_CENTER),
  makeShip(67.3, -10, SHIP_Z_CENTER + 4),
  makeShip(141.9, 10, SHIP_Z_CENTER - 4),
];

function bilerpHeight(wx: number, wz: number): number {
  const fx = (wx / WIDTH + 0.5) * (COLS - 1);
  const fz = (wz / DEPTH + 0.5) * (ROWS - 1);
  const ix0 = Math.max(0, Math.min(COLS - 2, Math.floor(fx)));
  const iz0 = Math.max(0, Math.min(ROWS - 2, Math.floor(fz)));
  const tx = Math.max(0, Math.min(1, fx - ix0));
  const tz = Math.max(0, Math.min(1, fz - iz0));
  const h00 = heights[iz0 * COLS + ix0];
  const h10 = heights[iz0 * COLS + ix0 + 1];
  const h01 = heights[(iz0 + 1) * COLS + ix0];
  const h11 = heights[(iz0 + 1) * COLS + ix0 + 1];
  return (
    h00 * (1 - tx) * (1 - tz) +
    h10 * tx * (1 - tz) +
    h01 * (1 - tx) * tz +
    h11 * tx * tz
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function wrapAngle(a: number): number {
  // wrap to (-π, π]
  return ((a + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;
}

function updateShip(ship: Ship, dt: number, time: number, level: number, centroid: number): void {
  const pos = ship.group.position;
  // 1. wandering target — slow simplex noise + audio centroid pull
  const wanderX = noise3(time * 0.07, ship.wanderSeed, 0) * SHIP_X_BOUND;
  const wanderZ =
    noise3(time * 0.06, ship.wanderSeed + 100, 0) *
      (SHIP_Z_MAX - SHIP_Z_MIN) * 0.45 +
    SHIP_Z_CENTER;
  const centroidShift = (centroid - 0.5) * 2 * SHIP_X_BOUND * 0.5;
  const targetX = clamp(wanderX * 0.55 + centroidShift * 0.6, -SHIP_X_BOUND, SHIP_X_BOUND);
  const targetZ = clamp(wanderZ, SHIP_Z_MIN, SHIP_Z_MAX);

  // 2. heading toward target
  const dx = targetX - pos.x;
  const dz = targetZ - pos.z;
  const dist = Math.hypot(dx, dz);
  let desiredHeading = ship.heading;
  if (dist > 0.5) desiredHeading = Math.atan2(-dx, -dz);
  const headingErr = wrapAngle(desiredHeading - ship.heading);
  const turnInput = clamp(headingErr * SHIP_TURN_GAIN, -1, 1);
  ship.heading = wrapAngle(ship.heading + turnInput * SHIP_TURN_RATE * dt);

  // 3. speed — accelerate toward (base + bass thrust); turning costs speed; beat kick
  const targetSpeed = SHIP_BASE_SPEED + bassEnergy * SHIP_SPEED_BOOST;
  ship.speed += (targetSpeed - ship.speed) * SHIP_ACCEL_RATE * dt;
  const effSpeed =
    ship.speed * (1 - SHIP_TURN_SLOWDOWN * Math.abs(turnInput))
    * (1 + beatPulse * 0.45);

  // 4. integrate position
  const fwdX = -Math.sin(ship.heading);
  const fwdZ = -Math.cos(ship.heading);
  pos.x = clamp(pos.x + fwdX * effSpeed * dt, -SHIP_X_BOUND, SHIP_X_BOUND);
  pos.z = clamp(pos.z + fwdZ * effSpeed * dt, SHIP_Z_MIN, SHIP_Z_MAX);

  // 5. altitude
  const aheadX = pos.x + fwdX * SHIP_LOOKAHEAD_DIST;
  const aheadZ = pos.z + fwdZ * SHIP_LOOKAHEAD_DIST;
  const tHere = bilerpHeight(pos.x, pos.z);
  const tAhead = bilerpHeight(aheadX, aheadZ);
  const audioLift = level * 3.0;
  let targetY = Math.max(Math.max(tHere, tAhead) + SHIP_CLEARANCE, SHIP_Y_MIN + audioLift);
  targetY = Math.min(SHIP_Y_MAX, targetY);
  ship.prevY = pos.y;
  pos.y += (targetY - pos.y) * (1 - Math.exp(-6 * dt));
  const tSafe = bilerpHeight(pos.x, pos.z);
  if (pos.y < tSafe + SHIP_HARD_CLEAR) pos.y = tSafe + SHIP_HARD_CLEAR;

  // 6. orientation
  const climbRate = (pos.y - ship.prevY) / Math.max(dt, 1e-3);
  const targetRoll = turnInput * SHIP_MAX_BANK;
  const targetPitch = clamp(climbRate * SHIP_PITCH_GAIN, -SHIP_MAX_PITCH, SHIP_MAX_PITCH);
  const orientLerp = 1 - Math.exp(-7 * dt);
  ship.roll += (targetRoll - ship.roll) * orientLerp;
  ship.pitch += (targetPitch - ship.pitch) * orientLerp;
  ship.group.rotation.set(ship.pitch, ship.heading, ship.roll);
}

// ----- audio plumbing -----
let audioCtx: AudioContext | null = null;
let analyser: AnalyserNode | null = null;
// Typed as Uint8Array<ArrayBuffer> via assertion at create-time so newer TS
// (5.7+) accepts it as the AnalyserNode.getByteFrequencyData arg.
let fftBins: Uint8Array<ArrayBuffer> | null = null;
let currentSourceNode: AudioNode | null = null;
let micStream: MediaStream | null = null;
const audioEl = new Audio();
audioEl.crossOrigin = 'anonymous';

// BPM detection — realtime-bpm-analyzer wraps an AudioWorkletNode. The library
// recommends pre-filtering to a low-pass band so peak detection sees only the
// kick/bass region (functionally equivalent to running it at a much lower
// sample rate). We feed the source through a biquad lowpass before the worklet:
//   source → bpmFilter → bpmAnalyzer.node → destination
// Worklet creation is async so we cache both the resolved analyzer and the
// in-flight promise.
let bpmAnalyzer: BpmAnalyzer | null = null;
let bpmAnalyzerPromise: Promise<BpmAnalyzer> | null = null;
let bpmFilter: BiquadFilterNode | null = null;
let bpmGain: GainNode | null = null;
// Per-source gain into the BPM analyzer. Mic input is typically -20 to -30 dBFS
// (samples ~0.05-0.2) while the analyzer's peak detection only descends to a
// threshold of 0.2 — quiet mic audio never produces qualifying peaks. Boosting
// mic input ~4× brings it into the working range. File sources are usually
// near full-scale and use unity gain.
const BPM_GAIN_FILE = 1.0;
const BPM_GAIN_MIC = 8.0;
let bpm = 0;          // locked BPM (0 until first stable estimate)
let bpmCandidate = 0; // most recent top candidate (early-feedback display)
let bassEnergy = 0;   // mean of low-band FFT bins (drives bloom pulse)
let beatPulse = 0;    // 0..1, set to 1 on each validPeak event, decays per frame
let lastPeakAt = 0;   // ms timestamp of last triggered peak (refractory gate)
let lastBpmSourceNode: AudioNode | null = null; // tracked separately so we
// can disconnect it from bpmFilter without touching the analyser path.

function ensureAudio(): { ctx: AudioContext; analyser: AnalyserNode } {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext)();
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.8;
    fftBins = new Uint8Array(analyser.frequencyBinCount);
  }
  return { ctx: audioCtx, analyser: analyser! };
}

async function ensureBpm(): Promise<BpmAnalyzer | null> {
  if (bpmAnalyzer) return bpmAnalyzer;
  if (bpmAnalyzerPromise) return bpmAnalyzerPromise;
  const { ctx } = ensureAudio();
  // Gain stage — set per-source by connectBpmSource (1× for files, 4× for mic).
  bpmGain = ctx.createGain();
  bpmGain.gain.value = BPM_GAIN_FILE;
  // 200 Hz lowpass, Q=1 — focus the analyzer on kick/bass transients, ignore
  // hi-hats/cymbals/vocals that confuse peak detection.
  bpmFilter = getBiquadFilter(ctx);
  bpmGain.connect(bpmFilter);
  // continuousAnalysis: false — lock once and hold. Stops the readout from
  // wobbling on tracks where the analyzer's confidence drifts. Source change
  // calls bpmAnalyzer.reset() to re-analyze.
  // debug: true so the worklet emits 'validPeak' events for the dot indicator.
  bpmAnalyzerPromise = createRealtimeBpmAnalyzer(ctx, { continuousAnalysis: false, debug: true }).then((a) => {
    bpmFilter!.connect(a.node);
    // Connect the worklet's output to destination so Chrome doesn't prune it
    // from the graph. The processor doesn't write outputs (process() only
    // reads inputs), so the AudioWorkletNode emits zero samples — silent.
    a.node.connect(ctx.destination);

    a.on('bpm', (data) => {
      const top = data.bpm[0];
      if (top) bpmCandidate = top.tempo;
    });
    a.on('bpmStable', (data) => {
      const top = data.bpm[0];
      if (top) bpm = top.tempo; // snap; we lock once, no smoothing needed
    });
    a.on('error', (e) => {
      console.error('[bpm] analyzer error:', e);
    });
    a.on('validPeak', () => {
      // The analyzer descends through thresholds (0.95 → 0.2) and may emit
      // multiple validPeak events for one audio peak — gate to 250 ms
      // (240 BPM ceiling) so the dot flashes once per beat.
      const now = performance.now();
      if (now - lastPeakAt > 250) {
        beatPulse = 1.0;
        lastPeakAt = now;
        beatCount++;
      }
    });

    bpmAnalyzer = a;
    // expose for ad-hoc DevTools poking + filter/gain tuning
    (window as unknown as { __terrain?: unknown }).__terrain = {
      ctx, analyser, fftBins, bpmAnalyzer: a, bpmFilter, bpmGain,
      get bpm() { return bpm; },
      get bpmCandidate() { return bpmCandidate; },
      get bassEnergy() { return bassEnergy; },
      // tweak filter on the fly: __terrain.setFilter(150, 0.7)
      setFilter(freq: number, q: number) {
        if (bpmFilter) {
          bpmFilter.frequency.value = freq;
          bpmFilter.Q.value = q;
        }
      },
      // boost/cut the BPM chain input: __terrain.setGain(8) for very quiet mic
      setGain(g: number) {
        if (bpmGain) bpmGain.gain.value = g;
      },
      resetBpm() { bpm = 0; bpmCandidate = 0; a.reset(); },
    };
    return a;
  }).catch((err) => {
    console.warn('[bpm] analyzer unavailable:', err);
    return null as unknown as BpmAnalyzer;
  });
  return bpmAnalyzerPromise;
}

function connectBpmSource(src: AudioNode, gain: number) {
  ensureBpm().then((a) => {
    if (!a || !bpmGain) return;
    // disconnect previous source from the gain input
    if (lastBpmSourceNode) {
      try { lastBpmSourceNode.disconnect(bpmGain); } catch {}
    }
    bpmGain.gain.value = gain;
    src.connect(bpmGain);
    lastBpmSourceNode = src;
    // fresh source — clear any prior lock and reset the analyzer's internal
    // peak buffer so the new audio gets analyzed from scratch.
    bpm = 0;
    bpmCandidate = 0;
    a.reset();
  });
}

function disconnectCurrent() {
  if (currentSourceNode) {
    try { currentSourceNode.disconnect(); } catch {}
    currentSourceNode = null;
  }
  // currentSourceNode.disconnect() above already severs the source→bpmFilter
  // link since it's a no-arg disconnect — clear the cached ref so the next
  // connectBpmSource doesn't try to undo a connection that's already gone.
  lastBpmSourceNode = null;
  if (micStream) {
    micStream.getTracks().forEach((t) => t.stop());
    micStream = null;
  }
}

let currentObjectUrl: string | null = null;
function loadAudioFile(f: File) {
  const { ctx, analyser } = ensureAudio();
  disconnectCurrent();
  audioEl.pause();
  // Free the previous blob URL — otherwise the prior File stays alive in
  // memory for the lifetime of the page.
  if (currentObjectUrl) URL.revokeObjectURL(currentObjectUrl);
  currentObjectUrl = URL.createObjectURL(f);
  audioEl.src = currentObjectUrl;
  audioEl.load();
  // MediaElementAudioSourceNode can only be created once per element; cache it.
  let mediaSrc = (audioEl as any).__src as MediaElementAudioSourceNode | undefined;
  if (!mediaSrc) {
    mediaSrc = ctx.createMediaElementSource(audioEl);
    (audioEl as any).__src = mediaSrc;
  }
  mediaSrc.connect(analyser);
  analyser.connect(ctx.destination);
  connectBpmSource(mediaSrc, BPM_GAIN_FILE);
  currentSourceNode = mediaSrc;
  playBtn.disabled = false;
  playBtn.textContent = 'play';
  statusEl.textContent = f.name;
}
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadAudioFile(f);
});

// drag-and-drop audio onto the canvas
canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && (f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name))) {
    loadAudioFile(f);
  } else if (f) {
    statusEl.textContent = `unsupported file type: ${f.type || f.name}`;
  }
});

playBtn.addEventListener('click', async () => {
  const { ctx } = ensureAudio();
  if (ctx.state === 'suspended') await ctx.resume();
  if (audioEl.paused) {
    await audioEl.play();
    playBtn.textContent = 'pause';
  } else {
    audioEl.pause();
    playBtn.textContent = 'play';
  }
});

audioEl.addEventListener('ended', () => {
  playBtn.textContent = 'play';
});

function attachStream(stream: MediaStream, label: string, opts?: { audible?: boolean }) {
  const { ctx, analyser } = ensureAudio();
  audioEl.pause();
  disconnectCurrent();
  micStream = stream; // reuse cleanup path (track stop on disconnect)
  const src = ctx.createMediaStreamSource(stream);
  src.connect(analyser);
  // Tab audio: also connect to destination so the user hears the captured
  // audio (otherwise the visualization runs but they hear silence).
  // Mic: never connect to destination — feedback risk.
  if (opts?.audible) analyser.connect(ctx.destination);
  connectBpmSource(src, BPM_GAIN_MIC);
  currentSourceNode = src;
  playBtn.disabled = true;
  statusEl.textContent = label;
}

micBtn.addEventListener('click', async () => {
  try {
    const { ctx } = ensureAudio();
    if (ctx.state === 'suspended') await ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    attachStream(stream, 'mic live');
  } catch (e) {
    statusEl.textContent = `mic blocked: ${(e as Error).message}`;
  }
});

tabBtn.addEventListener('click', async () => {
  try {
    const { ctx } = ensureAudio();
    if (ctx.state === 'suspended') await ctx.resume();
    // getDisplayMedia requires video:true to be acceptable across browsers,
    // even when we only want the audio track. We stop the video track
    // immediately to avoid the encoded-frame overhead.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      statusEl.textContent = 'no tab audio — tick "share tab audio" in the picker';
      return;
    }
    attachStream(stream, 'tab audio', { audible: true });
  } catch (e) {
    statusEl.textContent = `tab audio failed: ${(e as Error).message}`;
  }
});

// ----- displacement state: per-vertex Y values, kept as a separate buffer
// to make the row-shift cheap (typed-array .copyWithin). -----
const heights = new Float32Array(COLS * ROWS);
const noise3 = createNoise3D();

// log-frequency bin lookup: which FFT bins to sample for each column
const binMap = new Float32Array(COLS);
{
  const minBin = 1; // skip DC
  const maxBin = 511; // analyser.frequencyBinCount - 1, given fftSize=1024
  for (let ix = 0; ix < COLS; ix++) {
    const t = ix / (COLS - 1);
    binMap[ix] = minBin * Math.pow(maxBin / minBin, t);
  }
}

function sampleLogBin(data: { length: number; [i: number]: number }, fbin: number): number {
  const lo = Math.floor(fbin);
  const hi = Math.min(lo + 1, data.length - 1);
  const frac = fbin - lo;
  return data[lo] * (1 - frac) + data[hi] * frac;
}

// ----- mouse orbit (subtle, custom) -----
// Spring physics on yaw/pitch: critically-underdamped → slight overshoot when
// targets change (manual drag end, cinematic preset switch, bass impulse).
let yaw = 0;
let pitch = 0;
let yawVel = 0;
let pitchVel = 0;
let prevBassForSpring = 0;
let targetYaw = 0;
let targetPitch = 0;
const CAM_STIFFNESS = 50;
const CAM_DAMPING = 9;
const CAM_BASS_IMPULSE = 0.6;
let dragging = false;
let lastX = 0;
let lastY = 0;
canvas.addEventListener('pointerdown', (e) => {
  dragging = true;
  lastX = e.clientX;
  lastY = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointerup', (e) => {
  dragging = false;
  try { canvas.releasePointerCapture(e.pointerId); } catch {}
});
canvas.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const dx = e.clientX - lastX;
  const dy = e.clientY - lastY;
  lastX = e.clientX;
  lastY = e.clientY;
  targetYaw += dx * 0.0035;
  targetPitch += dy * 0.0025;
  targetPitch = Math.max(-0.45, Math.min(0.55, targetPitch));
});

// auto-start mic on the first canvas click (user-gesture context for
// getUserMedia + AudioContext.resume). Bypassed if a source is already
// connected via file/mic button.
let autoMicTried = false;
canvas.addEventListener('click', () => {
  if (autoMicTried || currentSourceNode) return;
  autoMicTried = true;
  micBtn.click();
});

// ----- camera modes — auto-cycles every 8 beats, 'C' jumps to next now -----
type CamPreset = { yaw: number; pitch: number; radius: number; height: number };
type CamMode =
  | { kind: 'preset'; preset: CamPreset; label: string }
  | { kind: 'chase'; shipIdx: number; label: string }
  | { kind: 'cockpit'; shipIdx: number; label: string };

const CAM_PRESETS: CamPreset[] = [
  { yaw: 0,        pitch: 0.0,  radius: 28, height: 9  }, // eye-level
  { yaw: 0.6,      pitch: 0.25, radius: 32, height: 14 }, // 3/4 high-side
  { yaw: -0.5,     pitch: -0.1, radius: 22, height: 6  }, // low-left
  { yaw: Math.PI,  pitch: 0.35, radius: 36, height: 18 }, // overhead reverse
  // True top-down. Tiny radius (=> small forward offset) keeps the camera's
  // up-vector well-defined; a pure (0, h, 0) → lookAt(0,0,0) is degenerate.
  { yaw: 0,        pitch: 0.0,  radius: 2,  height: 42 }, // straight overhead
];

// 4 cinematic presets, then chase + cockpit per ship. 'C' cycles, auto-advance
// every 8 beats (or 8 s if BPM hasn't locked).
const CAM_MODES: CamMode[] = [
  ...CAM_PRESETS.map((preset, i): CamMode => ({ kind: 'preset', preset, label: `preset ${i + 1}` })),
  ...ships.map((_, i): CamMode => ({ kind: 'chase', shipIdx: i, label: `chase ship ${i + 1}` })),
  ...ships.map((_, i): CamMode => ({ kind: 'cockpit', shipIdx: i, label: `cockpit ship ${i + 1}` })),
];
let currentCamModeIdx = 0;
let camModeChangedAt = 0;       // ms timestamp of last cam switch
let camBeatsAtChange = 0;       // beatCount snapshot at last cam switch
let cinematicAuto = true;       // toggle with 'V' — when off, stays on current mode
let beatCount = 0;

// ----- keyboard shortcuts -----
document.addEventListener('keydown', (e) => {
  // ignore key events fired inside form fields
  if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
  switch (e.key.toLowerCase()) {
    case ' ':
      e.preventDefault();
      if (!playBtn.disabled) playBtn.click();
      break;
    case 'b':
      bloom.enabled = !bloom.enabled;
      statusEl.textContent = `bloom ${bloom.enabled ? 'on' : 'off'}`;
      break;
    case 'f':
      if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else document.exitFullscreen();
      break;
    case 'r':
      if (bpmAnalyzer) {
        bpm = 0;
        bpmCandidate = 0;
        bpmAnalyzer.reset();
        statusEl.textContent = 'bpm reset';
      }
      break;
    case 'n':
      nebula.visible = !nebula.visible;
      statusEl.textContent = `nebula ${nebula.visible ? 'on' : 'off'}`;
      break;
    case 'c':
      currentCamModeIdx = (currentCamModeIdx + 1) % CAM_MODES.length;
      camModeChangedAt = performance.now();
      camBeatsAtChange = beatCount;
      statusEl.textContent = `cam: ${CAM_MODES[currentCamModeIdx].label}`;
      break;
    case 'v':
      cinematicAuto = !cinematicAuto;
      camModeChangedAt = performance.now();
      camBeatsAtChange = beatCount;
      statusEl.textContent = `cinematic ${cinematicAuto ? 'on' : 'off'}`;
      break;
  }
});

// ----- UI auto-hide after 3 s of no interaction -----
let lastInteractionAt = performance.now();
const markInteraction = () => { lastInteractionAt = performance.now(); };
['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((ev) => {
  document.addEventListener(ev, markInteraction, { passive: true });
});

// ----- animation loop -----
const clock = new THREE.Clock();
const ROW_STRIDE_FRONT = (ROWS - 1) * COLS; // newest row offset in heights[]

function animate() {
  requestAnimationFrame(animate);
  // Skip all per-frame work when the tab is hidden — browsers throttle rAF to
  // 1Hz here anyway, but this prevents stale dt jumps on tab refocus.
  if (document.hidden) return;
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();
  uniforms.uTime.value = t;

  // shift heights[] rows toward iy=0 (away from camera).
  // copyWithin(target, start, end): destination = heights[0..(ROWS-1)*COLS],
  // source = heights[COLS .. ROWS*COLS]. That moves row iy+1 → row iy.
  heights.copyWithin(0, COLS, ROWS * COLS);

  // write new front row
  if (analyser && fftBins) {
    analyser.getByteFrequencyData(fftBins);
    // bass band (bins 1..19, ~40-800Hz) → drives bloom pulse + ship thrust
    let bs = 0;
    const bMax = Math.min(20, fftBins.length);
    for (let i = 1; i < bMax; i++) bs += fftBins[i];
    bassEnergy = bs / ((bMax - 1) * 255);
    const baseIdx = ROW_STRIDE_FRONT;
    for (let ix = 0; ix < COLS; ix++) {
      const amp = sampleLogBin(fftBins, binMap[ix]) / 255; // 0..1
      // slight perceptual curve so quiet bins still register
      const shaped = Math.pow(amp, 0.85);
      // simplex texture along the front row, slowly evolving with time
      const n = noise3(ix * 0.08, t * 0.35, 0) * NOISE_AMP;
      heights[baseIdx + ix] = shaped * HEIGHT_SCALE + n;
    }
  } else {
    bassEnergy = 0;
    // idle look — gently undulating noise field
    const baseIdx = ROW_STRIDE_FRONT;
    for (let ix = 0; ix < COLS; ix++) {
      const n =
        (noise3(ix * 0.08, t * 0.25, 0) * 0.5 + 0.5) * NOISE_AMP * 4;
      heights[baseIdx + ix] = n;
    }
  }

  // mix in low-amp simplex everywhere for surface texture between peaks
  // (cheap: only re-noise the front row each frame; older rows already have
  // their baked-in noise from when they were the front row)
  // …already done above.

  // copy heights → position attribute Y
  const pa = posAttr.array as Float32Array;
  for (let i = 0, p = 1; i < heights.length; i++, p += 3) {
    pa[p] = heights[i];
  }
  posAttr.needsUpdate = true;

  // overall audio level + spectral centroid — shared across all ships
  let level = 0;
  let centroid = 0.5;
  if (fftBins) {
    let sumAll = 0;
    for (let i = 0; i < fftBins.length; i++) sumAll += fftBins[i];
    level = sumAll / (fftBins.length * 255);
    let cn = 0, cd = 0;
    for (let i = 1; i < fftBins.length; i++) { cn += i * fftBins[i]; cd += fftBins[i]; }
    if (cd > 0) centroid = cn / cd / (fftBins.length - 1);
  }
  for (const ship of ships) updateShip(ship, dt, t, level, centroid);

  // auto-advance camera mode every 8 beats (BPM-locked) or 8 s fallback —
  // only when cinematic auto-cycle is on. 'V' toggles, 'C' jumps regardless.
  if (cinematicAuto) {
    const beatsPerSwitch = 8;
    const fallbackMs = 8000;
    const ready = bpm > 0
      ? beatCount - camBeatsAtChange >= beatsPerSwitch
      : performance.now() - camModeChangedAt >= fallbackMs;
    if (ready) {
      currentCamModeIdx = (currentCamModeIdx + 1) % CAM_MODES.length;
      camModeChangedAt = performance.now();
      camBeatsAtChange = beatCount;
    }
  }

  // restore visibility every frame; the active cockpit mode hides its own ship.
  for (const s of ships) s.group.visible = true;

  const camMode = CAM_MODES[currentCamModeIdx];
  if (camMode.kind === 'preset') {
    // spring orbit around origin, with bass attack impulse on yaw and bass
    // amplitude pulling the radius in.
    const p = camMode.preset;
    targetYaw = p.yaw;
    targetPitch = p.pitch;
    const bassDelta = bassEnergy - prevBassForSpring;
    prevBassForSpring = bassEnergy;
    if (bassDelta > 0.05) yawVel += bassDelta * CAM_BASS_IMPULSE;
    const yawAccel = (targetYaw - yaw) * CAM_STIFFNESS - yawVel * CAM_DAMPING;
    yawVel += yawAccel * dt;
    yaw += yawVel * dt;
    const pitchAccel = (targetPitch - pitch) * CAM_STIFFNESS - pitchVel * CAM_DAMPING;
    pitchVel += pitchAccel * dt;
    pitch += pitchVel * dt;
    const radius = p.radius - bassEnergy * 2.5;
    camera.position.x = Math.sin(yaw) * radius;
    camera.position.z = Math.cos(yaw) * radius;
    camera.position.y = p.height + pitch * 12;
    camera.lookAt(0, 1.5, 0);
  } else if (camMode.kind === 'chase') {
    // 5 units behind the ship, 2.5 above; lerp-smoothed so the camera doesn't
    // jitter when the ship banks hard. Looking ~3 units ahead so the ship
    // sits in the lower portion of the frame.
    const ship = ships[camMode.shipIdx];
    const sp = ship.group.position;
    const fwdX = -Math.sin(ship.heading);
    const fwdZ = -Math.cos(ship.heading);
    const desiredX = sp.x - fwdX * 5;
    const desiredY = sp.y + 2.5;
    const desiredZ = sp.z - fwdZ * 5;
    const k = 1 - Math.exp(-8 * dt);
    camera.position.x += (desiredX - camera.position.x) * k;
    camera.position.y += (desiredY - camera.position.y) * k;
    camera.position.z += (desiredZ - camera.position.z) * k;
    camera.lookAt(sp.x + fwdX * 3, sp.y, sp.z + fwdZ * 3);
  } else {
    // cockpit: locked to the ship's nose, looking forward; hide own ship.
    const ship = ships[camMode.shipIdx];
    ship.group.visible = false;
    const sp = ship.group.position;
    const fwdX = -Math.sin(ship.heading);
    const fwdZ = -Math.cos(ship.heading);
    camera.position.set(sp.x + fwdX * 0.3, sp.y + 0.05, sp.z + fwdZ * 0.3);
    camera.lookAt(sp.x + fwdX * 12, sp.y + 0.05, sp.z + fwdZ * 12);
  }

  // beat pulse breathes the whole landscape vertically
  uniforms.uHeightMul.value = 1.0 + beatPulse * 0.10;
  // very subtle star parallax
  stars.rotation.y += 0.0003;
  // nebula rotates faster than stars; bass drops accelerate the swirl
  nebula.rotation.y += 0.0008 + bassEnergy * 0.004;
  // recolor by spectral centroid: bass-heavy → cool blue, treble-heavy → warm pink
  (nebula.material as THREE.PointsMaterial).color.setRGB(
    0.45 + centroid * 0.55,
    0.55 + 0.10 * (1 - centroid),
    0.95 - centroid * 0.30,
  );

  // UI auto-hide
  const idle = performance.now() - lastInteractionAt > 3000;
  if (idle !== uiEl.classList.contains('idle')) {
    uiEl.classList.toggle('idle', idle);
  }
  // hue: BPM offset + slow time cycle. Per-pixel iridescent shimmer is added
  // in the fragment shader on top of this base value (using uTime).
  const tempoForHue = bpm > 0 ? bpm : 120;
  const bpmHue = Math.max(-0.05, Math.min(0.05, (tempoForHue - 120) / 60 * 0.05));
  uniforms.uHueShift.value = bpmHue + Math.sin(t * 0.07) * 0.04;

  // bloom kick on bass transients (decoupled from BPM lock — reacts to energy)
  bloom.strength = 0.65 + bassEnergy * 0.5;
  // chromatic aberration pulses with bass
  chromaticPass.uniforms.uAmount.value = Math.min(0.008, 0.0015 + bassEnergy * 0.006);

  // beat-dot pulse: validPeak event sets beatPulse=1; decay each frame.
  beatPulse *= Math.exp(-9 * dt); // visible for ~150ms after each peak
  bpmDotEl.style.opacity = String(0.2 + beatPulse * 0.8);

  // BPM readout: prefer locked-in stable value; fall back to candidate
  bpmNumEl.textContent = bpm > 0
    ? `${Math.round(bpm)} bpm`
    : bpmCandidate > 0
      ? `~${Math.round(bpmCandidate)} bpm`
      : '— bpm';

  composer.render(dt);
}
animate();

// ----- resize -----
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  composer.setSize(w, h);
  // Match the BLOOM_DIVISOR-reduced bloom resolution.
  bloom.setSize(w / BLOOM_DIVISOR, h / BLOOM_DIVISOR);
});

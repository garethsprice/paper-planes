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
const stereoBtn = document.getElementById('stereo') as HTMLButtonElement;
const uiEl = document.getElementById('ui') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLSpanElement;
const bpmNumEl = document.querySelector('#bpm .num') as HTMLSpanElement;
const bpmDotEl = document.getElementById('bpm-dot') as HTMLSpanElement;
const dbgEl = document.getElementById('dbg') as HTMLSpanElement;

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

// ----- arrow-key joystick state (used in chase/cockpit only) -----
// Held while the key is down; cleared on keyup. updateShip overrides the
// autopilot heading + altitude for the tracked ship when any arrow is held.
const arrowKeys = { left: false, right: false, up: false, down: false };

// ----- stereo camera for side-by-side AR-glasses output -----
// StereoCamera derives off-axis cameraL/cameraR from the master each frame.
// aspect=0.5 because each eye renders into half the canvas width.
// eyeSep is in world units; scene is ~50u wide, so 0.4 reads as natural depth
// without crossing-eyes strain. [ / ] keys nudge it.
const stereoCamera = new THREE.StereoCamera();
stereoCamera.aspect = 0.5;
stereoCamera.eyeSep = 0.4;
let stereoEnabled = false;

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

// Render pass that switches between mono (master camera) and stereo
// (cameraL/cameraR side-by-side) on the fly. Stereo writes both eyes into
// the same RT so subsequent passes (bloom) get one image with the eyes
// already laid out — bloom smear at the seam is acceptable when the bloom
// is kept subtle (we drop strength + radius in stereo mode).
class HybridRenderPass extends RenderPass {
  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    if (!stereoEnabled) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    const target = this.renderToScreen ? null : writeBuffer;
    renderer.setRenderTarget(target);
    if (this.clear) renderer.clear();
    scene.updateMatrixWorld();
    camera.updateMatrixWorld();
    stereoCamera.update(camera);
    const w = target ? target.width : renderer.domElement.width;
    const h = target ? target.height : renderer.domElement.height;
    const halfW = (w / 2) | 0;
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, halfW, h);
    renderer.setViewport(0, 0, halfW, h);
    renderer.render(scene, stereoCamera.cameraL);
    renderer.setScissor(halfW, 0, w - halfW, h);
    renderer.setViewport(halfW, 0, w - halfW, h);
    renderer.render(scene, stereoCamera.cameraR);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
  }
}
const renderPass = new HybridRenderPass(scene, camera);
composer.addPass(renderPass);
const bloom = new UnrealBloomPass(
  bloomRes,
  0.4,  // strength — animate() rewrites each frame; this is the at-rest value
  0.55, // radius
  0.08, // threshold — slightly higher so only the brightest peaks bloom
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
  uHeightMul: { value: 1.0 },        // beat-pulse pumps the whole landscape vertically
  uHueShift: { value: 0.0 },         // BPM-driven hue rotation
  uAuroraPhase: { value: 0.0 },      // sweeping aurora band x position phase
  uAuroraIntensity: { value: 0.0 },  // 0 during quiet, ramps with intensity
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
  uniform float uAuroraPhase;
  uniform float uAuroraIntensity;
  uniform float uDepthHalf;

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

    // aurora band — slow horizontal wash that sweeps across the X axis,
    // distinct from the height gradient. Hidden during quiet sections.
    if (uAuroraIntensity > 0.001) {
      float auroraCenter = sin(uAuroraPhase) * uDepthHalf;
      float auroraDist = abs(vWorldXZ.x - auroraCenter);
      float auroraBand = exp(-pow(auroraDist / 6.0, 2.0));
      vec3 auroraColor = mix(
        vec3(0.4, 0.0, 0.8),
        vec3(0.0, 0.9, 0.4),
        0.5 + 0.5 * sin(uAuroraPhase * 0.7)
      );
      col += auroraColor * auroraBand * uAuroraIntensity * ageFade;
    }

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
  lastTargetX: number; // last frame's chosen target — leader's value is read by wingmen during formation
  lastTargetZ: number;
  // Z teleport applied this frame by the tracked-ship wrap-forward logic.
  // Chase camera adds this to its position before the lerp so the framing
  // doesn't jolt when the ship hops from front to back of the play area.
  zWrapDelta: number;
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
    lastTargetX: x0,
    lastTargetZ: z0,
    zWrapDelta: 0,
  };
}

// Three ships, staggered so they don't pile up at the same point
const ships: Ship[] = [
  makeShip(13.7, 0, SHIP_Z_CENTER),
  makeShip(67.3, -10, SHIP_Z_CENTER + 4),
  makeShip(141.9, 10, SHIP_Z_CENTER - 4),
];

// ----- formation flight — synchronised motion frisson trigger.
// On a drop event we lock all three ships into a delta formation centered on
// the leader's wander target, hold for a few bars, then disperse. The
// chaos→synchrony→chaos transition is the murmuration effect.
const formation = {
  active: false,
  startedAt: 0,
  endsAt: 0,
  blendIn: 0,  // 0..1, eased over ~0.6s on enter
  blendOut: 0, // 1..0, eased over ~0.8s on exit
};
// Slot offsets in the formation, leader-relative. ships[0] is the leader.
const FORMATION_SLOTS: { dx: number; dz: number }[] = [
  { dx: 0,    dz: 0 },    // leader
  { dx: -3.5, dz: 2.5 },  // wing-left, slightly behind
  { dx: 3.5,  dz: 2.5 },  // wing-right, slightly behind
];
function activateFormation(durationMs: number) {
  if (formation.active) return; // don't restart mid-pass
  formation.active = true;
  formation.startedAt = performance.now();
  formation.endsAt = performance.now() + durationMs;
}

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

function updateShip(ship: Ship, idx: number, dt: number, time: number, level: number, centroid: number, tracked: boolean): void {
  const pos = ship.group.position;
  // When the camera is locked to this ship (chase/cockpit), fly mostly
  // straight: target a point far ahead along current heading with only a
  // small lateral nudge from slow noise. This avoids the constant-spin
  // motion-sickness problem of full wander chasing.
  // turnScale controls how fast the ship corrects heading. Lower = calmer
  // straight-line flight, but also slower to face forward on view entry.
  // 0.4 strikes a balance — initial 180° turn settles in ~4s, after that
  // the heading barely moves because the target is nearly aligned.
  const turnScale = tracked ? 0.4 : 1.0;
  const bankScale = tracked ? 0.4 : 1.0;
  let targetX: number;
  let targetZ: number;
  if (tracked) {
    // World-frame forward target: aim toward +Z, where new spectrogram peaks
    // emerge (the data rolls -Z each frame at ~23 u/s; flying +Z at speed 8
    // means terrain rushes toward the ship, giving a real "flying forward"
    // sensation. Flying -Z would let terrain overtake the ship and look
    // like reverse motion). On view entry this makes the ship turn to face
    // into the scene; after that it flies mostly straight with a small
    // lateral drift. Wrap-back (further down) teleports the ship from the
    // back to the front of the play area so it never has to U-turn.
    const drift = noise3(time * 0.04, ship.wanderSeed, 0) * 3.0;
    targetX = clamp(drift, -SHIP_X_BOUND, SHIP_X_BOUND);
    targetZ = SHIP_Z_MAX + 8; // outside the bounds so heading stays near π
  } else {
    // 1. wandering target — slow simplex noise + audio centroid pull
    const wanderX = noise3(time * 0.07, ship.wanderSeed, 0) * SHIP_X_BOUND;
    const wanderZ =
      noise3(time * 0.06, ship.wanderSeed + 100, 0) *
        (SHIP_Z_MAX - SHIP_Z_MIN) * 0.45 +
      SHIP_Z_CENTER;
    const centroidShift = (centroid - 0.5) * 2 * SHIP_X_BOUND * 0.5;
    targetX = clamp(wanderX * 0.55 + centroidShift * 0.6, -SHIP_X_BOUND, SHIP_X_BOUND);
    targetZ = clamp(wanderZ, SHIP_Z_MIN, SHIP_Z_MAX);
  }

  // formation override — wingmen blend their target toward (leader + slot).
  // formation.blendIn/Out are eased per-frame in animate(); blend = either
  // direction depending on whether we're entering or exiting formation.
  // Skip when this ship is being tracked: formation snaps cause sharp turns.
  if (idx > 0 && !tracked) {
    const blend = formation.active ? formation.blendIn : formation.blendOut;
    if (blend > 0.001) {
      const leader = ships[0];
      const slot = FORMATION_SLOTS[idx];
      const slotX = clamp(leader.lastTargetX + slot.dx, -SHIP_X_BOUND, SHIP_X_BOUND);
      const slotZ = clamp(leader.lastTargetZ + slot.dz, SHIP_Z_MIN, SHIP_Z_MAX);
      targetX = targetX + (slotX - targetX) * blend;
      targetZ = targetZ + (slotZ - targetZ) * blend;
    }
  }
  ship.lastTargetX = targetX;
  ship.lastTargetZ = targetZ;

  // 2. heading toward target — autopilot, unless the player is steering
  // with the arrow keys in chase/cockpit mode.
  const playerYaw = tracked
    ? (arrowKeys.left ? 1 : 0) - (arrowKeys.right ? 1 : 0)
    : 0;
  let turnInput: number;
  if (playerYaw !== 0) {
    // Joystick: full-rate yaw at the autopilot's relaxed turnScale so the
    // bank still feels gentle. heading delta uses the full SHIP_TURN_RATE
    // (not turnScale) so player turns are responsive even though autopilot
    // is calmed for tracked flight.
    turnInput = playerYaw;
    ship.heading = wrapAngle(ship.heading + turnInput * SHIP_TURN_RATE * dt);
  } else {
    const dx = targetX - pos.x;
    const dz = targetZ - pos.z;
    const dist = Math.hypot(dx, dz);
    let desiredHeading = ship.heading;
    if (dist > 0.5) desiredHeading = Math.atan2(-dx, -dz);
    const headingErr = wrapAngle(desiredHeading - ship.heading);
    turnInput = clamp(headingErr * SHIP_TURN_GAIN * turnScale, -1, 1);
    ship.heading = wrapAngle(ship.heading + turnInput * SHIP_TURN_RATE * turnScale * dt);
  }

  // 3. speed
  let targetSpeed: number;
  if (tracked) {
    // Spring the ship's speed toward whatever value keeps it near a home
    // point inside the play area, applied along the ship's current forward
    // direction so the spring works whichever way the player has steered.
    // ship.speed is signed: positive = forward along nose, negative = brief
    // ebb backward (only when the ship has overshot home in its facing
    // direction; lets the ship oscillate around home without ever needing
    // a U-turn or a wrap).
    const TRACKED_HOME_X = 0;
    const TRACKED_HOME_Z = SHIP_Z_CENTER;
    const fwdX_now = -Math.sin(ship.heading);
    const fwdZ_now = -Math.cos(ship.heading);
    const homeAhead =
      (TRACKED_HOME_X - pos.x) * fwdX_now +
      (TRACKED_HOME_Z - pos.z) * fwdZ_now;
    const SPRING = 0.85;
    const audioBoost = bassEnergy * 8 + beatPulse * 3;
    targetSpeed = homeAhead * SPRING + audioBoost;
  } else {
    // accelerate toward (base + bass thrust); turning costs speed; beat kick
    targetSpeed = SHIP_BASE_SPEED + bassEnergy * SHIP_SPEED_BOOST;
  }
  ship.speed += (targetSpeed - ship.speed) * SHIP_ACCEL_RATE * dt;
  const effSpeed = tracked
    ? ship.speed
    : ship.speed * (1 - SHIP_TURN_SLOWDOWN * Math.abs(turnInput))
      * (1 + beatPulse * 0.45);

  // 4. integrate position
  const fwdX = -Math.sin(ship.heading);
  const fwdZ = -Math.cos(ship.heading);
  pos.x = clamp(pos.x + fwdX * effSpeed * dt, -SHIP_X_BOUND, SHIP_X_BOUND);
  pos.z = pos.z + fwdZ * effSpeed * dt;
  // Tracked ship wraps Z front-to-back so it never has to U-turn off the
  // edge. Caller (camera section) shifts the chase camera by the same delta
  // so the framing doesn't jolt. Untracked ships clamp to the bounds.
  ship.zWrapDelta = 0;
  if (tracked) {
    const wrapSpan = SHIP_Z_MAX - SHIP_Z_MIN;
    if (pos.z < SHIP_Z_MIN) {
      pos.z += wrapSpan;
      ship.zWrapDelta = wrapSpan;
    } else if (pos.z > SHIP_Z_MAX) {
      pos.z -= wrapSpan;
      ship.zWrapDelta = -wrapSpan;
    }
  } else {
    pos.z = clamp(pos.z, SHIP_Z_MIN, SHIP_Z_MAX);
  }

  // 5. altitude
  const aheadX = pos.x + fwdX * SHIP_LOOKAHEAD_DIST;
  const aheadZ = pos.z + fwdZ * SHIP_LOOKAHEAD_DIST;
  const tHere = bilerpHeight(pos.x, pos.z);
  const tAhead = bilerpHeight(aheadX, aheadZ);
  const audioLift = level * 3.0;
  let targetY = Math.max(Math.max(tHere, tAhead) + SHIP_CLEARANCE, SHIP_Y_MIN + audioLift);
  // Player pitch input — Up climbs, Down dives. ±5 unit altitude offset so
  // the ship can clear ridges or hug the valleys on demand. The hard
  // terrain-clearance check below still kicks in to prevent crashes.
  if (tracked) {
    const playerPitch = (arrowKeys.up ? 1 : 0) - (arrowKeys.down ? 1 : 0);
    targetY += playerPitch * 5;
  }
  targetY = Math.min(SHIP_Y_MAX, targetY);
  ship.prevY = pos.y;
  pos.y += (targetY - pos.y) * (1 - Math.exp(-6 * dt));
  const tSafe = bilerpHeight(pos.x, pos.z);
  if (pos.y < tSafe + SHIP_HARD_CLEAR) pos.y = tSafe + SHIP_HARD_CLEAR;

  // 6. orientation
  const climbRate = (pos.y - ship.prevY) / Math.max(dt, 1e-3);
  const targetRoll = turnInput * SHIP_MAX_BANK * bankScale;
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

// ----- audio dynamics tracker — three time-scale EMAs of overall level
// (short ~150 ms, mid ~2 s, long ~10 s). Derived per-frame:
//   intensity = relative loudness (short / long), drives the global scalar
//               so the scene goes still during quiet sections.
//   quiet     = sustained low level, gates "stillness" behaviour.
//   build     = rising-energy detector, short above mid.
//   drop      = event fired when short jumps past previous frame, refractory-
//               gated so a single transient doesn't fire repeatedly.
const dynamics = {
  short: 0,
  mid: 0,
  long: 0,
  intensity: 1.0,
  quiet: false,
  build: 0,
  prevShort: 0,
  dropTime: -Infinity,
  dropCount: 0,
  lastDropDelta: 0,
};
// Tunables (also exposed via __terrain debug handle further down).
const DROP_RATIO_THRESHOLD = 1.4;   // short/mid ratio above this triggers a drop
const DROP_REFRACTORY_MS = 1500;
const QUIET_THRESHOLD = 0.05;
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
      dynamics, formation,
      get bpm() { return bpm; },
      get bpmCandidate() { return bpmCandidate; },
      get bassEnergy() { return bassEnergy; },
      forceDrop() { onDrop(); }, // trigger drop response manually for testing
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

function attachStream(stream: MediaStream, label: string) {
  const { ctx, analyser } = ensureAudio();
  audioEl.pause();
  disconnectCurrent();
  micStream = stream; // reuse cleanup path (track stop on disconnect)
  const src = ctx.createMediaStreamSource(stream);
  src.connect(analyser);
  // Never connect captured streams to destination. The source tab already
  // plays its own audio through the OS mixer, and the mic would feedback —
  // this tab is silent and uses the stream only for analysis.
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
    attachStream(stream, 'tab audio · source tab plays it');
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
// Preset switches now ALSO smooth-interpolate radius and height — slow dolly
// rather than abrupt cut.
let yaw = 0;
let pitch = 0;
let yawVel = 0;
let pitchVel = 0;
let prevBassForSpring = 0;
let targetYaw = 0;
let targetPitch = 0;
let camRadius = 28;
let camHeight = 9;
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

// 5 cinematic presets, then chase + cockpit per ship. 'C' cycles manually;
// the music-driven director (see runCinematicDirector below) handles auto.
const CAM_MODES: CamMode[] = [
  ...CAM_PRESETS.map((preset, i): CamMode => ({ kind: 'preset', preset, label: `preset ${i + 1}` })),
  ...ships.map((_, i): CamMode => ({ kind: 'chase', shipIdx: i, label: `chase ship ${i + 1}` })),
  ...ships.map((_, i): CamMode => ({ kind: 'cockpit', shipIdx: i, label: `cockpit ship ${i + 1}` })),
];

// Director role pools — indices into CAM_MODES. A mode can appear in multiple
// roles (e.g. low-left works for both calm holds and active beat cuts).
//   0 eye-level · 1 3/4-high · 2 low-left · 3 overhead-reverse · 4 top-down
//   5,6,7 chase · 8,9,10 cockpit
const MODE_ROLES = {
  calm:     [0, 2],
  active:   [0, 2, 5, 6, 7],
  dramatic: [1, 3, 4],
  rush:     [5, 6, 7, 8, 9, 10],
} as const;

let currentCamModeIdx = 0;
let camModeChangedAt = 0;       // ms timestamp of last cam switch
let camBeatsAtChange = 0;       // beatCount snapshot at last cam switch
let cinematicAuto = true;       // toggle with 'V' — when off, stays on current mode
let beatCount = 0;

// Director state — tracked across frames so transitions (build onset, quiet
// onset) fire on the rising edge rather than every frame the condition holds.
let prevBuild = 0;
let prevQuiet = false;
let lastBuildCutAt = 0;       // ms timestamp; 3-second refractory between build cuts
let nextCutMinBeats = 0;      // beat count at which the next cadence cut may fire
const recentModeIdxs: number[] = []; // last 2 picks; rejection-sample to avoid repeats

// Pilot override — arrow-key presses in chase/cockpit extend the current
// shot by 5 s so the user can keep flying without the director cutting away.
// Each press refreshes the timer; held arrows continually push it forward
// via browser autorepeat.
const PILOT_EXTEND_MS = 5000;
let pilotActiveUntil = 0;
function bumpPilotControl() {
  const m = CAM_MODES[currentCamModeIdx];
  if (m.kind === 'chase' || m.kind === 'cockpit') {
    pilotActiveUntil = performance.now() + PILOT_EXTEND_MS;
  }
}

function pickCinematicMode(role: keyof typeof MODE_ROLES): number {
  const pool = MODE_ROLES[role];
  // Avoid the current mode and recent picks; if everything is excluded, drop
  // the recency constraint (still avoid the current mode for visible variety).
  const fresh = pool.filter(
    (idx) => idx !== currentCamModeIdx && !recentModeIdxs.includes(idx),
  );
  const candidates = fresh.length > 0
    ? fresh
    : pool.filter((idx) => idx !== currentCamModeIdx);
  const choice = candidates.length > 0
    ? candidates[(Math.random() * candidates.length) | 0]
    : pool[0];
  recentModeIdxs.push(choice);
  if (recentModeIdxs.length > 2) recentModeIdxs.shift();
  return choice;
}

function applyCut(idx: number) {
  currentCamModeIdx = idx;
  camModeChangedAt = performance.now();
  camBeatsAtChange = beatCount;
}

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
    case '3':
      setStereo(!stereoEnabled);
      break;
    case '[':
      stereoCamera.eyeSep = Math.max(0.05, stereoCamera.eyeSep - 0.05);
      statusEl.textContent = `eyeSep ${stereoCamera.eyeSep.toFixed(2)}`;
      break;
    case ']':
      stereoCamera.eyeSep = Math.min(2.0, stereoCamera.eyeSep + 0.05);
      statusEl.textContent = `eyeSep ${stereoCamera.eyeSep.toFixed(2)}`;
      break;
    case 'arrowleft':
      arrowKeys.left = true;
      bumpPilotControl();
      e.preventDefault();
      break;
    case 'arrowright':
      arrowKeys.right = true;
      bumpPilotControl();
      e.preventDefault();
      break;
    case 'arrowup':
      arrowKeys.up = true;
      bumpPilotControl();
      e.preventDefault();
      break;
    case 'arrowdown':
      arrowKeys.down = true;
      bumpPilotControl();
      e.preventDefault();
      break;
  }
});

document.addEventListener('keyup', (e) => {
  switch (e.key.toLowerCase()) {
    case 'arrowleft':  arrowKeys.left = false; break;
    case 'arrowright': arrowKeys.right = false; break;
    case 'arrowup':    arrowKeys.up = false; break;
    case 'arrowdown':  arrowKeys.down = false; break;
  }
});

// Lose all held inputs on window blur — without this, switching tabs while
// holding an arrow leaves the ship locked into a turn forever.
window.addEventListener('blur', () => {
  arrowKeys.left = arrowKeys.right = arrowKeys.up = arrowKeys.down = false;
});

// ----- UI auto-hide: show while pointer is in the window, fade 3 s after it leaves
let lastInteractionAt = performance.now();
let pointerInWindow = false;
const markInteraction = () => { lastInteractionAt = performance.now(); };
['pointermove', 'pointerdown', 'keydown', 'wheel'].forEach((ev) => {
  document.addEventListener(ev, markInteraction, { passive: true });
});
// pointerenter/leave on body track whether the cursor is inside the window —
// while it's inside, the UI never hides; 3 s after it leaves it fades out.
document.body.addEventListener('pointerenter', () => { pointerInWindow = true; });
document.body.addEventListener('pointerleave', () => {
  pointerInWindow = false;
  lastInteractionAt = performance.now(); // reset countdown from leave time
});

// ----- drop response: per-event side effects, fired once when dropCount advances -----
let lastSeenDropCount = 0;
let dropFovOverlayUntil = 0; // ms timestamp; FOV widens until this time
let dbgFrameCounter = 0;     // throttles debug-panel DOM rebuilds
let dropFiredThisFrame = false; // consumed by the cinematic director below

function onDrop() {
  // Formation flight for ~6 seconds (≈8 bars at 120 BPM, 4 bars at 60 BPM —
  // good enough that the formation is held long enough to read).
  const ms = bpm > 0 ? (60 / bpm) * 1000 * 8 : 6000;
  activateFormation(ms);
  // FOV widen pulse — the awe shot
  dropFovOverlayUntil = performance.now() + 600;
  // The cinematic director (later in the same frame) reads this flag to
  // hard-cut to a dramatic angle.
  dropFiredThisFrame = true;
}

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

    // dynamics signal: peak FFT magnitude (any band). Full-band mean is
    // dominated by silent bins on percussive material; peak tracks the
    // loudest active band whatever it is — kick, vocal, lead synth.
    let peak = 0;
    for (let i = 1; i < fftBins.length; i++) if (fftBins[i] > peak) peak = fftBins[i];
    const lvl = peak / 255;
    const aShort = 1 - Math.exp(-dt / 0.15);
    const aMid   = 1 - Math.exp(-dt / 2.0);
    const aLong  = 1 - Math.exp(-dt / 10.0);
    dynamics.short += (lvl - dynamics.short) * aShort;
    dynamics.mid   += (lvl - dynamics.mid)   * aMid;
    dynamics.long  += (lvl - dynamics.long)  * aLong;
    // intensity: relative loudness vs the long-window baseline. Tracks the
    // arrangement instead of absolute volume — quiet music still has crests.
    dynamics.intensity = Math.min(1.5, dynamics.short / Math.max(0.08, dynamics.long));
    dynamics.quiet = dynamics.short < QUIET_THRESHOLD;
    dynamics.build = Math.max(0, Math.min(1, (dynamics.short - dynamics.mid) * 4));
    // drop detection: short has moved well above the 2 s mid (energy step
    // up that's sustained, not just a single-frame transient). Refractory
    // window prevents repeat fires within one drop. The ratio is more
    // robust than a delta threshold across both percussive and
    // continuous-energy material.
    const ratio = dynamics.short / Math.max(0.05, dynamics.mid);
    const nowMs = performance.now();
    if (ratio > DROP_RATIO_THRESHOLD && dynamics.short > 0.15 && nowMs - dynamics.dropTime > DROP_REFRACTORY_MS) {
      dynamics.dropTime = nowMs;
      dynamics.dropCount++;
      dynamics.lastDropDelta = ratio;
    }
    dynamics.prevShort = dynamics.short;
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
    dynamics.short *= 0.95; // decay all EMAs toward zero when no audio
    dynamics.mid   *= 0.99;
    dynamics.long  *= 0.998;
    dynamics.intensity = Math.min(1.5, dynamics.short / Math.max(0.08, dynamics.long));
    dynamics.quiet = true;
    dynamics.build = 0;
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
  // fire drop-response side effects when a new drop has been recorded.
  // Reset dropFiredThisFrame here so it's only true on the frame the drop fires.
  dropFiredThisFrame = false;
  if (dynamics.dropCount !== lastSeenDropCount) {
    lastSeenDropCount = dynamics.dropCount;
    onDrop();
  }

  // global reactivity scalars derived from dynamics — used throughout the
  // remainder of the frame.
  const sinceDrop = (performance.now() - dynamics.dropTime) / 1000;
  const dropBoost = sinceDrop < 1.5 ? Math.exp(-sinceDrop * 2.0) : 0;
  const I = dynamics.intensity;

  // FOV widen pulse during the brief drop overlay
  const fovOverlay = Math.max(0, dropFovOverlayUntil - performance.now()) / 600;
  const targetFov = 55 + fovOverlay * 8;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }

  // formation lifecycle: ease blend in/out, expire when window passes
  if (formation.active && performance.now() > formation.endsAt) {
    formation.active = false; // stays in blendOut decay until next activation
  }
  const formationLerp = 1 - Math.exp(-(formation.active ? 1.7 : 1.2) * dt);
  formation.blendIn += ((formation.active ? 1 : 0) - formation.blendIn) * formationLerp;
  formation.blendOut = formation.blendIn; // single state suffices — blend toward target

  // The currently-tracked ship (chase/cockpit) flies calmer to reduce VR-style
  // motion sickness from constant spinning; cinematic modes don't track a ship.
  const camMode_ = CAM_MODES[currentCamModeIdx];
  const trackedShipIdx =
    camMode_.kind === 'chase' || camMode_.kind === 'cockpit'
      ? camMode_.shipIdx
      : -1;
  ships.forEach((ship, i) =>
    updateShip(ship, i, dt, t, level, centroid, i === trackedShipIdx),
  );

  // Music-driven cinematic director — synchronises cuts to drops, builds,
  // quiet sections, and beat cadence so the camera feels edited to the
  // track. 'V' toggles this off; 'C' jumps regardless.
  if (cinematicAuto) {
    const now = performance.now();
    if (now < pilotActiveUntil) {
      // Pilot in control: keep the shot, pin the cadence baselines so the
      // next cut is computed from the moment the pilot lets go (not from
      // before they grabbed the stick). prev* trackers stay current so we
      // don't fire a stale onset edge once they release.
      camBeatsAtChange = beatCount;
      camModeChangedAt = now;
      prevBuild = dynamics.build;
      prevQuiet = dynamics.quiet;
    } else {
      const buildOnset = dynamics.build > 0.45 && prevBuild <= 0.45;
      const quietOnset = dynamics.quiet && !prevQuiet;
      const shotAgeMs = now - camModeChangedAt;
      // Minimum shot durations — even musical events have to wait this long
      // before stealing the camera, so cuts feel deliberate rather than
      // twitchy. Languid pacing: a fresh shot needs to breathe.
      const MIN_SHOT_EVENT_MS = 3500;   // drops, build/quiet onsets
      const MIN_SHOT_CADENCE_MS = 6000; // beat-driven cuts during sustained energy

      if (dropFiredThisFrame && shotAgeMs > MIN_SHOT_EVENT_MS) {
        // Hard cut on a drop to a dramatic angle.
        applyCut(pickCinematicMode('dramatic'));
      } else if (
        buildOnset &&
        now - lastBuildCutAt > 6000 &&
        shotAgeMs > MIN_SHOT_EVENT_MS
      ) {
        // Rising-energy moment — slam into a chase or cockpit "rush" shot.
        applyCut(pickCinematicMode('rush'));
        lastBuildCutAt = now;
      } else if (quietOnset && shotAgeMs > MIN_SHOT_EVENT_MS) {
        // Drop into a calm, wide hold and force the next cadence cut to wait.
        applyCut(pickCinematicMode('calm'));
        nextCutMinBeats = beatCount + 48;
      } else {
        // Beat cadence — long holds. Intensity narrows the interval but
        // never below ~12 beats so even peak sections feel composed.
        const I = dynamics.intensity;
        const beatsPerCut = dynamics.quiet ? 48 : I > 0.85 ? 12 : I > 0.5 ? 24 : 32;
        const beatReady =
          beatCount - camBeatsAtChange >= beatsPerCut &&
          beatCount >= nextCutMinBeats &&
          shotAgeMs > MIN_SHOT_CADENCE_MS;
        // Time fallback: 2.5× the beat-interval converted to ms (or a 20 s
        // floor when BPM hasn't locked yet) — long enough to feel patient.
        const fallbackMs = bpm > 0 ? (60 / bpm) * 1000 * beatsPerCut * 2.5 : 20000;
        const timeReady = shotAgeMs >= fallbackMs;
        if (beatReady || timeReady) {
          const role = I > 0.3 ? 'active' : 'calm';
          applyCut(pickCinematicMode(role));
        }
      }

      prevBuild = dynamics.build;
      prevQuiet = dynamics.quiet;
    }
  }

  // restore visibility every frame; the active cockpit mode hides its own ship.
  for (const s of ships) s.group.visible = true;

  const camMode = CAM_MODES[currentCamModeIdx];
  if (camMode.kind === 'preset') {
    // spring orbit around origin, with bass attack impulse on yaw and bass
    // amplitude pulling the radius in. radius/height now also smoothly
    // interpolate so preset → preset transitions are slow dollies rather
    // than abrupt cuts. Anticipation build pulls the camera back; drop
    // FOV-widen does not affect radius (it widens the lens instead).
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
    // dt-aware exponential lerp on radius/height (≈1.5 s settle for big jumps)
    const dollyLerp = 1 - Math.exp(-2.0 * dt);
    const targetRadius = p.radius - bassEnergy * 2.5 * I + dynamics.build * 5;
    const targetHeight = p.height + dynamics.build * 2;
    camRadius += (targetRadius - camRadius) * dollyLerp;
    camHeight += (targetHeight - camHeight) * dollyLerp;
    camera.position.x = Math.sin(yaw) * camRadius;
    camera.position.z = Math.cos(yaw) * camRadius;
    camera.position.y = camHeight + pitch * 12;
    camera.lookAt(0, 1.5, 0);
  } else if (camMode.kind === 'chase') {
    // 5 units behind the ship, 2.5 above; lerp-smoothed so the camera doesn't
    // jitter when the ship banks hard. Looking ~3 units ahead so the ship
    // sits in the lower portion of the frame.
    const ship = ships[camMode.shipIdx];
    const sp = ship.group.position;
    const fwdX = -Math.sin(ship.heading);
    const fwdZ = -Math.cos(ship.heading);
    // ship-Z wrapped this frame? carry the camera with it so the framing
    // stays continuous and the lerp doesn't pan backward over half a second.
    if (ship.zWrapDelta !== 0) camera.position.z += ship.zWrapDelta;
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

  // (sinceDrop and dropBoost computed earlier in this frame, see top of
  // animation loop block above the camera section.)

  // beat pulse breathes the landscape; scaled by intensity so it's flat on
  // quiet sections and full-bodied during loud ones.
  uniforms.uHeightMul.value = 1.0 + beatPulse * 0.10 * I;
  // aurora: phase sweeps slowly (faster on louder sections), intensity
  // fades to zero during quiet.
  uniforms.uAuroraPhase.value += (0.4 + I * 0.4) * dt;
  uniforms.uAuroraIntensity.value = I * 0.45 + dropBoost * 0.3;
  // mirror world fades down when the scene is quiet
  mirrorMaterial.uniforms.uOpacity.value = 0.10 * I;
  // very subtle star parallax (independent of intensity — the cosmos doesn't pause)
  stars.rotation.y += 0.0003;
  // nebula swirls a bit faster on bass; intensity scales the speed-up
  nebula.rotation.y += 0.0008 + bassEnergy * 0.004 * I;
  (nebula.material as THREE.PointsMaterial).color.setRGB(
    0.45 + centroid * 0.55,
    0.55 + 0.10 * (1 - centroid),
    0.95 - centroid * 0.30,
  );

  // UI auto-hide: never idle while pointer is over the window
  const idle = !pointerInWindow && performance.now() - lastInteractionAt > 3000;
  if (idle !== uiEl.classList.contains('idle')) {
    uiEl.classList.toggle('idle', idle);
  }
  // hue: BPM offset + slow time cycle, attenuated by intensity
  const tempoForHue = bpm > 0 ? bpm : 120;
  const bpmHue = Math.max(-0.05, Math.min(0.05, (tempoForHue - 120) / 60 * 0.05));
  uniforms.uHueShift.value = (bpmHue + Math.sin(t * 0.07) * 0.04) * (0.4 + 0.6 * I);

  // bloom kick on bass transients + drop burst. Stereo mode uses a much
  // gentler curve — UnrealBloomPass blurs across the eye seam, so we keep
  // the strength + radius low to minimise smear into the opposite eye.
  const bloomMul = stereoEnabled ? 0.4 : 1.0;
  bloom.strength =
    ((0.28 + 0.12 * I) + bassEnergy * 0.22 * I + dropBoost * 0.35) * bloomMul;
  bloom.radius = stereoEnabled ? 0.3 : 0.55;
  // chromatic aberration is radial-from-center and would centre on the
  // stereo seam, so disable it in 3d mode. Keep mono baseline + bass burst.
  chromaticPass.enabled = !stereoEnabled;
  if (!stereoEnabled) {
    chromaticPass.uniforms.uAmount.value = Math.min(
      0.012,
      0.0008 + bassEnergy * 0.006 * I + dropBoost * 0.005,
    );
  }

  // beat-dot pulse: validPeak event sets beatPulse=1; decay each frame.
  beatPulse *= Math.exp(-9 * dt); // visible for ~150ms after each peak
  bpmDotEl.style.opacity = String(0.2 + beatPulse * 0.8);

  // BPM readout: prefer locked-in stable value; fall back to candidate
  bpmNumEl.textContent = bpm > 0
    ? `${Math.round(bpm)} bpm`
    : bpmCandidate > 0
      ? `~${Math.round(bpmCandidate)} bpm`
      : '— bpm';

  // debug status panel — live read of dynamics + active modes. Rebuilt
  // every 6 frames (~10 Hz) to keep DOM churn out of the hot path while
  // staying snappy enough that drops are visible.
  if ((dbgFrameCounter++ % 6) === 0) {
    dbgEl.innerHTML =
      `<span class="num">I ${dynamics.intensity.toFixed(2)}</span>` +
      `<span class="num"> · B ${dynamics.build.toFixed(2)}</span>` +
      (dynamics.quiet ? '<span class="tag on"> QUIET</span>' : '') +
      (dropBoost > 0.05
        ? `<span class="tag drop"> DROP×${dynamics.dropCount}</span>`
        : ` <span style="opacity:0.5">drp ${dynamics.dropCount}</span>`) +
      (formation.active ? '<span class="tag on"> FORM</span>' : '') +
      (dynamics.build > 0.3 ? '<span class="tag on"> BUILD</span>' : '');
  }

  composer.render(dt);
}
animate();

function setStereo(on: boolean) {
  stereoEnabled = on;
  stereoBtn.classList.toggle('on', on);
  // Master camera aspect: stereo uses full canvas with internal 0.5 split,
  // so the master stays at canvas aspect either way — but we re-derive in
  // case the next frame is mono.
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  statusEl.textContent = on
    ? `3d on · eyeSep ${stereoCamera.eyeSep.toFixed(2)} · [ ] to adjust`
    : '3d off';
}
stereoBtn.addEventListener('click', () => setStereo(!stereoEnabled));

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

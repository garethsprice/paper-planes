import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
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
const statusEl = document.getElementById('status') as HTMLSpanElement;
const bpmEl = document.getElementById('bpm') as HTMLSpanElement;

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
const uniforms = {
  uTime: { value: 0 },
  uFogNear: { value: fog.near },
  uFogFar: { value: fog.far },
  uFogColor: { value: new THREE.Color(0x000308) },
  uHeightScale: { value: HEIGHT_SCALE },
  uDepthHalf: { value: DEPTH * 0.5 },
};

const material = new THREE.ShaderMaterial({
  uniforms,
  // alpha is always 1 in the fragment shader — keep this opaque so three.js
  // can write depth and skip the per-frame transparent-object sort.
  transparent: false,
  vertexShader: /* glsl */ `
    varying float vHeight;
    varying float vViewDist;
    varying float vRowAge;
    uniform float uDepthHalf;

    void main() {
      vHeight = position.y;
      // rowAge: 0 at front (newest) → 1 at back (oldest)
      vRowAge = clamp((uDepthHalf - position.z) / (uDepthHalf * 2.0), 0.0, 1.0);
      vec4 mv = modelViewMatrix * vec4(position, 1.0);
      vViewDist = -mv.z;
      gl_Position = projectionMatrix * mv;
    }
  `,
  fragmentShader: /* glsl */ `
    varying float vHeight;
    varying float vViewDist;
    varying float vRowAge;
    uniform float uFogNear;
    uniform float uFogFar;
    uniform vec3 uFogColor;
    uniform float uHeightScale;

    // cool → hot gradient
    vec3 grade(float t) {
      vec3 c0 = vec3(0.02, 0.05, 0.18);  // near-black blue
      vec3 c1 = vec3(0.05, 0.30, 0.75);  // electric blue
      vec3 c2 = vec3(0.10, 0.85, 0.95);  // cyan
      vec3 c3 = vec3(0.95, 0.25, 0.60);  // magenta
      vec3 c4 = vec3(1.00, 0.65, 0.20);  // orange
      vec3 c5 = vec3(1.00, 0.98, 0.85);  // hot white
      if (t < 0.2)  return mix(c0, c1, t / 0.2);
      if (t < 0.45) return mix(c1, c2, (t - 0.2) / 0.25);
      if (t < 0.7)  return mix(c2, c3, (t - 0.45) / 0.25);
      if (t < 0.88) return mix(c3, c4, (t - 0.7) / 0.18);
      return mix(c4, c5, (t - 0.88) / 0.12);
    }

    void main() {
      float h = clamp(vHeight / uHeightScale, 0.0, 1.0);
      vec3 col = grade(h);

      // subtle brightness boost on peaks → bloom catches them
      col *= 0.8 + 1.6 * h;

      // fade old rows toward black for depth
      float ageFade = 1.0 - smoothstep(0.55, 1.0, vRowAge);
      col *= ageFade;

      // distance fog
      float fogF = smoothstep(uFogNear, uFogFar, vViewDist);
      col = mix(col, uFogColor, fogF);

      gl_FragColor = vec4(col, 1.0);
    }
  `,
});

const grid = new THREE.LineSegments(geometry, material);
scene.add(grid);

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
const shipMesh = new THREE.LineSegments(shipGeom, shipMat);
const shipGroup = new THREE.Group();
shipGroup.rotation.order = 'YXZ'; // yaw, then pitch, then roll (aircraft order)
shipGroup.add(shipMesh);
shipGroup.position.set(0, 4, SHIP_Z_CENTER);
scene.add(shipGroup);

const shipState = {
  heading: 0, // 0 rad = nose facing world -Z (away from camera)
  speed: SHIP_BASE_SPEED,
  pitch: 0,
  roll: 0,
  prevY: 4,
  wanderSeed: Math.random() * 100,
};

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

function updateShip(dt: number, time: number): void {
  // 1. audio bands
  let level = 0;
  // bass is computed once per frame in animate() and stored in bassEnergy.
  const bass = bassEnergy;
  let centroid = 0.5;
  if (fftBins) {
    let sumAll = 0;
    for (let i = 0; i < fftBins.length; i++) sumAll += fftBins[i];
    level = sumAll / (fftBins.length * 255);
    let cn = 0;
    let cd = 0;
    for (let i = 1; i < fftBins.length; i++) {
      cn += i * fftBins[i];
      cd += fftBins[i];
    }
    if (cd > 0) centroid = cn / cd / (fftBins.length - 1); // 0..1
  }

  // 2. wandering target — slow simplex noise + audio centroid pull
  const wanderX = noise3(time * 0.07, shipState.wanderSeed, 0) * SHIP_X_BOUND;
  const wanderZ =
    noise3(time * 0.06, shipState.wanderSeed + 100, 0) *
      (SHIP_Z_MAX - SHIP_Z_MIN) * 0.45 +
    SHIP_Z_CENTER;
  const centroidShift = (centroid - 0.5) * 2 * SHIP_X_BOUND * 0.5;
  const targetX = clamp(wanderX * 0.55 + centroidShift * 0.6, -SHIP_X_BOUND, SHIP_X_BOUND);
  const targetZ = clamp(wanderZ, SHIP_Z_MIN, SHIP_Z_MAX);

  // 3. heading control — turn toward target at limited rate
  const dx = targetX - shipGroup.position.x;
  const dz = targetZ - shipGroup.position.z;
  const dist = Math.hypot(dx, dz);
  let desiredHeading = shipState.heading;
  if (dist > 0.5) {
    // three.js R_y(h) maps local (0,0,-1) to world (-sin h, 0, -cos h),
    // so to face toward (dx, _, dz): -sin h = dx/d, -cos h = dz/d → h = atan2(-dx, -dz)
    desiredHeading = Math.atan2(-dx, -dz);
  }
  const headingErr = wrapAngle(desiredHeading - shipState.heading);
  const turnInput = clamp(headingErr * SHIP_TURN_GAIN, -1, 1);
  shipState.heading = wrapAngle(
    shipState.heading + turnInput * SHIP_TURN_RATE * dt,
  );

  // 4. speed — accelerate toward (base + bass thrust); turning costs speed
  const targetSpeed = SHIP_BASE_SPEED + bass * SHIP_SPEED_BOOST;
  shipState.speed += (targetSpeed - shipState.speed) * SHIP_ACCEL_RATE * dt;
  const effSpeed =
    shipState.speed * (1 - SHIP_TURN_SLOWDOWN * Math.abs(turnInput));

  // 5. integrate position along forward heading.
  // Forward in world = R_y(heading) * (0,0,-1) = (-sin h, 0, -cos h).
  const fwdX = -Math.sin(shipState.heading);
  const fwdZ = -Math.cos(shipState.heading);
  shipGroup.position.x += fwdX * effSpeed * dt;
  shipGroup.position.z += fwdZ * effSpeed * dt;
  shipGroup.position.x = clamp(shipGroup.position.x, -SHIP_X_BOUND, SHIP_X_BOUND);
  shipGroup.position.z = clamp(shipGroup.position.z, SHIP_Z_MIN, SHIP_Z_MAX);

  // 6. altitude — clear terrain at current + forward sample, plus audio lift
  const aheadX = shipGroup.position.x + fwdX * SHIP_LOOKAHEAD_DIST;
  const aheadZ = shipGroup.position.z + fwdZ * SHIP_LOOKAHEAD_DIST;
  const tHere = bilerpHeight(shipGroup.position.x, shipGroup.position.z);
  const tAhead = bilerpHeight(aheadX, aheadZ);
  const audioLift = level * 3.0;
  let targetY = Math.max(
    Math.max(tHere, tAhead) + SHIP_CLEARANCE,
    SHIP_Y_MIN + audioLift,
  );
  targetY = Math.min(SHIP_Y_MAX, targetY);
  shipState.prevY = shipGroup.position.y;
  // dt-aware exponential lerp
  const yLerp = 1 - Math.exp(-6 * dt);
  shipGroup.position.y += (targetY - shipGroup.position.y) * yLerp;
  // hard collision safety
  const tSafe = bilerpHeight(shipGroup.position.x, shipGroup.position.z);
  if (shipGroup.position.y < tSafe + SHIP_HARD_CLEAR) {
    shipGroup.position.y = tSafe + SHIP_HARD_CLEAR;
  }

  // 7. orientation — bank into turns, pitch with climb rate
  const climbRate = (shipGroup.position.y - shipState.prevY) / Math.max(dt, 1e-3);
  // Bank into the turn. Under three.js Y-rotation, increasing heading turns
  // LEFT (nose rotates CCW seen from above). Left turn → left bank → right
  // wing up → positive rotation.z. So roll has the SAME sign as turnInput.
  const targetRoll = turnInput * SHIP_MAX_BANK;
  const targetPitch = clamp(
    climbRate * SHIP_PITCH_GAIN,
    -SHIP_MAX_PITCH,
    SHIP_MAX_PITCH,
  );
  const orientLerp = 1 - Math.exp(-7 * dt);
  shipState.roll += (targetRoll - shipState.roll) * orientLerp;
  shipState.pitch += (targetPitch - shipState.pitch) * orientLerp;
  // rotation.set(x, y, z): with order 'YXZ' three.js applies y (yaw) → x (pitch) → z (roll)
  shipGroup.rotation.set(shipState.pitch, shipState.heading, shipState.roll);
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
let bpm = 0;          // locked BPM (0 until first stable estimate)
let bpmCandidate = 0; // most recent top candidate (early-feedback display)
let bassEnergy = 0;   // mean of low-band FFT bins (drives bloom pulse)
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
  // 200 Hz lowpass, Q=1 — focus the analyzer on kick/bass transients, ignore
  // hi-hats/cymbals/vocals that confuse peak detection.
  bpmFilter = getBiquadFilter(ctx);
  // continuousAnalysis: false — lock once and hold. Stops the readout from
  // wobbling on tracks where the analyzer's confidence drifts. Source change
  // calls bpmAnalyzer.reset() to re-analyze.
  bpmAnalyzerPromise = createRealtimeBpmAnalyzer(ctx, { continuousAnalysis: false }).then((a) => {
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

    bpmAnalyzer = a;
    // expose for ad-hoc DevTools poking + filter tuning
    (window as unknown as { __terrain?: unknown }).__terrain = {
      ctx, analyser, fftBins, bpmAnalyzer: a, bpmFilter,
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
      resetBpm() { bpm = 0; bpmCandidate = 0; a.reset(); },
    };
    return a;
  }).catch((err) => {
    console.warn('[bpm] analyzer unavailable:', err);
    return null as unknown as BpmAnalyzer;
  });
  return bpmAnalyzerPromise;
}

function connectBpmSource(src: AudioNode) {
  ensureBpm().then((a) => {
    if (!a || !bpmFilter) return;
    // disconnect previous source from the filter input
    if (lastBpmSourceNode) {
      try { lastBpmSourceNode.disconnect(bpmFilter); } catch {}
    }
    src.connect(bpmFilter);
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
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (!f) return;
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
  connectBpmSource(mediaSrc);
  currentSourceNode = mediaSrc;
  playBtn.disabled = false;
  playBtn.textContent = 'play';
  statusEl.textContent = f.name;
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

micBtn.addEventListener('click', async () => {
  try {
    const { ctx, analyser } = ensureAudio();
    if (ctx.state === 'suspended') await ctx.resume();
    audioEl.pause();
    disconnectCurrent();
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const src = ctx.createMediaStreamSource(micStream);
    src.connect(analyser);
    // do NOT connect mic → destination (feedback)
    connectBpmSource(src);
    currentSourceNode = src;
    playBtn.disabled = true;
    statusEl.textContent = 'mic live';
  } catch (e) {
    statusEl.textContent = `mic blocked: ${(e as Error).message}`;
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
let yaw = 0;
let pitch = 0;
let targetYaw = 0;
let targetPitch = 0;
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

  // ship autopilot uses freshly-updated heights[] for path/collision
  updateShip(dt, t);

  // damped orbit
  yaw += (targetYaw - yaw) * 0.08;
  pitch += (targetPitch - pitch) * 0.08;
  const radius = 28;
  const baseHeight = 9;
  camera.position.x = Math.sin(yaw) * radius;
  camera.position.z = Math.cos(yaw) * radius;
  camera.position.y = baseHeight + pitch * 12;
  camera.lookAt(0, 1.5, 0);

  // beat pulse: subtle bloom kick on bass transients (decoupled from BPM lock)
  bloom.strength = 0.65 + bassEnergy * 0.5;

  // BPM readout: prefer locked-in stable value; fall back to candidate
  bpmEl.textContent = bpm > 0
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

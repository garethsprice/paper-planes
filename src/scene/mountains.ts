// Distant mountain ring — the sense of scale. A coarse line grid (rings +
// spokes) encircling the spectrogram at 70–110 u, with peaks 12–45 u tall
// that breathe with the song's long-term energy. Rendered with its own
// shader rather than scene fog so the layers fade by ring: the inner ring
// reads as a dark silhouette, the outer rings dissolve toward the sky —
// classic atmospheric perspective.

import * as THREE from 'three';
import type { NoiseFunction3D } from 'simplex-noise';
import { MOUNTAIN_RADII, MOUNTAIN_SEGMENTS, SUN_MOUNTAIN_RIM, SUN_MOUNTAIN_HAZE } from '../constants.ts';

const VERT = /* glsl */ `
  attribute float aFade;
  attribute float aBase;
  attribute float aPhase;
  varying float vH;
  varying float vFade;
  varying vec2 vXZ;
  varying vec3 vViewDir;
  uniform float uPeak;
  uniform float uHeightLift;
  uniform float uTime;
  void main() {
    // Height = the noise-field shape (aBase, refreshed on the CPU a few
    // times a second) × the song's lift and beat swell × a slow per-vertex
    // sway — the fast-moving factors evaluated here so the CPU never
    // touches the buffer for them.
    float sway = 1.0 + 0.04 * sin(uTime * 0.05 + aPhase);
    vec3 p = vec3(position.x, aBase * uHeightLift * sway, position.z);
    vH = clamp(p.y / uPeak, 0.0, 1.0);
    vFade = aFade;
    vXZ = p.xz;
    vViewDir = p - cameraPosition;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying float vH;
  varying float vFade;
  varying vec2 vXZ;
  varying vec3 vViewDir;
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uSky;
  uniform float uLift;
  uniform vec3 uLightDir;
  uniform vec3 uSunColor;
  uniform float uSun;
  uniform float uRim;
  uniform float uHaze;
  void main() {
    // Deep indigo at the foot, dusty violet on the crests; farther rings
    // sink toward the sky colour and thin out.
    vec3 col = mix(uLow, uHigh, pow(vH, 1.4));
    col = mix(col, uSky, vFade * 0.75);
    // Crests facing the horizon light catch its colour.
    vec2 lz = normalize(vec2(uLightDir.x, uLightDir.z));
    float facing = clamp(dot(normalize(vXZ), lz) * 0.5 + 0.5, 0.0, 1.0);
    float rim = facing * facing * pow(vH, 1.6) * uSun * uRim;
    col += uSunColor * rim;
    // Aerial perspective against the glow: where the line of sight crosses
    // the horizon haze, the line takes the haze's colour instead of cutting
    // a dark shape out of it. Same band/gather as the sky shader.
    vec3 d = normalize(vViewDir);
    float band = exp(-max(d.y, 0.0) * 11.0) * smoothstep(-0.25, 0.0, d.y);
    vec2 daz = normalize(vec2(d.x, d.z) + vec2(1e-5, 0.0));
    float gather = pow(max(0.0, dot(daz, lz)), 3.0);
    float corona = pow(max(dot(d, uLightDir), 0.0), 18.0);
    float haze = clamp((band * gather * 0.9 + corona) * uSun, 0.0, 1.0) * uHaze;
    col = mix(col, uSunColor, haze);
    float alpha = (0.55 - vFade * 0.32) * uLift + rim * 0.3;
    gl_FragColor = vec4(col, alpha);
  }
`;

export type Mountains = {
  mesh: THREE.LineSegments;
  material: THREE.ShaderMaterial;
  /**
   * @param envelope 0..1 long-term energy: raises the peaks
   * @param time     scene seconds (slow sway)
   * @param scroll   world-Z offset of the height field — advancing it moves
   *                 the range past the viewer with natural parallax
   * @param breath   0..1 beat envelope: a faint swell on the crests
   */
  update: (envelope: number, time: number, scroll: number, breath: number) => void;
};

export function createMountains(
  scene: THREE.Scene,
  noise3: NoiseFunction3D,
  shared: { uLightDir: { value: THREE.Vector3 }; uSunColor: { value: THREE.Color }; uSun: { value: number } },
): Mountains {
  const rings = MOUNTAIN_RADII.length;
  const N = MOUNTAIN_SEGMENTS;
  const count = rings * N;
  const positions = new Float32Array(count * 3);
  const fade = new Float32Array(count);
  const index: number[] = [];
  for (let r = 0; r < rings; r++) {
    for (let i = 0; i < N; i++) {
      const v = r * N + i;
      const a = (i / N) * Math.PI * 2;
      positions[v * 3] = Math.cos(a) * MOUNTAIN_RADII[r];
      positions[v * 3 + 1] = 0;
      positions[v * 3 + 2] = Math.sin(a) * MOUNTAIN_RADII[r];
      fade[v] = rings > 1 ? r / (rings - 1) : 0;
      // ring edge
      index.push(v, r * N + ((i + 1) % N));
      // spoke to the next ring out
      if (r < rings - 1) index.push(v, (r + 1) * N + i);
    }
  }
  // Per-vertex sway phase (the old `v * 0.37`), so the shader can sway.
  const phase = new Float32Array(count);
  for (let v = 0; v < count; v++) phase[v] = v * 0.37;
  const base = new Float32Array(count);
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
  geometry.setAttribute('aPhase', new THREE.BufferAttribute(phase, 1));
  const baseAttr = new THREE.BufferAttribute(base, 1);
  baseAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('aBase', baseAttr);
  geometry.setIndex(index);

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPeak: { value: 40 },
      uHeightLift: { value: 1 }, // song lift × beat swell (uLift below is the hush alpha)
      uTime: { value: 0 },
      uLow: { value: new THREE.Color(0x0d1230) },
      uHigh: { value: new THREE.Color(0x6a5cb4) },
      uSky: { value: new THREE.Color(0x000308) },
      uLift: { value: 1 },
      uLightDir: shared.uLightDir,
      uSunColor: shared.uSunColor,
      uSun: shared.uSun,
      uRim: { value: SUN_MOUNTAIN_RIM },
      uHaze: { value: SUN_MOUNTAIN_HAZE },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.LineSegments(geometry, material);
  mesh.renderOrder = -1; // behind everything translucent
  mesh.frustumCulled = false; // the ring surrounds the camera; heights live in the shader
  scene.add(mesh);

  // Per-vertex rise with radius so foothills climb into peaks at the back.
  const rise = new Float32Array(count);
  for (let r = 0; r < rings; r++) {
    const k = 0.55 + 0.45 * (rings > 1 ? r / (rings - 1) : 1);
    for (let i = 0; i < N; i++) rise[r * N + i] = k;
  }

  // The shape of each vertex comes from a continuous 2-D noise field over
  // world XZ (so rings and spokes trace one surface rather than a fence),
  // sampled at z + scroll: advancing the scroll slides the whole field
  // through the ring, so peaks ahead grow and pass while the far rings
  // crawl — parallax, the cue that says "we are moving through this". The
  // field drifts so slowly (a few hundredths of a noise unit per second)
  // that refreshing a quarter of the vertices per frame is indistinguishable
  // from refreshing them all; the fast factors (lift, beat swell, sway)
  // are applied per frame in the vertex shader.
  const SLICES = 4;
  let slice = 0;
  const refresh = (v: number, scroll: number): void => {
    const x = positions[v * 3];
    const z = positions[v * 3 + 2] + scroll;
    const n1 = noise3(x * 0.014, z * 0.014, 1.7) * 0.5 + 0.5;
    const n2 = noise3(x * 0.045, z * 0.045, 4.1) * 0.5 + 0.5;
    const shape = Math.pow(n1 * 0.72 + n2 * 0.28, 1.8);
    base[v] = (6 + 40 * shape) * rise[v];
  };
  const update = (envelope: number, time: number, scroll: number, breath: number): void => {
    // The range breathes with the long-term energy (quiet leaves low
    // foothills, a full section raises the peaks) and the crests swell
    // faintly on the beat.
    const lift = (0.4 + 0.6 * envelope) * (1 + breath * 0.025);
    for (let v = slice; v < count; v += SLICES) refresh(v, scroll);
    slice = (slice + 1) % SLICES;
    baseAttr.needsUpdate = true;
    material.uniforms.uHeightLift.value = lift;
    material.uniforms.uTime.value = time;
    material.uniforms.uPeak.value = 56 * lift;
  };
  for (let v = 0; v < count; v++) refresh(v, 0);
  update(0.5, 0, 0, 0);
  return { mesh, material, update };
}

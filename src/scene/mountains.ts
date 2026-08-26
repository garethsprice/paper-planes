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
  varying float vH;
  varying float vFade;
  varying vec2 vXZ;
  varying vec3 vViewDir;
  uniform float uPeak;
  void main() {
    vH = clamp(position.y / uPeak, 0.0, 1.0);
    vFade = aFade;
    vXZ = position.xz;
    vViewDir = position - cameraPosition;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
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
  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aFade', new THREE.BufferAttribute(fade, 1));
  geometry.setIndex(index);
  geometry.computeBoundingSphere();

  const material = new THREE.ShaderMaterial({
    uniforms: {
      uPeak: { value: 40 },
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
  scene.add(mesh);

  // Per-vertex rise with radius so foothills climb into peaks at the back.
  const rise = new Float32Array(count);
  for (let r = 0; r < rings; r++) {
    const k = 0.55 + 0.45 * (rings > 1 ? r / (rings - 1) : 1);
    for (let i = 0; i < N; i++) rise[r * N + i] = k;
  }

  const update = (envelope: number, time: number, scroll: number, breath: number): void => {
    // Heights come from a continuous 2-D noise field over world XZ (so
    // rings and spokes trace one surface rather than a fence), sampled at
    // z + scroll: advancing the scroll slides the whole field through the
    // ring, so peaks ahead grow and pass while the far rings crawl —
    // parallax, the cue that says "we are moving through this". The range
    // breathes with the long-term energy (quiet leaves low foothills, a full
    // section raises the peaks) and the crests swell faintly on the beat.
    const lift = (0.4 + 0.6 * envelope) * (1 + breath * 0.025);
    const arr = posAttr.array as Float32Array;
    for (let v = 0; v < count; v++) {
      const x = arr[v * 3];
      const z = arr[v * 3 + 2] + scroll;
      const n1 = noise3(x * 0.014, z * 0.014, 1.7) * 0.5 + 0.5;
      const n2 = noise3(x * 0.045, z * 0.045, 4.1) * 0.5 + 0.5;
      const shape = Math.pow(n1 * 0.72 + n2 * 0.28, 1.8);
      const sway = 1 + 0.04 * Math.sin(time * 0.05 + v * 0.37);
      arr[v * 3 + 1] = (6 + 40 * shape) * rise[v] * lift * sway;
    }
    posAttr.needsUpdate = true;
    material.uniforms.uPeak.value = 56 * lift;
  };
  update(0.5, 0, 0, 0);
  return { mesh, material, update };
}

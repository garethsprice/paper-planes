// Distant mountain ring — the sense of scale. A coarse line grid (rings +
// spokes) encircling the spectrogram at 70–110 u, with peaks 12–45 u tall
// that breathe with the song's long-term energy. Rendered with its own
// shader rather than scene fog so the layers fade by ring: the inner ring
// reads as a dark silhouette, the outer rings dissolve toward the sky —
// classic atmospheric perspective.

import * as THREE from 'three';
import type { NoiseFunction3D } from 'simplex-noise';
import { MOUNTAIN_RADII, MOUNTAIN_SEGMENTS } from '../constants.ts';

const VERT = /* glsl */ `
  attribute float aFade;
  varying float vH;
  varying float vFade;
  uniform float uPeak;
  void main() {
    vH = clamp(position.y / uPeak, 0.0, 1.0);
    vFade = aFade;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const FRAG = /* glsl */ `
  varying float vH;
  varying float vFade;
  uniform vec3 uLow;
  uniform vec3 uHigh;
  uniform vec3 uSky;
  uniform float uLift;
  void main() {
    // Deep indigo at the foot, dusty violet on the crests; farther rings
    // sink toward the sky colour and thin out.
    vec3 col = mix(uLow, uHigh, pow(vH, 1.4));
    col = mix(col, uSky, vFade * 0.75);
    float alpha = (0.55 - vFade * 0.32) * uLift;
    gl_FragColor = vec4(col, alpha);
  }
`;

export type Mountains = {
  mesh: THREE.LineSegments;
  material: THREE.ShaderMaterial;
  update: (envelope: number, time: number) => void;
};

export function createMountains(scene: THREE.Scene, noise3: NoiseFunction3D): Mountains {
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
      uLow: { value: new THREE.Color(0x070a1e) },
      uHigh: { value: new THREE.Color(0x6a5cb4) },
      uSky: { value: new THREE.Color(0x000308) },
      uLift: { value: 1 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
  });
  const mesh = new THREE.LineSegments(geometry, material);
  mesh.renderOrder = -1; // behind everything translucent
  scene.add(mesh);

  // Static profile per vertex — a continuous 2-D noise field over world XZ
  // (so rings and spokes trace one surface rather than a fence), two
  // octaves, rising with radius so foothills climb into peaks at the back.
  const profile = new Float32Array(count);
  for (let r = 0; r < rings; r++) {
    const rise = 0.55 + 0.45 * (rings > 1 ? r / (rings - 1) : 1);
    for (let i = 0; i < N; i++) {
      const v = r * N + i;
      const x = positions[v * 3];
      const z = positions[v * 3 + 2];
      const n1 = noise3(x * 0.014, z * 0.014, 1.7) * 0.5 + 0.5;
      const n2 = noise3(x * 0.045, z * 0.045, 4.1) * 0.5 + 0.5;
      const shape = Math.pow(n1 * 0.72 + n2 * 0.28, 1.8);
      profile[v] = (6 + 40 * shape) * rise;
    }
  }

  const update = (envelope: number, time: number): void => {
    // The range breathes with the long-term energy: quiet music leaves low
    // foothills, a full section raises the peaks. A very slow drift keeps
    // the silhouette alive.
    const lift = 0.4 + 0.6 * envelope;
    const arr = posAttr.array as Float32Array;
    for (let v = 0; v < count; v++) {
      const sway = 1 + 0.06 * Math.sin(time * 0.05 + v * 0.37);
      arr[v * 3 + 1] = profile[v] * lift * sway;
    }
    posAttr.needsUpdate = true;
    material.uniforms.uPeak.value = 56 * lift;
  };
  update(0.5, 0);
  return { mesh, material, update };
}

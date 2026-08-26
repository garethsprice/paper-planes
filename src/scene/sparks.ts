// Sparks lifting off the crests on beats. A fixed GPU pool of points; the
// CPU only writes a new particle's launch state (position, velocity, birth,
// life, size, colour) into a ring buffer, and the vertex shader integrates
// each one from its birth time: launch velocity, a little gravity, and the
// same −Z advection as the rest of the landscape (the air moves with the
// ground in this world), so a spark drifts back with the crest it left.
// Rare on an ordinary beat, a burst on a drop, none in the hush.

import * as THREE from 'three';
import {
  COLS, ROWS, WIDTH, DEPTH, HEIGHT_SCALE,
  SPARK_POOL, SPARK_LIFE_MIN, SPARK_LIFE_MAX, SPARK_RISE_MIN, SPARK_RISE_MAX,
  SPARK_GRAVITY, SPARK_SIZE,
} from '../constants.ts';
import type { Terrain } from './terrain.ts';

const VERT = /* glsl */ `
  attribute vec3 aVel;
  attribute float aBirth;
  attribute float aLife;
  attribute float aSize;
  attribute vec3 aColor;
  uniform float uTime;
  uniform float uFlow;
  uniform float uGravity;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float age = uTime - aBirth;
    float t = clamp(age / aLife, 0.0, 1.0);
    vec3 p = position + aVel * age + vec3(0.0, -0.5 * uGravity * age * age, -uFlow * age);
    float live = (age >= 0.0 && age <= aLife) ? 1.0 : 0.0;
    // quick rise, long ember fade
    vAlpha = live * smoothstep(0.0, 0.06, t) * (1.0 - t) * (1.0 - t);
    vColor = aColor;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    // ~5 px at 20 u, a pixel or two far off: glints, not blobs
    gl_PointSize = live * aSize * (50.0 / max(1.0, -mv.z));
    gl_Position = projectionMatrix * mv;
  }
`;
const FRAG = /* glsl */ `
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    float a = smoothstep(0.5, 0.1, d) * vAlpha;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vColor * a, a);
  }
`;

export type Sparks = {
  points: THREE.Points;
  /** Advance time / flow uniforms (every frame). */
  update: (time: number, flow: number) => void;
  /** Throw `count` sparks off random crests. */
  emit: (count: number, time: number, color: THREE.Color, vigour: number) => void;
};

export function createSparks(scene: THREE.Scene, terrain: Terrain): Sparks {
  const n = SPARK_POOL;
  const pos = new Float32Array(n * 3);
  const vel = new Float32Array(n * 3);
  const birth = new Float32Array(n).fill(-1e9);
  const life = new Float32Array(n).fill(1);
  const size = new Float32Array(n);
  const col = new Float32Array(n * 3);
  const geometry = new THREE.BufferGeometry();
  const attrs = {
    position: new THREE.BufferAttribute(pos, 3),
    aVel: new THREE.BufferAttribute(vel, 3),
    aBirth: new THREE.BufferAttribute(birth, 1),
    aLife: new THREE.BufferAttribute(life, 1),
    aSize: new THREE.BufferAttribute(size, 1),
    aColor: new THREE.BufferAttribute(col, 3),
  };
  for (const [name, attr] of Object.entries(attrs)) {
    attr.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute(name, attr);
  }
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uFlow: { value: 0 },
      uGravity: { value: SPARK_GRAVITY },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const points = new THREE.Points(geometry, material);
  points.frustumCulled = false;
  scene.add(points);

  let head = 0;

  /** Highest of a few random candidates in the nearer two-thirds of the
   *  grid, so sparks leave crests rather than valleys. */
  const pickCrest = (out: THREE.Vector3): boolean => {
    let bestH = -Infinity;
    let bx = 0;
    let bz = 0;
    for (let k = 0; k < 4; k++) {
      const ix = (Math.random() * (COLS - 1)) | 0;
      const iy = (ROWS * 0.3 + Math.random() * (ROWS * 0.7 - 1)) | 0;
      const h = terrain.heights[iy * COLS + ix];
      if (h > bestH) {
        bestH = h;
        bx = (ix / (COLS - 1) - 0.5) * WIDTH;
        bz = (iy / (ROWS - 1) - 0.5) * DEPTH;
      }
    }
    if (bestH < HEIGHT_SCALE * 0.22) return false; // nothing worth calling a crest
    out.set(bx, bestH + 0.15, bz);
    return true;
  };

  const _p = new THREE.Vector3();
  const emit = (count: number, time: number, color: THREE.Color, vigour: number): void => {
    let wrote = 0;
    for (let i = 0; i < count; i++) {
      if (!pickCrest(_p)) continue;
      const j = head;
      head = (head + 1) % n;
      pos[j * 3] = _p.x; pos[j * 3 + 1] = _p.y; pos[j * 3 + 2] = _p.z;
      const rise = SPARK_RISE_MIN + Math.random() * (SPARK_RISE_MAX - SPARK_RISE_MIN);
      vel[j * 3] = (Math.random() - 0.5) * 1.6 * vigour;
      vel[j * 3 + 1] = rise * (0.7 + 0.6 * vigour);
      vel[j * 3 + 2] = (Math.random() - 0.5) * 1.2;
      birth[j] = time;
      life[j] = SPARK_LIFE_MIN + Math.random() * (SPARK_LIFE_MAX - SPARK_LIFE_MIN);
      size[j] = SPARK_SIZE * (0.6 + Math.random() * 0.8) * (0.8 + 0.4 * vigour);
      // pale ember tinted by the horizon light
      const w = 0.3 + 0.5 * Math.random();
      col[j * 3] = 0.85 * (1 - w) + color.r * w;
      col[j * 3 + 1] = 0.95 * (1 - w) + color.g * w;
      col[j * 3 + 2] = 1.0 * (1 - w) + color.b * w;
      wrote++;
    }
    if (wrote > 0) for (const attr of Object.values(attrs)) attr.needsUpdate = true;
  };

  const update = (time: number, flow: number): void => {
    material.uniforms.uTime.value = time;
    material.uniforms.uFlow.value = flow;
  };

  return { points, update, emit };
}

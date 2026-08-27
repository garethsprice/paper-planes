// Spectrogram terrain — a regular grid drawn as line segments. We build the
// position buffer by hand because Y is mutated every frame from the FFT.
// The mirror grid below shares everything but flips Y and uses a dimmer
// uniform pool with transparent blending.

import * as THREE from 'three';
import { createNoise3D, type NoiseFunction3D } from 'simplex-noise';
import { COLS, ROWS, WIDTH, DEPTH, ENVELOPE_CELL, TERRAIN_ROW_SPACING } from '../constants.ts';
import type { SceneCore, SharedUniforms } from './core.ts';

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

const TERRAIN_FRAGMENT_SHADER = /* glsl */ `
  varying float vHeight;
  varying float vViewDist;
  varying float vRowAge;
  varying vec2 vWorldXZ;
  uniform float uTime;
  uniform float uFogNear;
  uniform float uFogFar;
  uniform float uHeightScale;
  uniform float uHueShift;
  uniform float uOpacity;
  uniform float uAuroraPhase;
  uniform float uAuroraIntensity;
  uniform float uDepthHalf;
  uniform float uDim;
  uniform vec3 uLightDir;
  uniform vec3 uSunColor;
  uniform float uSun;

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

    // gentle lift on peaks so the brightest crests just clear the bloom
    // threshold. The old 0.8 + 1.6h pushed peaks to 2.4× — everything
    // bloomed into a white wall.
    col *= 0.6 + 0.85 * h;

    // glimmer: tiny glints that drift along the lines — two slow-moving
    // interference patterns, raised to a high power so only their crossings
    // light up, scaled by height so the crests sparkle and the floor stays
    // calm. Subtle by design; it should read as shimmer, not strobe.
    float g1 = sin(vWorldXZ.x * 2.9 + uTime * 1.7) * sin(vWorldXZ.y * 2.3 - uTime * 1.1);
    float g2 = sin(vWorldXZ.x * 1.3 - uTime * 0.9 + vWorldXZ.y * 1.9);
    float glint = pow(max(0.0, g1), 10.0) * (0.5 + 0.5 * g2);
    col += col * glint * (0.25 + 0.75 * h) * 0.9;

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

    // old rows dissolve (applied as alpha below, never as black — a black
    // line would silhouette against the mountains and the sky glow)
    float ageFade = 1.0 - smoothstep(0.55, 1.0, vRowAge);

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
      col += auroraColor * auroraBand * uAuroraIntensity;
    }

    // horizon light: the side of the grid toward the sun takes a warm wash
    // that strengthens as the light rises
    vec2 lz = normalize(vec2(uLightDir.x, uLightDir.z));
    float facing = clamp(dot(normalize(vWorldXZ + vec2(0.0001)), lz) * 0.5 + 0.5, 0.0, 1.0);
    col = mix(col, col * (uSunColor * 1.5 + 0.25), 0.3 * facing * facing * uSun);

    // Distance fog, row age and the hush all thin the line out rather than
    // darkening it, so the grid disappears into what lies behind it.
    float fogF = smoothstep(uFogNear, uFogFar, vViewDist);
    float alpha = uOpacity * ageFade * (1.0 - fogF) * uDim;

    gl_FragColor = vec4(col, alpha);
  }
`;

export type Terrain = {
  mesh: THREE.LineSegments;
  mirror: THREE.LineSegments;
  mirrorMaterial: THREE.ShaderMaterial;
  geometry: THREE.BufferGeometry;
  posAttr: THREE.BufferAttribute;
  /** Per-vertex Y, kept separately so row shifts are a cheap typed-array .copyWithin. */
  heights: Float32Array;
  /** Log-frequency lookup: which FFT bin each grid column samples. */
  binMap: Float32Array;
  /** Simplex-noise instance shared with the ships (wander targets). */
  noise3: NoiseFunction3D;
  /** Max-filtered height per ENVELOPE_CELL² block, envCols × envRows. */
  envelope: Float32Array;
  envCols: number;
  envRows: number;
  /** World-Z offset of the grid this frame (see setFlowOffset). */
  zOffset: number;
};

export function createTerrain(core: SceneCore): Terrain {
  // Construct positions: regular grid in XZ, Y starts flat. iy=0 is far
  // (oldest); iy=ROWS-1 is closest to camera (newest).
  const positions = new Float32Array(COLS * ROWS * 3);
  for (let iy = 0; iy < ROWS; iy++) {
    for (let ix = 0; ix < COLS; ix++) {
      const i = (iy * COLS + ix) * 3;
      positions[i] = (ix / (COLS - 1) - 0.5) * WIDTH;
      positions[i + 1] = 0;
      positions[i + 2] = (iy / (ROWS - 1) - 0.5) * DEPTH;
    }
  }

  // Edge index buffer — horizontal (along freq axis) + vertical (time axis)
  const lineIndex: number[] = [];
  for (let iy = 0; iy < ROWS; iy++) {
    for (let ix = 0; ix < COLS - 1; ix++) {
      lineIndex.push(iy * COLS + ix, iy * COLS + ix + 1);
    }
  }
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

  // Material reuses sharedUniforms by reference + adds its own uOpacity.
  const mainUniforms = {
    ...core.uniforms,
    uOpacity: { value: 1.0 },
  } as SharedUniforms & { uOpacity: { value: number } };

  const material = new THREE.ShaderMaterial({
    uniforms: mainUniforms,
    transparent: true,  // fades are alpha; depth writes stay on for the real grid
    vertexShader: TERRAIN_VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
  });

  // Mirror world: same geometry/shader, flipped Y, dim and transparent.
  const mirrorMaterial = new THREE.ShaderMaterial({
    uniforms: { ...core.uniforms, uOpacity: { value: 0.10 } },
    vertexShader: TERRAIN_VERTEX_SHADER,
    fragmentShader: TERRAIN_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false, // don't occlude the real terrain
  });

  const mesh = new THREE.LineSegments(geometry, material);
  core.scene.add(mesh);

  const mirror = new THREE.LineSegments(geometry, mirrorMaterial);
  mirror.scale.y = -1; // reflects through the y=0 plane
  core.scene.add(mirror);

  const envCols = Math.ceil((COLS - 1) / ENVELOPE_CELL);
  const envRows = Math.ceil((ROWS - 1) / ENVELOPE_CELL);

  // Per-vertex Y buffer + log-frequency bin lookup + noise.
  const heights = new Float32Array(COLS * ROWS);
  const binMap = new Float32Array(COLS);
  const minBin = 1; // skip DC
  const maxBin = 511; // analyser.frequencyBinCount - 1, given fftSize=1024
  for (let ix = 0; ix < COLS; ix++) {
    const t = ix / (COLS - 1);
    binMap[ix] = minBin * Math.pow(maxBin / minBin, t);
  }

  return {
    mesh,
    mirror,
    mirrorMaterial,
    geometry,
    posAttr,
    heights,
    binMap,
    noise3: createNoise3D(),
    envelope: new Float32Array(envCols * envRows),
    envCols,
    envRows,
    zOffset: 0,
  };
}

/**
 * Slide the grid by the fraction of a row the flow has advanced since the
 * last whole-row shift (0 ≤ frac < 1). The data only moves in whole rows;
 * this sub-row offset makes the motion continuous at any frame rate — on a
 * display faster than the row rate the grid glides between shifts instead
 * of stepping. Height lookups take the offset into account.
 */
export function setFlowOffset(terrain: Terrain, frac: number): void {
  const z = -frac * TERRAIN_ROW_SPACING;
  terrain.zOffset = z;
  terrain.mesh.position.z = z;
  terrain.mirror.position.z = z;
}

/** Rebuild the coarse envelope from the fine heights (call once per frame,
 *  after the row write). ~16k reads; far cheaper than every ship sampling
 *  the fine grid fifteen times. */
export function updateEnvelope(terrain: Terrain): void {
  const { heights, envelope, envCols, envRows } = terrain;
  for (let cz = 0; cz < envRows; cz++) {
    const iy0 = cz * ENVELOPE_CELL;
    const iy1 = Math.min(ROWS, iy0 + ENVELOPE_CELL + 1);
    for (let cx = 0; cx < envCols; cx++) {
      const ix0 = cx * ENVELOPE_CELL;
      const ix1 = Math.min(COLS, ix0 + ENVELOPE_CELL + 1);
      let m = -Infinity;
      for (let iy = iy0; iy < iy1; iy++) {
        const row = iy * COLS;
        for (let ix = ix0; ix < ix1; ix++) {
          const h = heights[row + ix];
          if (h > m) m = h;
        }
      }
      envelope[cz * envCols + cx] = m;
    }
  }
}

/** Envelope cell max at a world XZ (clamped to the grid). */
export function envelopeAt(terrain: Terrain, wx: number, wz: number): number {
  const { envelope, envCols, envRows } = terrain;
  const fx = (wx / WIDTH + 0.5) * (COLS - 1) / ENVELOPE_CELL;
  const fz = ((wz - terrain.zOffset) / DEPTH + 0.5) * (ROWS - 1) / ENVELOPE_CELL;
  const cx = Math.max(0, Math.min(envCols - 1, fx | 0));
  const cz = Math.max(0, Math.min(envRows - 1, fz | 0));
  return envelope[cz * envCols + cx];
}

/** Bilinear height sample at world XZ — used by ship altitude tracking. */
export function bilerpHeight(terrain: Terrain, wx: number, wz: number): number {
  const heights = terrain.heights;
  const fx = (wx / WIDTH + 0.5) * (COLS - 1);
  const fz = ((wz - terrain.zOffset) / DEPTH + 0.5) * (ROWS - 1);
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

/** Linear interpolation between adjacent FFT bins (for log-spaced sampling). */
export function sampleLogBin(
  data: { length: number; [i: number]: number },
  fbin: number,
): number {
  const lo = Math.floor(fbin);
  const hi = Math.min(lo + 1, data.length - 1);
  const frac = fbin - lo;
  return data[lo] * (1 - frac) + data[hi] * frac;
}

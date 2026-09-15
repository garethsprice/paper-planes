// Wingtip vapour for the whole flock in one draw. Every ship owns two
// ribbons (one per wingtip), each a short history of that tip's world
// position; all ribbons live in a single indexed LineSegments so a hundred
// planes' vapour is one draw call. Per-vertex alpha is the aerodynamic
// load at the moment of emission times an age fade, so vapour appears only
// when the wings are working — a hard bank, the drop dive, an arrival
// surging in — and is gone within a second.
//
// The air moves with the landscape (the conveyor), so stored points are
// advected −Z by the flow's travel this frame exactly as the terrain is. A
// station-keeping plane thus streams its vapour straight back into the
// flow, which is the physically right picture.

import * as THREE from 'three';
import {
  SHIP_MAX, TRAIL_SAMPLES, TRAIL_ALPHA, TRAIL_LOAD_ON, TRAIL_LOAD_FULL,
} from '../constants.ts';
import type { Ship } from './ship.ts';

const VERT = /* glsl */ `
  attribute float aAlpha;
  attribute float aSide;
  attribute vec3 aTangent;
  uniform vec2 uResolution;
  varying float vAlpha;
  varying float vSide;
  void main() {
    vAlpha = aAlpha; vSide = aSide;
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    vec4 ahead = projectionMatrix * modelViewMatrix * vec4(position + aTangent, 1.0);
    vec2 delta = (ahead.xy / max(0.01, ahead.w) - clip.xy / max(0.01, clip.w)) * uResolution;
    vec2 normal = vec2(-delta.y, delta.x) / max(0.001, length(delta));
    clip.xy += normal * aSide * 1.8 * sqrt(aAlpha) / uResolution * clip.w;
    gl_Position = clip;
  }
`;
const FRAG = /* glsl */ `
  varying float vAlpha;
  varying float vSide;
  uniform vec3 uColor;
  void main() {
    float alpha = vAlpha * (1.0 - smoothstep(0.25, 1.0, abs(vSide)));
    if (alpha < 0.002) discard;
    gl_FragColor = vec4(uColor, alpha);
    #include <tonemapping_fragment>
    #include <colorspace_fragment>
  }
`;

// Wingtip positions in ship-local space (see SHIP_VERTS in shipRender.ts).
const TIPS = [new THREE.Vector3(-0.65, 0, 0.6), new THREE.Vector3(0.65, 0, 0.6)];

export type Trails = {
  lines: THREE.Mesh;
  /** @param flowStep world units the landscape travelled −Z this frame */
  update: (ships: Ship[], flowStep: number, dt: number) => void;
};

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const _tip = new THREE.Vector3();

export function createTrails(scene: THREE.Scene): Trails {
  const ribbons = SHIP_MAX * TIPS.length;
  const n = TRAIL_SAMPLES;
  const vertCount = ribbons * n;
  const positions = new Float32Array(vertCount * 3);
  const alphas = new Float32Array(vertCount);   // uploaded: emission × age fade
  const ages = new Float32Array(vertCount).fill(10);
  const emitted = new Float32Array(vertCount);  // emission alpha per sample
  // A camera-facing strip, with width fading alongside opacity toward the tail.
  const renderedPositions = new Float32Array(vertCount * 6);
  const renderedAlphas = new Float32Array(vertCount * 2);
  const tangents = new Float32Array(vertCount * 6);
  const sides = new Float32Array(vertCount * 2);
  for (let i = 0; i < vertCount; i++) { sides[i * 2] = -1; sides[i * 2 + 1] = 1; }
  const index: number[] = [];
  for (let r = 0; r < ribbons; r++) for (let k = 0; k < n - 1; k++) {
    const a = (r * n + k) * 2;
    index.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(renderedPositions, 3).setUsage(THREE.DynamicDrawUsage);
  const alphaAttr = new THREE.BufferAttribute(renderedAlphas, 1).setUsage(THREE.DynamicDrawUsage);
  const tangentAttr = new THREE.BufferAttribute(tangents, 3).setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setAttribute('aTangent', tangentAttr);
  geometry.setAttribute('aSide', new THREE.BufferAttribute(sides, 1));
  geometry.setIndex(index);

  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0.72, 0.88, 1.0) }, uResolution: { value: new THREE.Vector2(1, 1) } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
  });
  const lines = new THREE.Mesh(geometry, material);
  const viewport = new THREE.Vector4();
  lines.onBeforeRender = renderer => {
    renderer.getCurrentViewport(viewport);
    material.uniforms.uResolution.value.set(Math.max(1, viewport.z), Math.max(1, viewport.w));
  };
  lines.frustumCulled = false;
  scene.add(lines);

  // History is sampled by the fixed simulation. Opacity always ages in seconds.
  const lifetime = 0.7;
  const update = (ships: Ship[], flowStep: number, dt: number): void => {
    let any = false;
    for (let i = 0; i < ships.length; i++) {
      const ship = ships[i];
      const dormant = ship.phase === 'dormant';
      const vapour = dormant
        ? 0
        : smoothstep(TRAIL_LOAD_ON, TRAIL_LOAD_FULL, ship.load) * ship.fade * TRAIL_ALPHA;
      for (let t = 0; t < TIPS.length; t++) {
        const base = (i * TIPS.length + t) * n;
        const b3 = base * 3;
        // Shift history back one sample, advecting every stored point with
        // the landscape.
        let live = false;
        for (let k = 0; k < n - 1; k++) {
          const o = b3 + k * 3;
          positions[o] = positions[o + 3];
          positions[o + 1] = positions[o + 4];
          positions[o + 2] = positions[o + 5] - flowStep;
          const e = emitted[base + k + 1];
          emitted[base + k] = e;
          ages[base + k] = ages[base + k + 1] + dt;
          if (e > 0.002) live = true;
        }
        const last3 = b3 + (n - 1) * 3;
        if (dormant) {
          emitted[base + n - 1] = 0;
          if (live) {
            for (let k = 0; k < n; k++) alphas[base + k] = emitted[base + k] * Math.pow(Math.max(0, 1 - ages[base + k] / lifetime), 2);
            any = true;
          } else {
            alphas.fill(0, base, base + n);
          }
          continue;
        }
        // Newest sample: the wingtip now.
        _tip.copy(TIPS[t]);
        _tip.y += ship.flex;
        _tip.applyQuaternion(ship.group.quaternion).add(ship.group.position);
        // A teleport (arrival staging) would draw a streak across the sky —
        // restart the ribbon at the new spot instead.
        const jump = Math.abs(_tip.z - (positions[last3 + 2] + flowStep)) > 8
          || Math.abs(_tip.x - positions[last3]) > 8;
        if (jump) {
          for (let k = 0; k < n; k++) {
            const o = b3 + k * 3;
            positions[o] = _tip.x; positions[o + 1] = _tip.y; positions[o + 2] = _tip.z;
            emitted[base + k] = 0;
          }
          live = false;
        }
        positions[last3] = _tip.x;
        positions[last3 + 1] = _tip.y;
        positions[last3 + 2] = _tip.z;
        emitted[base + n - 1] = vapour;
        ages[base + n - 1] = 0;
        if (vapour > 0.002) live = true;
        if (live) {
          for (let k = 0; k < n; k++) alphas[base + k] = emitted[base + k] * Math.pow(Math.max(0, 1 - ages[base + k] / lifetime), 2);
          any = true;
        } else {
          alphas.fill(0, base, base + n);
        }
      }
    }
    lines.visible = any;
    if (any) {
      for (let ribbon = 0; ribbon < ribbons; ribbon++) for (let k = 0; k < n; k++) {
        const i = ribbon * n + k;
        const before = (ribbon * n + Math.max(0, k - 1)) * 3;
        const after = (ribbon * n + Math.min(n - 1, k + 1)) * 3;
        for (let side = 0; side < 2; side++) {
          renderedAlphas[i * 2 + side] = alphas[i];
          for (let axis = 0; axis < 3; axis++) {
            renderedPositions[i * 6 + side * 3 + axis] = positions[i * 3 + axis];
            tangents[i * 6 + side * 3 + axis] = positions[after + axis] - positions[before + axis];
          }
        }
      }
      tangentAttr.needsUpdate = true;
      posAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
    }
  };

  return { lines, update };
}

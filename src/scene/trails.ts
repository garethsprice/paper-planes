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
  varying float vAlpha;
  void main() {
    vAlpha = aAlpha;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;
const FRAG = /* glsl */ `
  varying float vAlpha;
  uniform vec3 uColor;
  void main() {
    if (vAlpha < 0.002) discard;
    gl_FragColor = vec4(uColor * vAlpha, vAlpha);
  }
`;

// Wingtip positions in ship-local space (see SHIP_VERTS in shipRender.ts).
const TIPS = [new THREE.Vector3(-0.65, 0, 0.6), new THREE.Vector3(0.65, 0, 0.6)];

export type Trails = {
  lines: THREE.LineSegments;
  /** @param flowStep world units the landscape travelled −Z this frame */
  update: (ships: Ship[], flowStep: number) => void;
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
  const emitted = new Float32Array(vertCount);  // emission alpha per sample
  // Static index: consecutive samples of each ribbon form its segments.
  const index = new Uint32Array(ribbons * (n - 1) * 2);
  let w = 0;
  for (let r = 0; r < ribbons; r++) {
    for (let k = 0; k < n - 1; k++) {
      index[w++] = r * n + k;
      index[w++] = r * n + k + 1;
    }
  }
  const geometry = new THREE.BufferGeometry();
  const posAttr = new THREE.BufferAttribute(positions, 3);
  const alphaAttr = new THREE.BufferAttribute(alphas, 1);
  posAttr.setUsage(THREE.DynamicDrawUsage);
  alphaAttr.setUsage(THREE.DynamicDrawUsage);
  geometry.setAttribute('position', posAttr);
  geometry.setAttribute('aAlpha', alphaAttr);
  geometry.setIndex(new THREE.BufferAttribute(index, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0.72, 0.88, 1.0) } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const lines = new THREE.LineSegments(geometry, material);
  lines.frustumCulled = false;
  scene.add(lines);

  // Age fade per sample (newest = 1, oldest = 0), eased so the tail thins.
  const ageFade = new Float32Array(n);
  for (let k = 0; k < n; k++) { const a = k / (n - 1); ageFade[k] = a * a; }

  const update = (ships: Ship[], flowStep: number): void => {
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
          if (e > 0.002) live = true;
        }
        const last3 = b3 + (n - 1) * 3;
        if (dormant) {
          emitted[base + n - 1] = 0;
          if (live) {
            for (let k = 0; k < n; k++) alphas[base + k] = emitted[base + k] * ageFade[k];
            any = true;
          } else {
            alphas.fill(0, base, base + n);
          }
          continue;
        }
        // Newest sample: the wingtip now.
        _tip.copy(TIPS[t]).applyQuaternion(ship.group.quaternion).add(ship.group.position);
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
        if (vapour > 0.002) live = true;
        if (live) {
          for (let k = 0; k < n; k++) alphas[base + k] = emitted[base + k] * ageFade[k];
          any = true;
        } else {
          alphas.fill(0, base, base + n);
        }
      }
    }
    lines.visible = any;
    if (any) {
      posAttr.needsUpdate = true;
      alphaAttr.needsUpdate = true;
    }
  };

  return { lines, update };
}

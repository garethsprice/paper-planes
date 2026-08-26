// Wingtip vapour. Two thin ribbons per ship, each a short history of that
// wingtip's world position, drawn as a line strip whose per-vertex alpha is
// the aerodynamic load at the moment of emission times an age fade. Vapour
// therefore appears only when the wings are working — a hard bank, the
// drop dive, an arrival surging in — and is gone within a second.
//
// The air moves with the landscape (the conveyor), so stored points are
// advected −Z by one grid row per frame exactly as the terrain is. A
// station-keeping plane thus streams its vapour straight back into the
// flow, which is the physically right picture.

import * as THREE from 'three';
import {
  TRAIL_SAMPLES, TRAIL_ALPHA, TRAIL_LOAD_ON, TRAIL_LOAD_FULL, TERRAIN_ROW_SPACING,
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
    gl_FragColor = vec4(uColor * vAlpha, vAlpha);
  }
`;

// Wingtip positions in ship-local space (see SHIP_VERTS in ship.ts).
const TIPS = [new THREE.Vector3(-0.65, 0, 0.6), new THREE.Vector3(0.65, 0, 0.6)];

type Ribbon = {
  line: THREE.Line;
  positions: Float32Array; // TRAIL_SAMPLES × 3, oldest → newest
  alphas: Float32Array;    // emission alpha per sample
  posAttr: THREE.BufferAttribute;
  alphaAttr: THREE.BufferAttribute;
};

export type Trails = {
  update: (ships: Ship[], dt: number) => void;
};

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

const _tip = new THREE.Vector3();

export function createTrails(scene: THREE.Scene, ships: Ship[]): Trails {
  const material = new THREE.ShaderMaterial({
    uniforms: { uColor: { value: new THREE.Color(0.72, 0.88, 1.0) } },
    vertexShader: VERT,
    fragmentShader: FRAG,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });

  const ribbons: Ribbon[][] = ships.map(() =>
    TIPS.map(() => {
      const positions = new Float32Array(TRAIL_SAMPLES * 3);
      const alphas = new Float32Array(TRAIL_SAMPLES);
      const geometry = new THREE.BufferGeometry();
      const posAttr = new THREE.BufferAttribute(positions, 3);
      posAttr.setUsage(THREE.DynamicDrawUsage);
      const alphaAttr = new THREE.BufferAttribute(alphas, 1);
      alphaAttr.setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('position', posAttr);
      geometry.setAttribute('aAlpha', alphaAttr);
      const line = new THREE.Line(geometry, material);
      line.frustumCulled = false; // bounds change every frame; not worth recomputing
      line.visible = false;
      scene.add(line);
      return { line, positions, alphas, posAttr, alphaAttr };
    }),
  );

  const update = (list: Ship[], dt: number): void => {
    // Age fade per sample: newest = 1, oldest = 0, eased so the tail thins.
    const n = TRAIL_SAMPLES;
    for (let i = 0; i < list.length; i++) {
      const ship = list[i];
      const pair = ribbons[i];
      if (ship.phase === 'dormant') {
        for (const rb of pair) {
          if (rb.line.visible) {
            rb.alphas.fill(0);
            rb.line.visible = false;
          }
        }
        continue;
      }
      const vapour = smoothstep(TRAIL_LOAD_ON, TRAIL_LOAD_FULL, ship.load) * ship.fade * TRAIL_ALPHA;
      for (let t = 0; t < TIPS.length; t++) {
        const rb = pair[t];
        const pos = rb.positions;
        const al = rb.alphas;
        // Shift history back one sample, advecting every stored point with
        // the landscape.
        for (let k = 0; k < n - 1; k++) {
          pos[k * 3] = pos[(k + 1) * 3];
          pos[k * 3 + 1] = pos[(k + 1) * 3 + 1];
          pos[k * 3 + 2] = pos[(k + 1) * 3 + 2] - TERRAIN_ROW_SPACING;
          al[k] = al[k + 1];
        }
        // Newest sample: the wingtip now.
        _tip.copy(TIPS[t]).applyQuaternion(ship.group.quaternion).add(ship.group.position);
        const last = (n - 1) * 3;
        // A teleport (arrival staging) would draw a streak across the sky —
        // restart the ribbon at the new spot instead.
        const jump = Math.abs(_tip.z - (pos[last + 2] + TERRAIN_ROW_SPACING)) > 8
          || Math.abs(_tip.x - pos[last]) > 8;
        if (jump) {
          for (let k = 0; k < n; k++) {
            pos[k * 3] = _tip.x; pos[k * 3 + 1] = _tip.y; pos[k * 3 + 2] = _tip.z;
            al[k] = 0;
          }
        }
        pos[last] = _tip.x;
        pos[last + 1] = _tip.y;
        pos[last + 2] = _tip.z;
        al[n - 1] = vapour;
        // Visible only if anything in the ribbon still carries vapour.
        let any = false;
        for (let k = 0; k < n; k++) if (al[k] > 0.002) { any = true; break; }
        rb.line.visible = any;
        if (!any) continue;
        // Bake age fade into the uploaded alpha.
        const arr = rb.alphaAttr.array as Float32Array;
        for (let k = 0; k < n; k++) {
          const age = k / (n - 1);
          arr[k] = al[k] * age * age;
        }
        rb.posAttr.needsUpdate = true;
        rb.alphaAttr.needsUpdate = true;
      }
    }
    void dt;
  };

  return { update };
}

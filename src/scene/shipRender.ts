// Instanced rendering for the whole flock: one draw for every ship's edges,
// one for every ship's paper panels. Each ship contributes a position, a
// quaternion, an edge colour and a fade as per-instance attributes; the
// shaders rotate the shared 5-vertex wedge in place. Per-ship materials and
// meshes are gone, so 100 planes cost two draw calls instead of two hundred.

import * as THREE from 'three';
import { SHIP_MAX, SHIP_PANEL_COLOR, SHIP_PANEL_OPACITY, SUN_SHIP_RIM } from '../constants.ts';
import type { Ship, LightUniforms } from './ship.ts';

// Shared wedge vertices — nose at local −Z (see ship.ts for the picture).
const SHIP_VERTS = new Float32Array([
   0,      0,   -1.6,   // 0: nose tip
  -0.65,   0,    0.6,   // 1: back-left wing tip
   0,      0,    0.3,   // 2: back-notch
   0.65,   0,    0.6,   // 3: back-right wing tip
   0,     -0.5,  0.3,   // 4: keel-tail
]);
const EDGE_INDEX = [0, 1, 1, 2, 2, 3, 3, 0, 0, 4, 2, 4, 1, 4, 3, 4];
const PANEL_INDEX = [0, 1, 2, 0, 2, 3, 0, 4, 1, 0, 3, 4, 1, 4, 2, 2, 4, 3];

const ROTATE = /* glsl */ `
  vec3 qrot(vec4 q, vec3 v) {
    return v + 2.0 * cross(q.xyz, cross(q.xyz, v) + q.w * v);
  }
`;

const EDGE_VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec4 iQuat;
  attribute vec3 iColor;
  attribute float iFade;
  varying vec3 vColor;
  varying float vFade;
  ${ROTATE}
  void main() {
    vColor = iColor;
    vFade = iFade;
    vec3 world = iPos + qrot(iQuat, position);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
  }
`;
const EDGE_FRAG = /* glsl */ `
  varying vec3 vColor;
  varying float vFade;
  void main() {
    if (vFade < 0.003) discard;
    gl_FragColor = vec4(vColor, vFade);
  }
`;

// Panel shader — thin frosted paper lit by the horizon sun. The face normal
// comes from screen-space derivatives of the world position (flat shading),
// flipped to face the viewer because a sheet has two sides. Hemisphere
// ambient gives the wedge form with the sun down; wrapped diffuse lights the
// sun side; transmission lets light through faces lit from behind, strongest
// with the sun behind the sheet from the viewer's eye.
const PANEL_VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec4 iQuat;
  attribute float iFade;
  varying vec3 vWorldPos;
  varying float vFade;
  ${ROTATE}
  void main() {
    vWorldPos = iPos + qrot(iQuat, position);
    vFade = iFade;
    gl_Position = projectionMatrix * viewMatrix * vec4(vWorldPos, 1.0);
  }
`;
const PANEL_FRAG = /* glsl */ `
  varying vec3 vWorldPos;
  varying float vFade;
  uniform vec3 uLightDir;
  uniform vec3 uSunColor;
  uniform float uSun;
  uniform vec3 uBase;
  uniform float uOpacity;
  void main() {
    if (vFade < 0.003) discard;
    vec3 n = normalize(cross(dFdx(vWorldPos), dFdy(vWorldPos)));
    vec3 v = normalize(cameraPosition - vWorldPos);
    if (dot(n, v) < 0.0) n = -n;
    float ndl = dot(n, uLightDir);
    float hemi = 0.7 + 0.6 * (n.y * 0.5 + 0.5);
    float wrap = clamp(ndl * 0.6 + 0.4, 0.0, 1.0);
    float transmit = clamp(-ndl, 0.0, 1.0);
    float backlit = pow(max(dot(-v, uLightDir), 0.0), 8.0);
    vec3 col = uBase * hemi
      + uSunColor * uSun * (wrap * 0.3 + transmit * (0.1 + backlit * 0.6));
    float alpha = uOpacity * vFade * (1.0 - backlit * uSun * 0.35);
    gl_FragColor = vec4(col, alpha);
  }
`;

export type ShipRenderer = {
  edges: THREE.LineSegments;
  panels: THREE.Mesh;
  /** Write every ship's transform, colour and fade; call after updateShip. */
  update: (ships: Ship[], light: LightUniforms) => void;
};

export function createShipRenderer(scene: THREE.Scene, light: LightUniforms): ShipRenderer {
  const n = SHIP_MAX;
  const iPos = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  const iQuat = new THREE.InstancedBufferAttribute(new Float32Array(n * 4), 4);
  const iColor = new THREE.InstancedBufferAttribute(new Float32Array(n * 3), 3);
  const iFade = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
  for (const a of [iPos, iQuat, iColor, iFade]) a.setUsage(THREE.DynamicDrawUsage);

  const instanced = (index: number[]): THREE.InstancedBufferGeometry => {
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(SHIP_VERTS, 3));
    g.setIndex(index);
    g.setAttribute('iPos', iPos);
    g.setAttribute('iQuat', iQuat);
    g.setAttribute('iColor', iColor);
    g.setAttribute('iFade', iFade);
    g.instanceCount = 0;
    return g;
  };

  const edgeGeom = instanced(EDGE_INDEX);
  const edges = new THREE.LineSegments(edgeGeom, new THREE.ShaderMaterial({
    vertexShader: EDGE_VERT,
    fragmentShader: EDGE_FRAG,
    transparent: true,
  }));
  edges.frustumCulled = false;

  const panelGeom = instanced(PANEL_INDEX);
  const panels = new THREE.Mesh(panelGeom, new THREE.ShaderMaterial({
    uniforms: {
      uLightDir: light.uLightDir,
      uSunColor: light.uSunColor,
      uSun: light.uSun,
      uBase: { value: new THREE.Color(SHIP_PANEL_COLOR) },
      uOpacity: { value: SHIP_PANEL_OPACITY },
    },
    vertexShader: PANEL_VERT,
    fragmentShader: PANEL_FRAG,
    transparent: true,
    side: THREE.DoubleSide,
  }));
  panels.frustumCulled = false;
  // Panels first so the outline always draws over the body.
  panels.renderOrder = 1;
  edges.renderOrder = 2;
  scene.add(panels);
  scene.add(edges);

  const _up = new THREE.Vector3();
  const _c = new THREE.Color();
  const EDGE_BASE = new THREE.Color(0xeaffff);

  const update = (ships: Ship[], l: LightUniforms): void => {
    const pos = iPos.array as Float32Array;
    const quat = iQuat.array as Float32Array;
    const col = iColor.array as Float32Array;
    const fade = iFade.array as Float32Array;
    const lightDir = l.uLightDir.value;
    const sunColor = l.uSunColor.value;
    const sun = l.uSun.value;
    let count = 0;
    for (let i = 0; i < ships.length; i++) {
      const s = ships[i];
      if (s.phase === 'dormant') { fade[i] = 0; continue; }
      count = i + 1;
      const p = s.group.position;
      const q = s.group.quaternion;
      pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
      quat[i * 4] = q.x; quat[i * 4 + 1] = q.y; quat[i * 4 + 2] = q.z; quat[i * 4 + 3] = q.w;
      // Edge rim light: the wing surface facing the sun brightens and warms.
      _up.set(0, 1, 0).applyQuaternion(q);
      const facing = Math.max(0, _up.dot(lightDir) * 0.5 + 0.5);
      const k = facing * facing * sun * SUN_SHIP_RIM;
      _c.copy(EDGE_BASE).multiplyScalar(0.85 + k * 0.6).lerp(sunColor, k * 0.6);
      col[i * 3] = _c.r; col[i * 3 + 1] = _c.g; col[i * 3 + 2] = _c.b;
      // group.visible is how the cockpit camera hides its own ship.
      fade[i] = s.group.visible ? s.fade : 0;
    }
    edgeGeom.instanceCount = count;
    panelGeom.instanceCount = count;
    iPos.needsUpdate = true;
    iQuat.needsUpdate = true;
    iColor.needsUpdate = true;
    iFade.needsUpdate = true;
  };

  return { edges, panels, update };
}

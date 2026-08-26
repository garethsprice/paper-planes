// Sky dome + horizon light. A large inverted sphere drawn first, with a
// horizon haze that gathers toward the light's azimuth and a small sun disc
// with a corona. The light is the scene's key: its elevation rises with the
// song's long-term energy (a sunrise as crescendo), its colour warms from
// ember to gold, and the same direction/colour rim-lights the ships, washes
// the far side of the grid and catches the mountain crests (see main.ts).

import * as THREE from 'three';
import { SKY_RADIUS } from '../constants.ts';

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = position;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  varying vec3 vDir;
  uniform vec3 uSky;
  uniform vec3 uLightDir;
  uniform vec3 uSunColor;
  uniform float uSun;
  uniform float uFlash;
  void main() {
    vec3 d = normalize(vDir);
    float h = d.y;
    // Horizon haze: strongest at the horizon, gone by ~10° up, and gathered
    // toward the light's azimuth so the sky is warm on one side only.
    // Kept low: the band must stay under the bloom threshold everywhere
    // except the disc, or bloom smears it up the whole sky.
    float band = exp(-max(h, 0.0) * 11.0) * smoothstep(-0.25, 0.0, h);
    vec2 az = normalize(vec2(d.x, d.z) + vec2(1e-5, 0.0));
    vec2 lz = normalize(vec2(uLightDir.x, uLightDir.z));
    float facing = max(0.0, dot(az, lz));
    float gather = pow(facing, 4.0);
    // Disc + tight corona around the light direction.
    float cosA = max(dot(d, uLightDir), 0.0);
    float disc = smoothstep(0.9984, 0.9996, cosA);
    float corona = pow(cosA, 120.0) * 0.45 + pow(cosA, 18.0) * 0.08;
    vec3 col = uSky;
    col += uSunColor * band * gather * uSun * 0.22;
    col += uSunColor * (corona * uSun + disc * (1.0 * uSun + uFlash * 1.5));
    gl_FragColor = vec4(col, 1.0);
  }
`;

export type Sky = {
  mesh: THREE.Mesh;
  material: THREE.ShaderMaterial;
};

export function createSky(
  scene: THREE.Scene,
  shared: { uLightDir: { value: THREE.Vector3 }; uSunColor: { value: THREE.Color }; uSun: { value: number } },
): Sky {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      uSky: { value: new THREE.Color(0x000308) },
      uLightDir: shared.uLightDir,
      uSunColor: shared.uSunColor,
      uSun: shared.uSun,
      uFlash: { value: 0 },
    },
    vertexShader: VERT,
    fragmentShader: FRAG,
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_RADIUS, 48, 32), material);
  mesh.renderOrder = -10; // painted first; everything else draws over it
  mesh.frustumCulled = false;
  scene.add(mesh);
  return { mesh, material };
}

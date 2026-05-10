// Scene root + master camera + fog. The shared uniforms pool also lives
// here because the terrain materials and the post-fx pipeline both need to
// see the same `value` references each frame.

import * as THREE from 'three';
import { HEIGHT_SCALE, DEPTH } from '../constants.ts';

export type SharedUniforms = {
  uTime:            { value: number };
  uFogNear:         { value: number };
  uFogFar:          { value: number };
  uFogColor:        { value: THREE.Color };
  uHeightScale:     { value: number };
  uDepthHalf:       { value: number };
  uHeightMul:       { value: number };
  uHueShift:        { value: number };
  uAuroraPhase:     { value: number };
  uAuroraIntensity: { value: number };
};

export type SceneCore = {
  scene: THREE.Scene;
  fog: THREE.Fog;
  camera: THREE.PerspectiveCamera;
  uniforms: SharedUniforms;
};

export function createSceneCore(): SceneCore {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000308);
  const fog = new THREE.Fog(0x000308, 18, 60);
  scene.fog = fog;

  const camera = new THREE.PerspectiveCamera(
    55,
    window.innerWidth / window.innerHeight,
    0.1,
    200,
  );
  camera.position.set(0, 9, 26);
  camera.lookAt(0, 0, 0);

  // Shared uniform refs — terrain + mirror materials both see the SAME
  // {value:...} objects so JS-side updates propagate without per-frame copies.
  // Don't reassign material.uniforms.X = {...}; mutate .value only.
  const uniforms: SharedUniforms = {
    uTime:            { value: 0 },
    uFogNear:         { value: fog.near },
    uFogFar:          { value: fog.far },
    uFogColor:        { value: new THREE.Color(0x000308) },
    uHeightScale:     { value: HEIGHT_SCALE },
    uDepthHalf:       { value: DEPTH * 0.5 },
    uHeightMul:       { value: 1.0 },
    uHueShift:        { value: 0.0 },
    uAuroraPhase:     { value: 0.0 },
    uAuroraIntensity: { value: 0.0 },
  };

  return { scene, fog, camera, uniforms };
}

// WebGLRenderer + post-processing pipeline. The composer chain is:
//   HybridRenderPass (mono or stereo) → bloom → chromatic → OutputPass
// In stereo, bloom + chromatic are scaled down so the seam smear stays
// minimal. In a WebXR session we bypass the composer and render directly
// per eye via the headset's view layout.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { BLOOM_DIVISOR } from '../constants.ts';
import type { StereoState } from './stereo.ts';
import { HybridRenderPass } from './stereo.ts';

const ChromaticAberrationShader = {
  uniforms: {
    tDiffuse: { value: null },
    uAmount: { value: 0.002 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec2 dir = vUv - 0.5;
      float r = texture2D(tDiffuse, vUv - dir * uAmount).r;
      float g = texture2D(tDiffuse, vUv).g;
      float b = texture2D(tDiffuse, vUv + dir * uAmount).b;
      gl_FragColor = vec4(r, g, b, 1.0);
    }
  `,
};

export type RenderPipeline = {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  chromaticPass: ShaderPass;
};

export function createRenderPipeline(
  canvas: HTMLCanvasElement,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  stereo: StereoState,
): RenderPipeline {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    powerPreference: 'high-performance',
  });
  // DPR cap of 1.5 — halves per-pixel fragment work on HiDPI screens with
  // negligible visual cost on glow-heavy lines.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 0.95;
  // WebXR is enabled lazily by the VR button (see xr/session.ts) — having
  // it on at startup can interfere with the SBS scissor render.
  renderer.xr.setReferenceSpaceType('local-floor');

  const bloomRes = new THREE.Vector2(
    window.innerWidth / BLOOM_DIVISOR,
    window.innerHeight / BLOOM_DIVISOR,
  );
  const composer = new EffectComposer(renderer);
  composer.addPass(new HybridRenderPass(scene, camera, stereo));
  const bloom = new UnrealBloomPass(
    bloomRes,
    0.4,  // strength — animate() rewrites each frame; this is the at-rest value
    0.55, // radius
    0.08, // threshold — only the brightest peaks bloom
  );
  composer.addPass(bloom);
  const chromaticPass = new ShaderPass(ChromaticAberrationShader);
  composer.addPass(chromaticPass);
  composer.addPass(new OutputPass());

  return { renderer, composer, bloom, chromaticPass };
}

export type PostFxInput = {
  intensity: number;
  bassEnergy: number;
  dropBoost: number;
  stereoEnabled: boolean;
};

/** Per-frame update for bloom strength + chromatic amount. Stereo uses a
 *  much gentler bloom curve to minimise smear across the eye seam, and
 *  disables chromatic entirely (it's radial-from-center and would centre on
 *  the seam). */
export function updatePostFx(pipeline: RenderPipeline, input: PostFxInput): void {
  const { intensity: I, bassEnergy, dropBoost, stereoEnabled } = input;
  const bloomMul = stereoEnabled ? 0.4 : 1.0;
  pipeline.bloom.strength =
    ((0.28 + 0.12 * I) + bassEnergy * 0.22 * I + dropBoost * 0.35) * bloomMul;
  pipeline.bloom.radius = stereoEnabled ? 0.3 : 0.55;
  pipeline.chromaticPass.enabled = !stereoEnabled;
  if (!stereoEnabled) {
    pipeline.chromaticPass.uniforms.uAmount.value = Math.min(
      0.012,
      0.0008 + bassEnergy * 0.006 * I + dropBoost * 0.005,
    );
  }
}

/** Render-call dispatch: bypass composer when WebXR is presenting (the
 *  headset handles per-eye stereo + projection itself). */
export function renderFrame(
  pipeline: RenderPipeline,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  dt: number,
): void {
  if (pipeline.renderer.xr.isPresenting) {
    pipeline.renderer.render(scene, camera);
  } else {
    pipeline.composer.render(dt);
  }
}

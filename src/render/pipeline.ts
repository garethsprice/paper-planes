// WebGLRenderer + post-processing pipeline. The composer chain is:
//   HybridRenderPass (mono or stereo) → bloom → ChromaticOutputPass
// The output pass does the chromatic fringe in the same fullscreen shader
// as tone mapping and the sRGB transfer, so the frame makes one trip
// through a full-resolution pass instead of two. In stereo the fringe is
// off (it is radial from the centre and would centre on the seam) and the
// bloom is scaled down so the seam smear stays minimal. In a WebXR session
// we bypass the composer and render directly per eye via the headset's
// view layout.

import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import {
  BLOOM_DIVISOR, MOOD_DIM_BUILD, MOOD_FLASH_EXPOSURE, MOOD_FLASH_BLOOM,
} from '../constants.ts';
import type { StereoState } from './stereo.ts';
import { HybridRenderPass } from './stereo.ts';

/** three's OutputPass (tone mapping + colour space) with a chromatic
 *  aberration fringe folded into the same fullscreen draw: each channel is
 *  sampled at a slightly different radial offset before tone mapping —
 *  exactly what the separate ShaderPass did, minus a full-resolution
 *  render-target round trip per frame. `uAmount` = 0 is the identity. */
class ChromaticOutputPass extends OutputPass {
  /** Fringe amount in UV units (0 = off). */
  readonly amount = { value: 0 };

  constructor() {
    super();
    (this.uniforms as Record<string, THREE.IUniform>).uAmount = this.amount;
    const src = this.material.fragmentShader;
    const patched = src
      .replace(
        'uniform sampler2D tDiffuse;',
        'uniform sampler2D tDiffuse;\n\t\tuniform float uAmount;',
      )
      .replace(
        'gl_FragColor = texture2D( tDiffuse, vUv );',
        `vec2 dir = vUv - 0.5;
			gl_FragColor = vec4(
				texture2D( tDiffuse, vUv - dir * uAmount ).r,
				texture2D( tDiffuse, vUv ).g,
				texture2D( tDiffuse, vUv + dir * uAmount ).b,
				1.0 );`,
      );
    if (patched === src || !patched.includes('uAmount )')) {
      throw new Error('ChromaticOutputPass: OutputShader source changed; update the patch');
    }
    this.material.fragmentShader = patched;
    this.material.needsUpdate = true;
  }
}

export type RenderPipeline = {
  renderer: THREE.WebGLRenderer;
  composer: EffectComposer;
  bloom: UnrealBloomPass;
  output: ChromaticOutputPass;
};

export function createRenderPipeline(
  canvas: HTMLCanvasElement,
  scene: THREE.Scene,
  camera: THREE.PerspectiveCamera,
  stereo: StereoState,
): RenderPipeline {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    // Every 2D frame goes through the composer, whose render targets are
    // single-sampled; the default framebuffer only ever receives the
    // output pass's fullscreen quad. A multisampled backbuffer would cost
    // memory bandwidth and a resolve every frame for nothing.
    antialias: false,
    stencil: false,
    powerPreference: 'high-performance',
  });
  // DPR cap of 1.5 — halves per-pixel fragment work on HiDPI screens with
  // negligible visual cost on glow-heavy lines.
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setSize(window.innerWidth, window.innerHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = BASE_EXPOSURE;
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
    0.2,  // strength — animate() rewrites each frame; this is the at-rest value
    0.32, // radius — tight; the wide 0.55 on a half-res buffer blotched
    0.42, // threshold — only genuinely bright crests and the ships bloom
  );
  composer.addPass(bloom);
  const output = new ChromaticOutputPass();
  composer.addPass(output);

  return { renderer, composer, bloom, output };
}

export type PostFxInput = {
  intensity: number;
  bassEnergy: number;
  dropBoost: number;
  stereoEnabled: boolean;
  /** Mood scalars — see scene/mood.ts. */
  anticipation: number;
  flash: number;
  hush: number;
};

const BASE_EXPOSURE = 0.88;

/** Per-frame update for bloom strength + chromatic amount. Stereo uses a
 *  much gentler bloom curve to minimise smear across the eye seam, and
 *  disables chromatic entirely (it's radial-from-center and would centre on
 *  the seam). */
export function updatePostFx(pipeline: RenderPipeline, input: PostFxInput): void {
  const { intensity: I, bassEnergy, dropBoost, stereoEnabled, anticipation, flash, hush } = input;
  const bloomMul = stereoEnabled ? 0.4 : 1.0;
  // Restrained: at-rest 0.18, peaks around 0.5 on a drop. Glow should read
  // as a halo on the brightest crests, never a wash over the whole grid —
  // except for the flash, the one moment white is allowed.
  pipeline.bloom.strength =
    ((0.16 + 0.06 * I) + bassEnergy * 0.10 * I + dropBoost * 0.18 + flash * MOOD_FLASH_BLOOM) * bloomMul;
  // A build withholds light; the hush withholds more; the flash gives it
  // all back for a quarter second.
  pipeline.renderer.toneMappingExposure =
    BASE_EXPOSURE * (1 - MOOD_DIM_BUILD * anticipation) * (1 - 0.3 * hush)
    + flash * MOOD_FLASH_EXPOSURE;
  pipeline.bloom.radius = stereoEnabled ? 0.25 : 0.32;
  // A whisper of fringing — beyond ~0.004 the stars split into RGB triplets.
  pipeline.output.amount.value = stereoEnabled
    ? 0
    : Math.min(0.0035, 0.0003 + bassEnergy * 0.0015 * I + dropBoost * 0.0015);
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

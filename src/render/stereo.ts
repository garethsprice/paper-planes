// Side-by-side stereo for AR glasses that split the canvas down the middle.
// HybridRenderPass replaces the standard RenderPass: when `stereoEnabled` is
// true it renders cameraL and cameraR into two halves of the same RT (so
// downstream passes get a single image with both eyes laid out).

import * as THREE from 'three';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';

export type StereoState = {
  enabled: boolean;
  camera: THREE.StereoCamera;
};

export function createStereoState(): StereoState {
  const camera = new THREE.StereoCamera();
  camera.aspect = 0.5;
  // eyeSep is in world units; the scene is ~50u wide, so 0.4 reads as
  // natural depth on AR glasses without crossing-eyes strain. [ / ] keys
  // nudge it.
  camera.eyeSep = 0.4;
  return { enabled: false, camera };
}

/** RenderPass that switches between mono and side-by-side stereo on the fly. */
export class HybridRenderPass extends RenderPass {
  private state: StereoState;
  private masterCamera: THREE.PerspectiveCamera;

  constructor(scene: THREE.Scene, masterCamera: THREE.PerspectiveCamera, state: StereoState) {
    super(scene, masterCamera);
    this.state = state;
    this.masterCamera = masterCamera;
  }

  override render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
    deltaTime: number,
    maskActive: boolean,
  ): void {
    if (!this.state.enabled) {
      super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
      return;
    }
    const target = this.renderToScreen ? null : writeBuffer;
    renderer.setRenderTarget(target);
    if (this.clear) renderer.clear();
    this.scene.updateMatrixWorld();
    this.masterCamera.updateMatrixWorld();
    this.state.camera.update(this.masterCamera);
    const w = target ? target.width : renderer.domElement.width;
    const h = target ? target.height : renderer.domElement.height;
    const halfW = (w / 2) | 0;
    renderer.setScissorTest(true);
    renderer.setScissor(0, 0, halfW, h);
    renderer.setViewport(0, 0, halfW, h);
    renderer.render(this.scene, this.state.camera.cameraL);
    renderer.setScissor(halfW, 0, w - halfW, h);
    renderer.setViewport(halfW, 0, w - halfW, h);
    renderer.render(this.scene, this.state.camera.cameraR);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
  }
}

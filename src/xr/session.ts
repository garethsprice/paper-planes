// WebXR (Quest browser) session lifecycle. The "enter vr" button enables
// renderer.xr lazily because having it on at startup can interfere with
// the side-by-side stereo render path even with no active session. On
// session start we snapshot the current cinematic state, switch to the VR
// observer anchor, and disable the director (cuts in VR are nauseating).
// On session end we restore everything.

import * as THREE from 'three';
import type { CameraSelection } from '../camera/modes.ts';
import type { Director } from '../camera/director.ts';
import type { StereoState } from '../render/stereo.ts';

export type XrDeps = {
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  cameraSel: CameraSelection;
  director: Director;
  stereo: StereoState;
  setStereo: (on: boolean) => void;
  stereoBtn: HTMLButtonElement;
  vrBtn: HTMLButtonElement | null;
  statusEl: HTMLElement;
};

export function installXr(deps: XrDeps): void {
  const { renderer, camera, cameraSel, director, stereo, setStereo, stereoBtn, vrBtn, statusEl } = deps;
  let prevCamModeIdx = 0;
  let prevCinematicAuto = true;
  let activeXrSession: XRSession | null = null;

  renderer.xr.setReferenceSpaceType('local-floor');

  renderer.xr.addEventListener('sessionstart', () => {
    prevCamModeIdx = cameraSel.currentIdx;
    prevCinematicAuto = director.cinematicAuto;
    cameraSel.currentIdx = cameraSel.vrObserverIdx;
    director.cinematicAuto = false;
    if (stereo.enabled) setStereo(false);
    stereoBtn.style.display = 'none';
    if (vrBtn) vrBtn.textContent = 'exit vr';
  });
  renderer.xr.addEventListener('sessionend', () => {
    cameraSel.currentIdx = prevCamModeIdx;
    director.cinematicAuto = prevCinematicAuto;
    stereoBtn.style.display = '';
    activeXrSession = null;
    if (vrBtn) vrBtn.textContent = 'enter vr';
    // Disable XR so the renderer's SBS path has no residual XR machinery.
    renderer.xr.enabled = false;
    // WebXR can leave the master camera with a stereo-eye projection — reset.
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
  });

  if (vrBtn) {
    if ('xr' in navigator && navigator.xr) {
      navigator.xr.isSessionSupported('immersive-vr').then((supported) => {
        if (supported) vrBtn.style.display = '';
      }).catch(() => { /* no XR */ });
    }
    vrBtn.addEventListener('click', async () => {
      if (activeXrSession) {
        await activeXrSession.end();
        return;
      }
      try {
        renderer.xr.enabled = true;
        const session = await navigator.xr!.requestSession('immersive-vr', {
          optionalFeatures: ['local-floor', 'bounded-floor'],
        });
        activeXrSession = session;
        await renderer.xr.setSession(session as unknown as XRSession);
      } catch (e) {
        renderer.xr.enabled = false;
        statusEl.textContent = `vr failed: ${(e as Error).message}`;
      }
    });
  }
}

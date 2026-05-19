import * as THREE from 'three';
import {
  COLS, ROWS, HEIGHT_SCALE, NOISE_AMP, BLOOM_DIVISOR,
} from './constants.ts';
import { createStereoState } from './render/stereo.ts';
import { createRenderPipeline, updatePostFx, renderFrame } from './render/pipeline.ts';
import { installXr } from './xr/session.ts';
import { arrowKeys, installKeyHandlers } from './input/keys.ts';
import {
  installInteractionTracking, updateUiVisibility, updateBpmReadout, updateDebugPanel,
} from './ui/status.ts';
import { dom } from './ui/dom.ts';
import { createFrame } from './frame.ts';
import { createSceneCore } from './scene/core.ts';
import { createTerrain, sampleLogBin } from './scene/terrain.ts';
import { createStars } from './scene/stars.ts';
import { createNebula } from './scene/nebula.ts';
import { createShips, activateFormation, updateShipControls, syncShipFromBody } from './scene/ship.ts';
import { createPhysics } from './scene/physics.ts';
import {
  ensureAudio, getAudio, attachStream, loadAudioFile,
  type AudioState,
} from './audio/sources.ts';
import { createBpmHandle, ensureBpm, resetBpm } from './audio/bpm.ts';
import { createDynamics, updateDynamics, decayDynamics } from './audio/dynamics.ts';
import { extractAudio } from './audio/analyser.ts';
import {
  createCameraSelection, applyCut, trackedShipIdx as getTrackedShipIdx,
} from './camera/modes.ts';
import { createOrbit, attachOrbitInput, updateOrbitPhysics } from './camera/orbit.ts';
import { createDirector, runDirector, bumpPilotControl } from './camera/director.ts';
import { updateCamera } from './camera/update.ts';

const { canvas, fileInput, playBtn, micBtn, tabBtn, stereoBtn, uiEl, statusEl, bpmNumEl, bpmDotEl, dbgEl } = dom;

// ----- three.js core (scene, fog, camera, shared uniform pool) -----
const sceneCore = createSceneCore();
const { scene, camera, uniforms } = sceneCore;

// ----- stereo camera for side-by-side AR-glasses output -----
// StereoCamera derives off-axis cameraL/cameraR from the master each frame.
// aspect=0.5 because each eye renders into half the canvas width.
// eyeSep is in world units; scene is ~50u wide, so 0.4 reads as natural depth
// without crossing-eyes strain. [ / ] keys nudge it.
// ----- stereo + render pipeline (composer with bloom + chromatic) -----
const stereo = createStereoState();
const pipeline = createRenderPipeline(canvas, scene, camera, stereo);
const { renderer } = pipeline;

// ----- terrain (line-grid spectrogram) + mirror reflection + scene props -----
const terrain = createTerrain(sceneCore);
const { posAttr, heights, noise3, binMap, mirrorMaterial } = terrain;
const stars = createStars(scene);
const nebula = createNebula(scene);

// ----- Rapier physics world (must finish WASM init before bodies can spawn) -----
const physics = await createPhysics();

// ----- ships + formation flight (factories live in src/scene/ship.ts) -----
const shipsHandle = createShips(scene, physics);
const ships = shipsHandle.list;
const formation = shipsHandle.formation;


// ----- audio plumbing -----
// Per-frame mutable context — extractAudio / updateDynamics / updateShipControls
// each read what they need and write whatever they own.
const frame = createFrame();
const bpmHandle = createBpmHandle();
const dynamics = createDynamics();
let bassEnergy = 0;     // populated each frame from extractAudio (kept for orbit camera bass impulse)

function audio(): AudioState { return ensureAudio(); }

// Wire AudioElement events that need handler-side state
audio().audioEl.addEventListener('ended', () => {
  playBtn.textContent = 'play';
});

function loadFile(f: File): void {
  const a = audio();
  loadAudioFile(a, bpmHandle, f);
  ensureBpm(bpmHandle, a.ctx);
  playBtn.disabled = false;
  playBtn.textContent = 'play';
  statusEl.textContent = f.name;
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
});

// drag-and-drop audio onto the canvas
canvas.addEventListener('dragover', (e) => {
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
});
canvas.addEventListener('drop', (e) => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && (f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name))) {
    loadFile(f);
  } else if (f) {
    statusEl.textContent = `unsupported file type: ${f.type || f.name}`;
  }
});

playBtn.addEventListener('click', async () => {
  const a = audio();
  if (a.ctx.state === 'suspended') await a.ctx.resume();
  if (a.audioEl.paused) {
    await a.audioEl.play();
    playBtn.textContent = 'pause';
  } else {
    a.audioEl.pause();
    playBtn.textContent = 'play';
  }
});

micBtn.addEventListener('click', async () => {
  try {
    const a = audio();
    if (a.ctx.state === 'suspended') await a.ctx.resume();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    attachStream(a, bpmHandle, stream);
    ensureBpm(bpmHandle, a.ctx);
    playBtn.disabled = true;
    statusEl.textContent = 'mic live';
  } catch (e) {
    statusEl.textContent = `mic blocked: ${(e as Error).message}`;
  }
});

tabBtn.addEventListener('click', async () => {
  try {
    const a = audio();
    if (a.ctx.state === 'suspended') await a.ctx.resume();
    // getDisplayMedia requires video:true to be acceptable across browsers,
    // even when we only want the audio track. We stop the video track
    // immediately to avoid the encoded-frame overhead.
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    stream.getVideoTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length === 0) {
      stream.getTracks().forEach((t) => t.stop());
      statusEl.textContent = 'no tab audio — tick "share tab audio" in the picker';
      return;
    }
    attachStream(a, bpmHandle, stream);
    ensureBpm(bpmHandle, a.ctx);
    playBtn.disabled = true;
    statusEl.textContent = 'tab audio · source tab plays it';
  } catch (e) {
    statusEl.textContent = `tab audio failed: ${(e as Error).message}`;
  }
});

// ----- mouse orbit (subtle spring physics, used by preset modes) -----
const orbit = createOrbit();
attachOrbitInput(orbit, canvas);

// auto-start mic on the first canvas click (user-gesture context for
// getUserMedia + AudioContext.resume). Bypassed if a source is already
// connected via file/mic button.
let autoMicTried = false;
canvas.addEventListener('click', () => {
  if (autoMicTried || getAudio()?.currentSourceNode) return;
  autoMicTried = true;
  micBtn.click();
});

// ----- camera mode catalogue + music-driven director -----
const cameraSel = createCameraSelection(ships.length);
const director = createDirector();

// ----- keyboard shortcuts + UI auto-hide tracking -----
installKeyHandlers({
  togglePlay: () => { if (!playBtn.disabled) playBtn.click(); },
  toggleBloom: () => {
    pipeline.bloom.enabled = !pipeline.bloom.enabled;
    statusEl.textContent = `bloom ${pipeline.bloom.enabled ? 'on' : 'off'}`;
  },
  toggleFullscreen: () => {
    if (!document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => { /* ignore */ });
    else document.exitFullscreen();
  },
  resetBpm: () => { resetBpm(bpmHandle); statusEl.textContent = 'bpm reset'; },
  toggleNebula: () => {
    nebula.visible = !nebula.visible;
    statusEl.textContent = `nebula ${nebula.visible ? 'on' : 'off'}`;
  },
  cycleCamera: () => {
    applyCut(cameraSel, (cameraSel.currentIdx + 1) % cameraSel.modes.length, bpmHandle.beatCount);
    statusEl.textContent = `cam: ${cameraSel.modes[cameraSel.currentIdx].label}`;
  },
  toggleCinematic: () => {
    director.cinematicAuto = !director.cinematicAuto;
    cameraSel.modeChangedAt = performance.now();
    cameraSel.beatsAtChange = bpmHandle.beatCount;
    statusEl.textContent = `cinematic ${director.cinematicAuto ? 'on' : 'off'}`;
  },
  toggleStereo: () => setStereo(!stereo.enabled),
  nudgeEyeSep: (delta) => {
    stereo.camera.eyeSep = Math.max(0.05, Math.min(2.0, stereo.camera.eyeSep + delta));
    statusEl.textContent = `eyeSep ${stereo.camera.eyeSep.toFixed(2)}`;
  },
  bumpPilotControl: () => bumpPilotControl(director, cameraSel),
});
const interaction = installInteractionTracking();

// ----- drop response: per-event side effects, fired once when dropCount advances -----
let lastSeenDropCount = 0;
let dropFovOverlayUntil = 0; // ms timestamp; FOV widens until this time
let dropFiredThisFrame = false; // consumed by the cinematic director below

function onDrop() {
  // Formation flight for ~6 seconds (≈8 bars at 120 BPM, 4 bars at 60 BPM —
  // good enough that the formation is held long enough to read).
  const ms = bpmHandle.bpm > 0 ? (60 / bpmHandle.bpm) * 1000 * 8 : 6000;
  activateFormation(formation, ms);
  // FOV widen pulse — the awe shot
  dropFovOverlayUntil = performance.now() + 600;
  // The cinematic director (later in the same frame) reads this flag to
  // hard-cut to a dramatic angle.
  dropFiredThisFrame = true;
}

// ----- animation loop -----
const clock = new THREE.Clock();
const ROW_STRIDE_FRONT = (ROWS - 1) * COLS; // newest row offset in heights[]

function animate() {
  // setAnimationLoop drives this externally — works for both rAF (2D) and
  // the WebXR display vsync. Skip per-frame work when the tab is hidden in
  // 2D mode; in XR the headset always wants frames, so don't skip there.
  if (document.hidden && !renderer.xr.isPresenting) return;
  const dt = clock.getDelta();
  const t = clock.getElapsedTime();
  uniforms.uTime.value = t;

  // shift heights[] rows toward iy=0 (away from camera).
  heights.copyWithin(0, COLS, ROWS * COLS);

  // Audio: pull a fresh FFT and derive bass / level / centroid into the frame.
  const audioState = getAudio();
  const audioSnap = extractAudio(audioState, frame);
  bassEnergy = frame.bassEnergy;
  const level = frame.level;
  const centroid = frame.centroid;
  const fftBins = audioSnap.fftBins;

  // Dynamics: advance the EMAs + drop detector. When no source is attached,
  // decay toward zero so transitions back to "idle" look smooth.
  if (fftBins) {
    if (updateDynamics(dynamics, audioSnap.peakLevel, dt)) {
      // drop fired this frame — onDrop() runs further down once we know
      // dropCount has advanced, since the same edge feeds the cinematic
      // director's hard-cut path.
    }
  } else {
    decayDynamics(dynamics);
  }

  // Front-row write — log-scaled FFT amplitude + low-amp simplex texture.
  const baseIdx = ROW_STRIDE_FRONT;
  if (fftBins) {
    for (let ix = 0; ix < COLS; ix++) {
      const amp = sampleLogBin(fftBins, binMap[ix]) / 255;
      const shaped = Math.pow(amp, 0.85);
      const n = noise3(ix * 0.08, t * 0.35, 0) * NOISE_AMP;
      heights[baseIdx + ix] = shaped * HEIGHT_SCALE + n;
    }
  } else {
    for (let ix = 0; ix < COLS; ix++) {
      const n = (noise3(ix * 0.08, t * 0.25, 0) * 0.5 + 0.5) * NOISE_AMP * 4;
      heights[baseIdx + ix] = n;
    }
  }

  // copy heights → position attribute Y
  const pa = posAttr.array as Float32Array;
  for (let i = 0, p = 1; i < heights.length; i++, p += 3) {
    pa[p] = heights[i];
  }
  posAttr.needsUpdate = true;
  // fire drop-response side effects when a new drop has been recorded.
  // Reset dropFiredThisFrame here so it's only true on the frame the drop fires.
  dropFiredThisFrame = false;
  if (dynamics.dropCount !== lastSeenDropCount) {
    lastSeenDropCount = dynamics.dropCount;
    onDrop();
  }

  // global reactivity scalars derived from dynamics — used throughout the
  // remainder of the frame.
  const sinceDrop = (performance.now() - dynamics.dropTime) / 1000;
  const dropBoost = sinceDrop < 1.5 ? Math.exp(-sinceDrop * 2.0) : 0;
  const I = dynamics.intensity;

  // FOV widen pulse during the brief drop overlay
  const fovOverlay = Math.max(0, dropFovOverlayUntil - performance.now()) / 600;
  const targetFov = 55 + fovOverlay * 8;
  if (Math.abs(camera.fov - targetFov) > 0.01) {
    camera.fov = targetFov;
    camera.updateProjectionMatrix();
  }

  // formation lifecycle: ease blend in/out, expire when window passes
  if (formation.active && performance.now() > formation.endsAt) {
    formation.active = false; // stays in blendOut decay until next activation
  }
  const formationLerp = 1 - Math.exp(-(formation.active ? 1.7 : 1.2) * dt);
  formation.blendIn += ((formation.active ? 1 : 0) - formation.blendIn) * formationLerp;
  formation.blendOut = formation.blendIn; // single state suffices — blend toward target

  // The currently-tracked ship (chase/cockpit) wraps Z front↔back; others clamp.
  const trackedShipIdx = getTrackedShipIdx(cameraSel);
  const shipInput = {
    dt, time: t, level, centroid,
    bassEnergy, beatPulse: bpmHandle.beatPulse, arrowKeys,
  };
  // 1. Queue forces and torques on every body.
  ships.forEach((ship, i) =>
    updateShipControls(ship, i, ships, formation, terrain, shipInput, i === trackedShipIdx),
  );
  // 2. One world step integrates all bodies under the queued forces.
  physics.world.step();
  // 3. Post-step: sync Three.js groups, enforce terrain floor + bounds, refresh heading cache.
  ships.forEach((ship, i) => syncShipFromBody(ship, terrain, i === trackedShipIdx));

  // Music-driven cinematic director — synchronises cuts to drops, builds,
  // quiet sections, and beat cadence. 'V' toggles, 'C' jumps regardless.
  runDirector(director, cameraSel, {
    dynamics,
    dropFiredThisFrame,
    beatCount: bpmHandle.beatCount,
    bpm: bpmHandle.bpm,
  });

  // restore visibility every frame; the active cockpit mode hides its own ship.
  for (const s of ships) s.group.visible = true;

  // Orbit physics (consumed by preset modes); then dispatch on the active mode.
  updateOrbitPhysics(orbit, bassEnergy, dt);
  updateCamera(camera, cameraSel, orbit, ships, {
    bassEnergy,
    intensity: I,
    buildLevel: dynamics.build,
    dt,
  });

  // (sinceDrop and dropBoost computed earlier in this frame, see top of
  // animation loop block above the camera section.)

  // beat pulse breathes the landscape; scaled by intensity so it's flat on
  // quiet sections and full-bodied during loud ones.
  uniforms.uHeightMul.value = 1.0 + bpmHandle.beatPulse * 0.10 * I;
  // aurora: phase sweeps slowly (faster on louder sections), intensity
  // fades to zero during quiet.
  uniforms.uAuroraPhase.value += (0.4 + I * 0.4) * dt;
  uniforms.uAuroraIntensity.value = I * 0.45 + dropBoost * 0.3;
  // mirror world fades down when the scene is quiet
  mirrorMaterial.uniforms.uOpacity.value = 0.10 * I;
  // very subtle star parallax (independent of intensity — the cosmos doesn't pause)
  stars.rotation.y += 0.0003;
  // nebula swirls a bit faster on bass; intensity scales the speed-up
  nebula.rotation.y += 0.0008 + bassEnergy * 0.004 * I;
  (nebula.material as THREE.PointsMaterial).color.setRGB(
    0.45 + centroid * 0.55,
    0.55 + 0.10 * (1 - centroid),
    0.95 - centroid * 0.30,
  );

  updateUiVisibility(uiEl, interaction);
  // hue: BPM offset + slow time cycle, attenuated by intensity
  const tempoForHue = bpmHandle.bpm > 0 ? bpmHandle.bpm : 120;
  const bpmHue = Math.max(-0.05, Math.min(0.05, (tempoForHue - 120) / 60 * 0.05));
  uniforms.uHueShift.value = (bpmHue + Math.sin(t * 0.07) * 0.04) * (0.4 + 0.6 * I);

  updatePostFx(pipeline, { intensity: I, bassEnergy, dropBoost, stereoEnabled: stereo.enabled });

  // beat-dot pulse: validPeak event sets beatPulse=1; decay each frame.
  bpmHandle.beatPulse *= Math.exp(-9 * dt); // visible for ~150ms after each peak
  updateBpmReadout({ uiEl, bpmNumEl, bpmDotEl, dbgEl }, bpmHandle);
  updateDebugPanel(dbgEl, dynamics, formation, dropBoost);

  renderFrame(pipeline, scene, camera, dt);
}
renderer.setAnimationLoop(animate);

function setStereo(on: boolean) {
  stereo.enabled = on;
  stereoBtn.classList.toggle('on', on);
  // Master camera aspect: stereo uses full canvas with internal 0.5 split,
  // so the master stays at canvas aspect either way — but we re-derive in
  // case the next frame is mono.
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
  statusEl.textContent = on
    ? `3d on · eyeSep ${stereo.camera.eyeSep.toFixed(2)} · [ ] to adjust`
    : '3d off';
}
stereoBtn.addEventListener('click', () => setStereo(!stereo.enabled));

// ----- WebXR (Quest browser) session lifecycle -----
installXr({
  renderer, camera, cameraSel, director, stereo, setStereo,
  stereoBtn, vrBtn: dom.vrBtn, statusEl,
});

// ----- resize -----
window.addEventListener('resize', () => {
  const w = window.innerWidth;
  const h = window.innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
  pipeline.composer.setSize(w, h);
  // Match the BLOOM_DIVISOR-reduced bloom resolution.
  pipeline.bloom.setSize(w / BLOOM_DIVISOR, h / BLOOM_DIVISOR);
});

import * as THREE from 'three';
import {
  COLS, ROWS, HEIGHT_SCALE, NOISE_AMP, BLOOM_DIVISOR, TERRAIN_ROW_SPACING, CAM_BLEND_MANUAL_S,
  TERRAIN_ROW_BLEND, TERRAIN_SWELL, TERRAIN_BREATH_ATTACK, TERRAIN_BREATH_RELEASE, TERRAIN_BREATH_AMP,
  MOOD_FOG_BUILD, MOOD_DIM_HUSH, MOOD_FOV_AFTERGLOW, MOOD_SCATTER_X,
  MOUNTAIN_PARALLAX, MOUNTAIN_PARALLAX_ENERGY,
  SUN_AZIMUTH_X, SUN_AZIMUTH_Z, SUN_ELEV_MIN_DEG, SUN_ELEV_MAX_DEG, SUN_ARC_S,
  SUN_INTENSITY_MIN, SUN_HUSH_DIM,
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
import { createTerrain, sampleLogBin, bilerpHeight } from './scene/terrain.ts';
import { createStars } from './scene/stars.ts';
import { createNebula } from './scene/nebula.ts';
import { createShips, updateShip, scatterShip, applyShipLighting } from './scene/ship.ts';
import { createSky } from './scene/sky.ts';
import { createMood, updateMood } from './scene/mood.ts';
import { createMountains } from './scene/mountains.ts';
import { createTrails } from './scene/trails.ts';
import { createFlock, updateFlock } from './scene/flock.ts';
import {
  ensureAudio, getAudio, attachStream, loadAudioFile,
  type AudioState,
} from './audio/sources.ts';
import { createBpmHandle, ensureBpm, resetBpm } from './audio/bpm.ts';
import { createDynamics, updateDynamics, decayDynamics } from './audio/dynamics.ts';
import { extractAudio } from './audio/analyser.ts';
import {
  createCameraSelection, applyCut, trackedShipIdx as getTrackedShipIdx,
  nextAvailableMode, pickCinematicMode,
} from './camera/modes.ts';
import { createOrbit, attachOrbitInput, updateOrbitPhysics } from './camera/orbit.ts';
import { createDirector, runDirector, bumpPilotControl } from './camera/director.ts';
import { createRhyme, updateRhyme } from './camera/rhyme.ts';
import { updateCamera, createCameraRig } from './camera/update.ts';

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
const mountains = createMountains(scene, terrain.noise3, uniforms);
const sky = createSky(scene, uniforms);
let sunArc = 0.3; // very slow long-term energy: drives the light's elevation and warmth
const SUN_EMBER = new THREE.Color(0.95, 0.28, 0.08);
const SUN_GOLD = new THREE.Color(1.0, 0.8, 0.5);
const mood = createMood();
let mountainEnvelope = 0.5; // slow-smoothed flock energy that raises the range
let mountainScroll = 0;     // world-Z offset of the range's height field (parallax)
const FOG_NEAR_BASE = sceneCore.fog.near;
const FOG_FAR_BASE = sceneCore.fog.far;

// ----- ships + formation flight (factories live in src/scene/ship.ts) -----
const shipsHandle = createShips(scene, uniforms);
const ships = shipsHandle.list;
const formation = shipsHandle.formation;
const flock = createFlock();
const trails = createTrails(scene, ships);


// ----- audio plumbing -----
// Per-frame mutable context — extractAudio / updateDynamics / updateShip
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
// Tracked camera modes exist for the first three ships only; the director
// and the C key skip any whose ship isn't currently in the flock.
const cameraSel = createCameraSelection(3);
const cameraRig = createCameraRig();
const director = createDirector();
const rhyme = createRhyme();

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
    applyCut(cameraSel, nextAvailableMode(cameraSel), bpmHandle.beatCount, CAM_BLEND_MANUAL_S);
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
let dropFiredThisFrame = false; // consumed by the cinematic director below

function onDrop(time: number) {
  // The build has pulled the flock into formation and lifted it; the drop
  // breaks it — every plane scatters sideways and dives.
  for (const ship of ships) {
    if (ship.phase === 'dormant') continue;
    const side = ship.wanderSeed % 2 < 1 ? -1 : 1;
    scatterShip(ship, time, side * MOOD_SCATTER_X * (0.5 + 0.5 * Math.abs(Math.sin(ship.wanderSeed))));
  }
  // The cinematic director (later in the same frame) reads this flag to
  // glide to a wide reveal.
  dropFiredThisFrame = true;
}

// ----- animation loop -----
const clock = new THREE.Clock();
let groundFlow = TERRAIN_ROW_SPACING * 60; // u/s, refined per frame from dt
const ROW_STRIDE_FRONT = (ROWS - 1) * COLS; // newest row offset in heights[]
const rowScratch = new Float32Array(COLS);   // raw FFT row before shaping
let breath = 0;                               // smoothed beat envelope, 0..1

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

  // Front-row write — log-scaled FFT amplitude, shaped into ridges rather
  // than spikes: a 3-tap blur across columns rounds the peaks, a blend with
  // the previous row (now one step back after the shift) lets a transient
  // rise over a few frames instead of appearing fully formed, and a slow
  // broad swell rolls underneath so the floor undulates with the music.
  const baseIdx = ROW_STRIDE_FRONT;
  const prevRow = baseIdx - COLS;
  if (fftBins) {
    for (let ix = 0; ix < COLS; ix++) {
      rowScratch[ix] = Math.pow(sampleLogBin(fftBins, binMap[ix]) / 255, 0.85);
    }
    for (let ix = 0; ix < COLS; ix++) {
      const l = rowScratch[Math.max(0, ix - 1)];
      const r = rowScratch[Math.min(COLS - 1, ix + 1)];
      const shaped = (l + 2 * rowScratch[ix] + r) * 0.25;
      const n = noise3(ix * 0.08, t * 0.35, 0) * NOISE_AMP;
      const swell = (noise3(ix * 0.018, t * 0.12, 7) * 0.5 + 0.5) * TERRAIN_SWELL * dynamics.intensity;
      const target = shaped * HEIGHT_SCALE + n + swell;
      heights[baseIdx + ix] =
        heights[prevRow + ix] + (target - heights[prevRow + ix]) * TERRAIN_ROW_BLEND;
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
    onDrop(t);
  }
  // Mood: anticipation through a build, flash + afterglow at the drop, hush
  // in quiet. Everything below reads these.
  updateMood(mood, dynamics, dropFiredThisFrame, fftBins !== null, dt);

  // global reactivity scalars derived from dynamics — used throughout the
  // remainder of the frame.
  const sinceDrop = (performance.now() - dynamics.dropTime) / 1000;
  const dropBoost = sinceDrop < 1.5 ? Math.exp(-sinceDrop * 2.0) : 0;
  const I = dynamics.intensity;

  // The drop opens the lens for a couple of seconds — the pull-back reveal.
  const targetFov = 55 + mood.afterglow * MOOD_FOV_AFTERGLOW;
  const newFov = camera.fov + (targetFov - camera.fov) * (1 - Math.exp(-5 * dt));
  if (Math.abs(camera.fov - newFov) > 0.001) {
    camera.fov = newFov;
    camera.updateProjectionMatrix();
  }

  // Formation is a build behaviour now: the flock draws together as the
  // anticipation rises and breaks at the drop.
  formation.active = mood.anticipation > 0.5;
  const formationLerp = 1 - Math.exp(-(formation.active ? 1.7 : 1.2) * dt);
  formation.blendIn += ((formation.active ? 1 : 0) - formation.blendIn) * formationLerp;
  formation.blendOut = formation.blendIn; // single state suffices — blend toward target

  // Ground flow: the landscape advances one grid row per frame, so its
  // speed depends on the frame rate. Smooth it so a hitch doesn't make the
  // flock lurch; the ships use it as their cruise airspeed.
  groundFlow += (TERRAIN_ROW_SPACING / Math.max(dt, 1 / 240) - groundFlow) * (1 - Math.exp(-dt / 0.5));
  // Flock size follows musical energy: arrivals surge in from behind,
  // departures peel away. Ships 0..present-1 are the ones in play.
  updateFlock(flock, ships, {
    dt, time: t, level, bassEnergy,
    quiet: dynamics.quiet, intensity: I, hasAudio: fftBins !== null,
  });
  cameraSel.presentShips = flock.present;
  // If the ship we were chasing has left, glide back to a calm shot.
  const chasedIdx = getTrackedShipIdx(cameraSel);
  if (chasedIdx >= 0 && ships[chasedIdx].phase === 'dormant') {
    applyCut(cameraSel, pickCinematicMode(cameraSel, 'calm'), bpmHandle.beatCount);
  }
  // The piloted ship (chase/cockpit) accepts arrow-key steering.
  const trackedShipIdx = getTrackedShipIdx(cameraSel);
  const shipInput = {
    dt, time: t, groundFlow, level, centroid,
    bassEnergy, beatPulse: bpmHandle.beatPulse, arrowKeys,
    anticipation: mood.anticipation,
  };
  // Index order matters: wingmen read the leader's target from this frame.
  ships.forEach((ship, i) =>
    updateShip(ship, i, ships, formation, terrain, shipInput, i === trackedShipIdx),
  );
  trails.update(ships, dt);

  // Music-driven cinematic director — synchronises cuts to drops, builds,
  // quiet sections, and beat cadence. 'V' toggles, 'C' jumps regardless.
  // Visual rhyme: keep the music fingerprint current, then let the director
  // recall a shot if this section has played before.
  updateRhyme(rhyme, { energy: flock.energy, bassEnergy, centroid, intensity: I }, dt);
  runDirector(director, cameraSel, {
    dynamics,
    dropFiredThisFrame,
    beatCount: bpmHandle.beatCount,
    bpm: bpmHandle.bpm,
    time: t,
    rhyme,
  });

  // restore visibility every frame; the active cockpit mode hides its own ship.
  for (const s of ships) s.group.visible = true;

  // Orbit physics (consumed by preset modes); then dispatch on the active mode.
  updateOrbitPhysics(orbit, bassEnergy, dt);
  updateCamera(camera, cameraSel, orbit, cameraRig, ships, {
    bassEnergy,
    intensity: I,
    buildLevel: dynamics.build,
    dt,
    time: t,
    anticipation: mood.anticipation,
    terrainHeightAt: (x, z) => bilerpHeight(terrain, x, z),
  });

  // (sinceDrop and dropBoost computed earlier in this frame, see top of
  // animation loop block above the camera section.)

  // Beat breath: the landscape swells on the kick and settles back, on an
  // attack/release envelope rather than the raw beat pulse (which steps to
  // 1 in a single frame and read as a jolt). Scaled by intensity so it's
  // flat on quiet sections and full-bodied during loud ones.
  const breathRate = bpmHandle.beatPulse > breath ? TERRAIN_BREATH_ATTACK : TERRAIN_BREATH_RELEASE;
  breath += (bpmHandle.beatPulse - breath) * (1 - Math.exp(-breathRate * dt));
  uniforms.uHeightMul.value = 1.0 + breath * TERRAIN_BREATH_AMP * I;
  // aurora: phase sweeps slowly (faster on louder sections). A build
  // withholds it, the drop ignites the sky, the hush puts it out.
  uniforms.uAuroraPhase.value += (0.4 + I * 0.4) * dt;
  uniforms.uAuroraIntensity.value =
    (I * 0.28 + dropBoost * 0.18 + mood.afterglow * 0.35)
    * (1 - mood.anticipation * 0.8) * (1 - mood.hush);
  // A build pulls the fog in; the hush sinks the whole grid toward dark.
  const fogScale = 1 - MOOD_FOG_BUILD * mood.anticipation;
  sceneCore.fog.near = uniforms.uFogNear.value = FOG_NEAR_BASE * fogScale;
  sceneCore.fog.far = uniforms.uFogFar.value = FOG_FAR_BASE * fogScale;
  uniforms.uDim.value = 1 - MOOD_DIM_HUSH * mood.hush;
  // Horizon light: rises and warms with the song's long arc — a sunrise as
  // crescendo — dims in the hush, and flares with the drop.
  sunArc += (flock.energy - sunArc) * (1 - Math.exp(-dt / SUN_ARC_S));
  const elev = (SUN_ELEV_MIN_DEG + (SUN_ELEV_MAX_DEG - SUN_ELEV_MIN_DEG) * sunArc) * Math.PI / 180;
  const azLen = Math.hypot(SUN_AZIMUTH_X, SUN_AZIMUTH_Z);
  uniforms.uLightDir.value.set(
    (SUN_AZIMUTH_X / azLen) * Math.cos(elev),
    Math.sin(elev),
    (SUN_AZIMUTH_Z / azLen) * Math.cos(elev),
  );
  uniforms.uSunColor.value.copy(SUN_EMBER).lerp(SUN_GOLD, sunArc);
  uniforms.uSun.value = (SUN_INTENSITY_MIN + (1 - SUN_INTENSITY_MIN) * sunArc) * (1 - SUN_HUSH_DIM * mood.hush);
  sky.material.uniforms.uFlash.value = mood.flash;
  // The dome rides with the camera so it is never clipped by the far plane
  // and every fragment's direction is exact.
  sky.mesh.position.copy(camera.position);
  for (const ship of ships) {
    applyShipLighting(ship, uniforms.uLightDir.value, uniforms.uSunColor.value, uniforms.uSun.value);
  }
  // Distant range breathes with the song's long arc and dims with the hush.
  mountainEnvelope += (flock.energy - mountainEnvelope) * (1 - Math.exp(-dt / 4));
  // The range drifts past at a fraction of the ground flow — the planes fly
  // +Z into the flow, so the field moves −Z like the ground, just far slower.
  mountainScroll += groundFlow * MOUNTAIN_PARALLAX * (1 + MOUNTAIN_PARALLAX_ENERGY * mountainEnvelope) * dt;
  mountains.update(mountainEnvelope, t, mountainScroll, breath);
  mountains.material.uniforms.uLift.value = 1 - 0.55 * mood.hush;
  // mirror world fades down when the scene is quiet
  mirrorMaterial.uniforms.uOpacity.value = 0.10 * I * (1 - mood.hush);
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

  updatePostFx(pipeline, {
    intensity: I, bassEnergy, dropBoost, stereoEnabled: stereo.enabled,
    anticipation: mood.anticipation, flash: mood.flash, hush: mood.hush,
  });

  // beat-dot pulse: validPeak event sets beatPulse=1; decay each frame.
  bpmHandle.beatPulse *= Math.exp(-9 * dt); // visible for ~150ms after each peak
  updateBpmReadout({ uiEl, bpmNumEl, bpmDotEl, dbgEl }, bpmHandle);
  updateDebugPanel(dbgEl, dynamics, formation, dropBoost, flock, mood, t - rhyme.lastRecallAt < 4);

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

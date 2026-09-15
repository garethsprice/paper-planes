import * as THREE from 'three';
import {
  TERRAIN_ROW_SPACING, TERRAIN_ROW_RATE, CAM_BLEND_MANUAL_S,
  TERRAIN_BREATH_ATTACK, TERRAIN_BREATH_RELEASE, TERRAIN_BREATH_AMP,
  MOOD_FOG_BUILD, MOOD_DIM_HUSH, MOOD_FOV_AFTERGLOW, MOOD_SCATTER_X,
  MOUNTAIN_PARALLAX, MOUNTAIN_PARALLAX_ENERGY,
  SPARK_BEAT_BASE, SPARK_BEAT_PER_I, SPARK_DROP_BURST,
  SUN_AZIMUTH_X, SUN_AZIMUTH_Z, SUN_ELEV_MIN_DEG, SUN_ELEV_MAX_DEG, SUN_ARC_S,
  SUN_INTENSITY_MIN, SUN_HUSH_DIM,
} from './constants.ts';
import { createStereoState } from './render/stereo.ts';
import { createRenderPipeline, updatePostFx, renderFrame, resizePipeline } from './render/pipeline.ts';
import { createSimulationClock, SIMULATION_STEP } from './render/simulation.ts';
import { createFrameMetrics, createGpuTimer, updateQuality, QUALITY_LEVELS } from './render/quality.ts';
import { loadPreferences, savePreferences } from './ui/preferences.ts';
import { createBeatClock, updateBeatClock, presentationTime } from './audio/beatClock.ts';
import { createTrackAnalysis } from './audio/track.ts';
import { upcomingCue } from './audio/trackFeatures.ts';
import { parseLrc, lyricAt, type LyricLine } from './audio/lrc.ts';
import { createDemoFile } from './audio/demo.ts';
import { installXr } from './xr/session.ts';
import { arrowKeys, installKeyHandlers } from './input/keys.ts';
import {
  installInteractionTracking, updateUiVisibility, updateBpmReadout, updateDebugPanel,
} from './ui/status.ts';
import { dom } from './ui/dom.ts';
import { createFrame } from './frame.ts';
import { createSceneCore } from './scene/core.ts';
import { createTerrain, bilerpHeight, updateEnvelope, setFlowOffset, shiftTerrainRows } from './scene/terrain.ts';
import { createStars } from './scene/stars.ts';
import { createNebula } from './scene/nebula.ts';
import { createShips, updateShip, scatterShip, separateShips, type ShipUpdateInput } from './scene/ship.ts';
import { createShipRenderer } from './scene/shipRender.ts';
import { createSky } from './scene/sky.ts';
import { createSparks } from './scene/sparks.ts';
import { createMood, updateMood } from './scene/mood.ts';
import { createMountains } from './scene/mountains.ts';
import { createTrails } from './scene/trails.ts';
import { createLandscape, writeLandscapeRow } from './scene/landscape.ts';
import { createLyrics } from './audio/lyrics.ts';
import { createBanner, dismissInvite, revealInvite } from './ui/banner.ts';
import { createDebugPanel } from './ui/debugPanel.ts';
import { lyricsSettings } from './audio/lyrics.ts';
import { createFlock, updateFlock, type FlockInput } from './scene/flock.ts';
import {
  ensureAudio, getAudio, attachStream, loadAudioFile, disconnectCurrent,
  type AudioState,
} from './audio/sources.ts';
import { createBpmHandle, resetBpm } from './audio/bpm.ts';
import { createDynamics, updateDynamics, decayDynamics, releaseDynamics } from './audio/dynamics.ts';
import { extractAudio, type AudioSnapshot } from './audio/analyser.ts';
import {
  createCameraSelection, applyCut, trackedShipIdx as getTrackedShipIdx,
  nextAvailableMode, pickCinematicMode,
} from './camera/modes.ts';
import { createOrbit, attachOrbitInput, updateOrbitPhysics } from './camera/orbit.ts';
import { createDirector, runDirector, bumpPilotControl } from './camera/director.ts';
import { createRhyme, updateRhyme } from './camera/rhyme.ts';
import { updateCamera, createCameraRig, type CameraUpdateInput } from './camera/update.ts';

const preferences = loadPreferences();
const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const { canvas, fileInput, playBtn, micBtn, tabBtn, stereoBtn, uiEl, statusEl, bpmNumEl, bpmDotEl, dbgEl, lyricsBtn, debugBtn } = dom;

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
const gpuTimer = createGpuTimer(renderer.getContext() as WebGL2RenderingContext);
const timing = createFrameMetrics();
const simulation = createSimulationClock();

// ----- terrain (line-grid spectrogram) + mirror reflection + scene props -----
const terrain = createTerrain(sceneCore);
const { posAttr, heights, mirrorMaterial } = terrain;
const stars = createStars(scene);
const nebula = createNebula(scene);
const mountains = createMountains(scene, terrain.noise3, uniforms);
const sky = createSky(scene, uniforms);
const sparks = createSparks(scene, terrain);
const landscape = createLandscape();

// ----- lyrics: words from the mic, shown only at frisson moments -----
// Accepted phrases wait in `pendingLyric`; a drop, a peaking build or a
// rhyme recall releases the freshest one to the sky. If a phrase arrives
// while the scene is already in such a moment it shows at once.
const banner = createBanner();
revealInvite();
let sceneTime = 0; // mirrors the loop's `t` for handlers outside it
let pendingLyric: { text: string; at: number } | null = null;
let lastBannerAt = -Infinity;
function inFrissonWindow(): boolean {
  return mood.afterglow > 0.25 || mood.anticipation > 0.55 || sceneTime - rhyme.lastRecallAt < 3;
}
let lyricNote = '';
/** Show the pending phrase if a moment allows (or `force` on an event). A
 *  phrase that has waited fallbackS with the music still up shows anyway —
 *  moments are preferred, not required. Expiry (freshS) is checked only when
 *  the phrase can't be shown this frame, so freshS == fallbackS still lets
 *  the fallback fire on the boundary frame instead of expiring it. */
function tryShowLyric(force: boolean): void {
  if (!pendingLyric) { lyricNote = ''; return; }
  const age = sceneTime - pendingLyric.at;
  const expire = (): void => { pendingLyric = null; lyricNote = 'last phrase expired unshown'; };
  const sinceBanner = sceneTime - lastBannerAt;
  if (sinceBanner < lyricsSettings.minIntervalS) {
    if (age > lyricsSettings.freshS) { expire(); return; }
    lyricNote = `pending "${pendingLyric.text}" · gap ${(lyricsSettings.minIntervalS - sinceBanner).toFixed(0)}s`;
    return;
  }
  const fallback = age >= lyricsSettings.fallbackS && flock.energy >= lyricsSettings.fallbackEnergy && mood.hush < 0.5;
  if (!force && !inFrissonWindow() && !fallback) {
    if (age > lyricsSettings.freshS) { expire(); return; }
    lyricNote = `pending "${pendingLyric.text}" · waiting for a moment (${(lyricsSettings.fallbackS - age).toFixed(0)}s, energy ${flock.energy.toFixed(2)})`;
    return;
  }
  banner.show(pendingLyric.text);
  lastBannerAt = sceneTime;
  lyricNote = `shown "${pendingLyric.text}"`;
  pendingLyric = null;
}
const lyrics = createLyrics((text) => {
  if (getAudio()?.kind !== 'mic' || !lyrics.enabled) return;
  pendingLyric = { text, at: sceneTime };
  tryShowLyric(false);
});
const debugPanel = createDebugPanel((text) => banner.show(text));
function setLyricsEnabled(on: boolean): void {
  if (!lyrics.supported) { statusEl.textContent = 'lyrics: speech recognition unavailable'; return; }
  lyrics.enabled = on;
  if (on && getAudio()?.kind === 'mic') lyrics.start(); else lyrics.stop();
  if (!on) { pendingLyric = null; if (getAudio()?.kind === 'mic') banner.clear(); }
  lyricsBtn.classList.toggle('on', on);
  lyricsBtn.textContent = on ? 'Mic lyrics on' : 'Mic lyrics off';
  lyricsBtn.setAttribute('aria-pressed', String(on));
  statusEl.textContent = `lyrics ${on ? 'on' : 'off'}`;
}
lyricsBtn.classList.toggle('on', lyrics.enabled && lyrics.supported);
lyricsBtn.textContent = lyrics.supported ? 'Mic lyrics off' : 'Mic lyrics unavailable';
lyricsBtn.disabled = !lyrics.supported;
lyricsBtn.addEventListener('click', () => setLyricsEnabled(!lyrics.enabled));
debugBtn.addEventListener('click', () => debugPanel.toggle());

let lastAnticipation = 0;
let lastHush = 0;
let sunArc = 0.3; // very slow long-term energy: drives the light's elevation and warmth
const SUN_EMBER = new THREE.Color(0.95, 0.28, 0.08);
const SUN_GOLD = new THREE.Color(1.0, 0.8, 0.5);
const mood = createMood();
let mountainEnvelope = 0.5; // slow-smoothed flock energy that raises the range
let mountainScroll = 0;     // world-Z offset of the range's height field (parallax)
const FOG_NEAR_BASE = sceneCore.fog.near;
const FOG_FAR_BASE = sceneCore.fog.far;

// ----- ships + formation flight (factories live in src/scene/ship.ts) -----
const shipsHandle = createShips();
const shipRenderer = createShipRenderer(scene, uniforms);
const ships = shipsHandle.list;
const formation = shipsHandle.formation;
const flock = createFlock();
const trails = createTrails(scene);


// ----- audio plumbing -----
// Per-frame mutable context — extractAudio / updateDynamics / updateShip
// each read what they need and write whatever they own.
const frame = createFrame();
const bpmHandle = createBpmHandle();
const dynamics = createDynamics();
const beatClock = createBeatClock();
const bpmReadout = { bpm: 0, bpmCandidate: 0, beatPulse: 0 };
const trackAnalysis = createTrackAnalysis();
let lyricLines: LyricLine[] = [];
let shownLyricIndex = -1;
let previousTrackTime = 0;
let sourceRequest = 0;
const onsetTimes: number[] = [];
let audioSnap: AudioSnapshot = { fftBins: null, peakLevel: 0, onset: false, rms: 0 };
let audioTime = 0;
let bassEnergy = 0;     // populated each frame from extractAudio (kept for orbit camera bass impulse)

let audioEventsInstalled = false;
function audio(): AudioState {
  const a = ensureAudio();
  if (!audioEventsInstalled) {
    audioEventsInstalled = true;
    a.audioEl.addEventListener('play', () => { resetMusic(); playBtn.textContent = 'Pause'; });
    a.audioEl.addEventListener('pause', () => { playBtn.textContent = 'Play'; });
    a.audioEl.addEventListener('ended', () => { playBtn.textContent = 'Play'; banner.clear(); });
    a.audioEl.addEventListener('seeked', () => { resetMusic(); previousTrackTime = a.audioEl.currentTime; });
    a.audioEl.addEventListener('error', () => { statusEl.textContent = 'This track could not be played. Try another audio file.'; });
  }
  return a;
}

function resetMusic(): void {
  Object.assign(dynamics, createDynamics());
  Object.assign(beatClock, createBeatClock());
  Object.assign(rhyme, createRhyme());
  Object.assign(mood, createMood());
  onsetTimes.length = 0;
  getAudio()?.features.reset();
  lastSeenDropCount = 0;
  pendingLyric = null;
  shownLyricIndex = -1;
  director.reservedUntil = director.holdUntil = 0;
  director.scheduledCue = -Infinity;
  director.prevBuild = 0;
  director.prevQuiet = true;
  cameraSel.beatsAtChange = 0;
  cameraSel.modeChangedAt = performance.now();
  flock.runMax = 0.65;
  previousTrackTime = getAudio()?.audioEl.currentTime ?? 0;
  banner.clear();
}

function refreshSourceUi(): void {
  const a = getAudio();
  const file = a?.kind === 'file';
  playBtn.disabled = !file;
  element<HTMLButtonElement>('stop').disabled = !a?.currentSourceNode;
  element('transport').hidden = !file;
  element<HTMLButtonElement>('load-lrc').disabled = !file;
  element<HTMLButtonElement>('clear-lrc').disabled = lyricLines.length === 0;
  micBtn.classList.toggle('on', a?.kind === 'mic');
  tabBtn.classList.toggle('on', a?.kind === 'tab');
}

function stopSource(): void {
  sourceRequest++;
  const a = getAudio();
  if (a) { a.audioEl.pause(); disconnectCurrent(a, bpmHandle); resetBpm(bpmHandle); }
  lyrics.stop(); trackAnalysis.cancel(); lyricLines = [];
  resetMusic(); refreshSourceUi();
  statusEl.textContent = 'Stopped · choose your next track';
  revealInvite();
}

function loadFile(f: File): void {
  const request = ++sourceRequest;
  const a = audio();
  lyrics.stop(); lyricLines = [];
  loadAudioFile(a, bpmHandle, f);
  resetMusic(); refreshSourceUi();
  void trackAnalysis.load(f);
  playBtn.textContent = 'Play';
  statusEl.textContent = f.name;
  dismissInvite();
  // Both file picking and dropping are explicit playback gestures.
  void a.ctx.resume().then(() => {
    if (request === sourceRequest && a.kind === 'file') return a.audioEl.play();
  }).catch(() => {
    if (request === sourceRequest) statusEl.textContent = f.name + ' · press Play to begin';
  });
}
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0]; if (f) loadFile(f); fileInput.value = '';
});
element('load').addEventListener('click', () => fileInput.click());
element('stop').addEventListener('click', stopSource);
element('demo').addEventListener('click', () => loadFile(createDemoFile()));
document.addEventListener('dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
document.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer?.files?.[0];
  if (f && (f.type.startsWith('audio/') || /\.(mp3|wav|ogg|flac|m4a|aac)$/i.test(f.name))) loadFile(f);
  else if (f) statusEl.textContent = 'Please choose an audio file';
});
playBtn.addEventListener('click', async () => {
  const a = audio(); if (a.kind !== 'file') return;
  try {
    if (a.audioEl.paused) { await a.ctx.resume(); await a.audioEl.play(); }
    else { a.audioEl.pause(); banner.clear(); }
  } catch { statusEl.textContent = 'Playback could not start. Try loading the track again.'; }
});

async function capture(kind: 'mic' | 'tab'): Promise<void> {
  const request = ++sourceRequest;
  try {
    const a = audio();
    await a.ctx.resume();
    const stream = kind === 'mic'
      ? await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } })
      : await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    if (request !== sourceRequest) { stream.getTracks().forEach(t => t.stop()); return; }
    stream.getVideoTracks().forEach(t => t.stop());
    if (!stream.getAudioTracks().length) {
      stream.getTracks().forEach(t => t.stop());
      statusEl.textContent = 'Select “Share tab audio” in the sharing window'; return;
    }
    lyrics.stop(); trackAnalysis.cancel(); lyricLines = [];
    attachStream(a, bpmHandle, stream, kind);
    stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (a.micStream === stream) stopSource(); }));
    resetMusic(); refreshSourceUi(); dismissInvite();
    statusEl.textContent = kind === 'mic' ? 'Microphone live' : 'Listening to tab audio';
    if (kind === 'mic' && lyrics.enabled) lyrics.start();
  } catch (error) {
    if (request === sourceRequest) statusEl.textContent = `Audio capture unavailable: ${(error as Error).message}`;
  }
}
micBtn.addEventListener('click', () => { void capture('mic'); });
tabBtn.addEventListener('click', () => { void capture('tab'); });
document.querySelectorAll<HTMLButtonElement>('[data-source]').forEach(button => button.addEventListener('click', () => {
  const action = button.dataset.source;
  if (action === 'file') fileInput.click();
  else if (action === 'demo') element<HTMLButtonElement>('demo').click();
  else if (action === 'mic' || action === 'tab') void capture(action);
}));
element('load-lrc').addEventListener('click', () => element<HTMLInputElement>('lrc').click());
element('clear-lrc').addEventListener('click', () => { lyricLines = []; shownLyricIndex = -1; banner.clear(); refreshSourceUi(); });
element('lrc').addEventListener('change', async () => {
  const input = element<HTMLInputElement>('lrc');
  const file = input.files?.[0]; input.value = '';
  const generation = getAudio()?.generation;
  if (!file || file.size > 1024 * 1024) { statusEl.textContent = 'Choose a lyric file smaller than 1 MB'; return; }
  try {
    const lines = parseLrc(await file.text());
    if (getAudio()?.kind !== 'file' || generation !== getAudio()?.generation) return;
    lyricLines = lines; shownLyricIndex = -1; banner.clear(); refreshSourceUi();
    statusEl.textContent = lines.length ? `Lyrics loaded · ${file.name}` : 'No timed lyrics found in this file';
  } catch { statusEl.textContent = 'The lyric file could not be read'; }
});
element('seek').addEventListener('input', () => {
  const a = getAudio(); if (a?.kind === 'file' && Number.isFinite(a.audioEl.duration)) a.audioEl.currentTime = Number(element<HTMLInputElement>('seek').value);
});

// ----- mouse orbit (subtle spring physics, used by preset modes) -----
const orbit = createOrbit();
attachOrbitInput(orbit, canvas);

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
  resetBpm: () => { resetBpm(bpmHandle); Object.assign(beatClock, createBeatClock()); onsetTimes.length = 0; statusEl.textContent = 'bpm reset'; },
  toggleNebula: () => {
    nebula.visible = !nebula.visible;
    statusEl.textContent = `nebula ${nebula.visible ? 'on' : 'off'}`;
  },
  cycleCamera: () => {
    applyCut(cameraSel, nextAvailableMode(cameraSel), bpmHandle.beatCount, CAM_BLEND_MANUAL_S);
    director.pilotActiveUntil = performance.now() + 12000;
    statusEl.textContent = `cam: ${cameraSel.modes[cameraSel.currentIdx].label}`;
  },
  toggleCinematic: toggleAutomaticCamera,
  toggleStereo: () => setStereo(!stereo.enabled),
  toggleLyrics: () => setLyricsEnabled(!lyrics.enabled),
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
const rowRate = TERRAIN_ROW_RATE;
const groundFlow = TERRAIN_ROW_SPACING * rowRate;
let rowAcc = 0;
let breath = 0; // smoothed beat envelope, 0..1

// Per-frame input records, allocated once and rewritten each frame so the
// loop creates no garbage for the collector to pause on.
const flockInput: FlockInput = {
  dt: 0, time: 0, level: 0, bassEnergy: 0, quiet: true, intensity: 0, hasAudio: false, anticipation: 0, release: 0,
};
const shipInput: ShipUpdateInput = {
  dt: 0, time: 0, groundFlow, level: 0, centroid: 0.5,
  bassEnergy: 0, beatPulse: 0, arrowKeys, anticipation: 0,
};
const cameraInput: CameraUpdateInput = {
  bassEnergy: 0, intensity: 0, buildLevel: 0, dt: 0, time: 0, anticipation: 0, motion: preferences.motion,
  terrainHeightAt: (x, z) => bilerpHeight(terrain, x, z),
};
const SUN_AZIMUTH_LEN = Math.hypot(SUN_AZIMUTH_X, SUN_AZIMUTH_Z);

const previousCameraPosition = camera.position.clone();
const previousCameraQuaternion = camera.quaternion.clone();
const currentCameraPosition = camera.position.clone();
const currentCameraQuaternion = camera.quaternion.clone();
let previousFov = camera.fov;
function simulate(dt: number, t: number): void {
  previousCameraPosition.copy(camera.position);
  previousCameraQuaternion.copy(camera.quaternion);
  previousFov = camera.fov;
  sceneTime = t;
  uniforms.uTime.value = t;
  // Advance the flow: shift heights[] toward iy=0 (away from camera) by the
  // whole rows due this frame; slide the grid by the remaining fraction.
  rowAcc += dt * rowRate;
  const shifts = Math.floor(rowAcc + 1e-9);
  rowAcc -= shifts;
  shiftTerrainRows(terrain, shifts);
  setFlowOffset(terrain, rowAcc);
  const flowStep = groundFlow * dt; // u the landscape travelled −Z this frame

  // Audio: pull a fresh FFT and derive bass / level / centroid into the frame.
  const audioState = getAudio();

  bassEnergy = frame.bassEnergy;
  const level = frame.level;
  const centroid = frame.centroid;
  const fftBins = audioSnap.fftBins;

  let onset = false;
  while (onsetTimes.length && onsetTimes[0] <= audioTime) { onsetTimes.shift(); onset = true; }
  const beatEdge = fftBins ? updateBeatClock(beatClock, audioTime, onset, bpmHandle.bpmCandidate || bpmHandle.bpm, dt) : false;
  if (!fftBins) beatClock.pulse *= Math.exp(-9 * dt);
  bpmHandle.beatPulse = beatClock.pulse;
  bpmHandle.beatCount = beatClock.count;
  const trackTime = audioState?.kind === 'file'
    ? Math.max(0, audioState.audioEl.currentTime - (audioState.ctx.currentTime - audioTime)) : 0;
  const cue = fftBins && audioState?.kind === 'file' ? upcomingCue(trackAnalysis.cues, trackTime) : undefined;
  const forecast = cue ? Math.max(0, 1 - (cue.time - trackTime) / 8) * cue.confidence : 0;
  // A known file cue owns its lead-in; individual attacks cannot spend that reveal early.
  if (fftBins) updateDynamics(dynamics, audioSnap.peakLevel, dt, cue ? false : onset, forecast);
  else decayDynamics(dynamics, dt);
  if (fftBins && audioState?.kind === 'file' && trackTime >= previousTrackTime && trackTime - previousTrackTime < 0.5) {
    const arrived = trackAnalysis.cues.find(c => c.confidence >= 0.65 && c.time > previousTrackTime && c.time <= trackTime);
    if (arrived && dynamics.age * 1000 - dynamics.dropTime > 8000) releaseDynamics(dynamics, dynamics.age, arrived.confidence);
  }
  previousTrackTime = trackTime;
  if (fftBins && lyricLines.length && audioState?.kind === 'file') {
    const index = lyricAt(lyricLines, trackTime);
    if (index !== shownLyricIndex) {
      shownLyricIndex = index;
      if (index >= 0 && trackTime - lyricLines[index].time < 8) banner.show(lyricLines[index].text);
      else banner.clear();
    }
  }

  // Front-row write — see scene/landscape.ts: folded spectrogram blended
  // with a band-driven synthesised landscape over a slow geology, meandering.
  writeLandscapeRow(landscape, terrain, heights, {
    fftBins, dt, time: t, intensity: dynamics.intensity, centroid, sampleRate: audioState?.ctx.sampleRate ?? 44100,
  }, shifts);

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
  const sinceDrop = (dynamics.age * 1000 - dynamics.dropTime) / 1000;
  const dropBoost = sinceDrop < 1.5 ? Math.exp(-sinceDrop * 2.0) : 0;
  const I = dynamics.intensity;

  const breathRate = bpmHandle.beatPulse > breath ? TERRAIN_BREATH_ATTACK : TERRAIN_BREATH_RELEASE;
  breath += (bpmHandle.beatPulse - breath) * (1 - Math.exp(-breathRate * dt));
  uniforms.uHeightMul.value = 1.0 + breath * TERRAIN_BREATH_AMP * I;

  // Sparks off the crests: a few on every beat, scaled by intensity, a
  // burst on the drop, none in the hush. Vigour (launch spread and size)
  // follows intensity so a heavy section throws them higher and wider.
  sparks.update(t, groundFlow);
  if (fftBins && !dynamics.quiet) {

    const vigour = Math.min(1.5, I);
    if (beatEdge) {
      const count = Math.round((SPARK_BEAT_BASE + SPARK_BEAT_PER_I * I) * (1 - mood.hush));
      sparks.emit(count, t, uniforms.uSunColor.value, vigour);
    }
    if (dropFiredThisFrame) sparks.emit(SPARK_DROP_BURST, t, uniforms.uSunColor.value, 1.5);
  }

  // A drop, a peaking build, or the light returning after a hush releases a
  // waiting lyric to the sky; otherwise the fallback timer decides.
  const lightReturns = mood.hush < 0.5 && lastHush >= 0.5;
  if (dropFiredThisFrame || (mood.anticipation > 0.55 && lastAnticipation <= 0.55) || lightReturns) tryShowLyric(true);
  else tryShowLyric(false);
  lastAnticipation = mood.anticipation;
  lastHush = mood.hush;

  // The drop opens the lens for a couple of seconds — the pull-back reveal.
  const targetFov = 55 + mood.afterglow * MOOD_FOV_AFTERGLOW * preferences.motion;
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

  // Flock size follows musical energy: arrivals surge in from behind,
  // departures peel away. Ships 0..present-1 are the ones in play.
  flockInput.dt = dt; flockInput.time = t; flockInput.level = level;
  flockInput.bassEnergy = bassEnergy; flockInput.quiet = dynamics.quiet;
  flockInput.intensity = I; flockInput.hasAudio = fftBins !== null;
  flockInput.anticipation = mood.anticipation; flockInput.release = mood.afterglow;
  updateFlock(flock, ships, flockInput);
  cameraSel.presentShips = flock.present;
  for (let i = 0; i < cameraSel.availableShips.length; i++) cameraSel.availableShips[i] = ships[i].phase !== 'dormant';
  // If the ship we were chasing has left, glide back to a calm shot.
  const chasedIdx = getTrackedShipIdx(cameraSel);
  if (chasedIdx >= 0 && ships[chasedIdx].phase === 'dormant') {
    applyCut(cameraSel, pickCinematicMode(cameraSel, 'calm'), bpmHandle.beatCount);
  }
  // The piloted ship (chase/cockpit) accepts arrow-key steering.
  const trackedShipIdx = getTrackedShipIdx(cameraSel);
  shipInput.dt = dt; shipInput.time = t; shipInput.groundFlow = groundFlow;
  shipInput.level = level; shipInput.centroid = centroid; shipInput.bassEnergy = bassEnergy;
  shipInput.beatPulse = bpmHandle.beatPulse; shipInput.anticipation = mood.anticipation;
  // Index order matters: wingmen read the leader's target from this frame.
  updateEnvelope(terrain);
  separateShips(ships);
  for (let i = 0; i < ships.length; i++) {
    updateShip(ships[i], i, ships, formation, terrain, shipInput, i === trackedShipIdx);
  }
  trails.update(ships, flowStep, dt);

  // Music-driven cinematic director — synchronises cuts to drops, builds,
  // quiet sections, and beat cadence. 'V' toggles, 'C' jumps regardless.
  // Visual rhyme: keep the music fingerprint current, then let the director
  // recall a shot if this section has played before.
  updateRhyme(rhyme, { energy: flock.energy, bassEnergy, centroid, intensity: I }, dt);
  runDirector(director, cameraSel, {
    dynamics,
    dropFiredThisFrame,
    beatCount: bpmHandle.beatCount,
    bpm: beatClock.confidence >= 0.55 ? beatClock.bpm : 0,
    beatConfidence: beatClock.confidence, beatEdge,
    upcomingDropIn: cue ? cue.time - trackTime : Infinity,
    upcomingCueAt: cue?.time ?? -Infinity, motion: preferences.motion,
    time: t,
    rhyme,
  });

  // restore visibility every frame; the active cockpit mode hides its own ship.
  for (const s of ships) s.group.visible = true;

  // Orbit physics (consumed by preset modes); then dispatch on the active mode.
  updateOrbitPhysics(orbit, bassEnergy * preferences.motion, dt);
  cameraInput.bassEnergy = bassEnergy; cameraInput.intensity = I;
  cameraInput.buildLevel = dynamics.build; cameraInput.dt = dt; cameraInput.time = t;
  cameraInput.anticipation = mood.anticipation; cameraInput.motion = preferences.motion;
  updateCamera(camera, cameraSel, orbit, cameraRig, ships, cameraInput);

  // (sinceDrop and dropBoost computed earlier in this frame, see top of
  // animation loop block above the camera section.)

  // Beat breath: the landscape swells on the kick and settles back, on an
  // attack/release envelope rather than the raw beat pulse (which steps to
  // 1 in a single frame and read as a jolt). Scaled by intensity so it's
  // flat on quiet sections and full-bodied during loud ones.
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
  uniforms.uLightDir.value.set(
    (SUN_AZIMUTH_X / SUN_AZIMUTH_LEN) * Math.cos(elev),
    Math.sin(elev),
    (SUN_AZIMUTH_Z / SUN_AZIMUTH_LEN) * Math.cos(elev),
  );
  uniforms.uSunColor.value.copy(SUN_EMBER).lerp(SUN_GOLD, sunArc);
  uniforms.uSun.value = (SUN_INTENSITY_MIN + (1 - SUN_INTENSITY_MIN) * sunArc) * (1 - SUN_HUSH_DIM * mood.hush);
  sky.material.uniforms.uFlash.value = mood.flash * preferences.flash;
  // The dome rides with the camera so it is never clipped by the far plane
  // and every fragment's direction is exact.
  sky.mesh.position.copy(camera.position);
  // Distant range breathes with the song's long arc and dims with the hush.
  mountainEnvelope += (flock.energy - mountainEnvelope) * (1 - Math.exp(-dt / 4));
  // The range drifts past at a fraction of the ground flow — the planes fly
  // +Z into the flow, so the field moves −Z like the ground, just far slower.
  mountainScroll += groundFlow * MOUNTAIN_PARALLAX * (1 + MOUNTAIN_PARALLAX_ENERGY * mountainEnvelope) * dt;
  mountains.update(mountainEnvelope, t, mountainScroll, breath);
  mountains.material.uniforms.uLift.value = 1 - 0.55 * mood.hush;
  // mirror world fades down when the scene is quiet
  mirrorMaterial.uniforms.uOpacity.value = 0.055 * I * (1 - mood.hush);
  // very subtle star parallax (independent of intensity — the cosmos doesn't
  // pause). Rates are per second (the old per-frame values at 60 fps).
  stars.rotation.y += 0.018 * dt;
  // nebula swirls a bit faster on bass; intensity scales the speed-up
  nebula.rotation.y += (0.048 + bassEnergy * 0.24 * I) * dt;
  (nebula.material as THREE.PointsMaterial).color.setRGB(
    0.45 + centroid * 0.55,
    0.55 + 0.10 * (1 - centroid),
    0.95 - centroid * 0.30,
  );

  const uiIdle = updateUiVisibility(uiEl, interaction);
  // hue: BPM offset + slow time cycle, attenuated by intensity
  const tempoForHue = bpmHandle.bpm > 0 ? bpmHandle.bpm : 120;
  const bpmHue = Math.max(-0.05, Math.min(0.05, (tempoForHue - 120) / 60 * 0.05));
  uniforms.uHueShift.value = (bpmHue + Math.sin(t * 0.07) * 0.04) * (0.4 + 0.6 * I);

  updatePostFx(pipeline, {
    intensity: I, bassEnergy, dropBoost, stereoEnabled: stereo.enabled,
    anticipation: mood.anticipation, flash: mood.flash, hush: mood.hush, flashIntensity: preferences.flash,
  });

  // beat-dot pulse: validPeak event sets beatPulse=1; decay each frame.
  // The audio clock owns beat decay. // visible for ~150ms after each peak
  // The strip's readouts are DOM writes; skip them while it is hidden.
  if (!uiIdle) {
    bpmReadout.bpm = beatClock.confidence >= 0.55 ? beatClock.bpm : 0;
    bpmReadout.bpmCandidate = bpmHandle.bpmCandidate;
    bpmReadout.beatPulse = beatClock.pulse;
    updateBpmReadout({ uiEl, bpmNumEl, bpmDotEl, dbgEl }, bpmReadout);
    if (!dbgEl.hidden) updateDebugPanel(dbgEl, dynamics, formation, dropBoost, flock, mood, t - rhyme.lastRecallAt < 4, timing);
  }
  debugPanel.update(lyrics, lyricNote);

}
let lastFrameAt: number | null = null;
let lastDpr = window.devicePixelRatio;
let lastUiAt = 0;
function animate(): void {
  if (document.hidden && !renderer.xr.isPresenting) { lastFrameAt = null; return; }
  const started = performance.now();
  const elapsed = lastFrameAt === null ? SIMULATION_STEP : (started - lastFrameAt) / 1000;
  if (lastFrameAt === null) { simulation.reset(); resetMusic(); }
  lastFrameAt = started;
  const a = getAudio();
  audioSnap = extractAudio(a, frame);
  audioTime = a ? presentationTime(a.ctx, a.kind === 'file', preferences.syncMs) : sceneTime;
  if (audioSnap.onset && a) onsetTimes.push(a.ctx.currentTime);
  const alpha = simulation.advance(elapsed, simulate);
  currentCameraPosition.copy(camera.position); currentCameraQuaternion.copy(camera.quaternion);
  const currentFov = camera.fov;
  if (!renderer.xr.isPresenting) {
    camera.position.lerpVectors(previousCameraPosition, currentCameraPosition, alpha);
    camera.quaternion.slerpQuaternions(previousCameraQuaternion, currentCameraQuaternion, alpha);
    camera.fov = previousFov + (currentFov - previousFov) * alpha;
    camera.updateProjectionMatrix();
  }
  const visualTime = Math.max(0, sceneTime - SIMULATION_STEP + alpha * SIMULATION_STEP);
  uniforms.uTime.value = visualTime;
  setFlowOffset(terrain, rowAcc - (1 - alpha) * rowRate * SIMULATION_STEP);
  trails.lines.position.z = (1 - alpha) * groundFlow * SIMULATION_STEP;
  sky.mesh.position.copy(camera.position);
  shipRenderer.update(ships, uniforms, alpha);
  sparks.update(visualTime, groundFlow);
  const quality = QUALITY_LEVELS[pipeline.quality.level];
  uniforms.uDetail.value = quality.detail;
  terrain.mirror.visible = quality.reflection;
  const gpuMs = gpuTimer.poll();
  if (gpuMs !== null) timing.gpuMs = gpuMs;
  gpuTimer.begin();
  renderFrame(pipeline, scene, camera, elapsed);
  gpuTimer.end();
  camera.position.copy(currentCameraPosition); camera.quaternion.copy(currentCameraQuaternion);
  camera.fov = currentFov;
  setFlowOffset(terrain, rowAcc);
  timing.sample(performance.now() - started, elapsed * 1000, started);
  if (!renderer.xr.isPresenting) {
    const changed = preferences.quality === 'auto' && updateQuality(pipeline.quality,
      timing.frameMs, Math.max(timing.cpuMs, timing.gpuMs ?? 0), elapsed);
    if (changed || lastDpr !== window.devicePixelRatio) {
      lastDpr = window.devicePixelRatio;
      resizePipeline(pipeline, window.innerWidth, window.innerHeight);
    }
  }
  if (started - lastUiAt > 200) {
    lastUiAt = started;
    syncControls();
    if (a?.kind === 'file') {
      const duration = Number.isFinite(a.audioEl.duration) ? a.audioEl.duration : 0;
      const seek = element<HTMLInputElement>('seek');
      seek.max = String(duration);
      if (document.activeElement !== seek) seek.value = String(a.audioEl.currentTime);
      element('elapsed').textContent = formatTime(a.audioEl.currentTime);
      element('duration').textContent = formatTime(duration);
    }
  }
}
renderer.setAnimationLoop(animate);

function setStereo(on: boolean) {
  stereo.enabled = on;
  stereoBtn.classList.toggle('on', on);
  stereoBtn.setAttribute('aria-pressed', String(on));
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
  if (!renderer.xr.isPresenting) resizePipeline(pipeline, w, h);
});

function formatTime(seconds: number): string {
  return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}
const cameraControl = element<HTMLSelectElement>('camera');
for (let i = 0; i < cameraSel.modes.length; i++) {
  if (i === cameraSel.vrObserverIdx) continue;
  const option = document.createElement('option'); option.value = String(i); option.textContent = cameraSel.modes[i].label;
  cameraControl.appendChild(option);
}
cameraControl.addEventListener('change', () => {
  applyCut(cameraSel, Number(cameraControl.value), bpmHandle.beatCount, CAM_BLEND_MANUAL_S);
  director.pilotActiveUntil = performance.now() + 12000;
});
function toggleAutomaticCamera(): void {
  if (preferences.motion < 0.05) {
    preferences.motion = 0.35;
    element<HTMLInputElement>('motion').value = '0.35';
    savePreferences(preferences);
    director.cinematicAuto = true;
  } else director.cinematicAuto = !director.cinematicAuto;
  director.reservedUntil = director.holdUntil = 0;
  cameraSel.modeChangedAt = performance.now(); cameraSel.beatsAtChange = bpmHandle.beatCount;
  syncControls();
}
element('director').addEventListener('click', toggleAutomaticCamera);
element('fullscreen').addEventListener('click', () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen().catch(() => { statusEl.textContent = 'Fullscreen is unavailable in this browser'; });
});
for (const key of ['motion', 'flash', 'sync'] as const) {
  const input = element<HTMLInputElement>(key);
  input.value = String(key === 'sync' ? preferences.syncMs : preferences[key]);
  input.addEventListener('input', () => {
    if (key === 'sync') preferences.syncMs = Number(input.value);
    else preferences[key] = Number(input.value);
    savePreferences(preferences); syncControls();
  });
}
const qualityControl = element<HTMLSelectElement>('quality');
qualityControl.value = preferences.quality;
function applyQualityChoice() {
  pipeline.quality.level = preferences.quality === 'low' ? 3 : 0;
  pipeline.quality.slowFor = pipeline.quality.fastFor = 0;
  pipeline.quality.cooldown = 3;
  if (!renderer.xr.isPresenting) resizePipeline(pipeline, window.innerWidth, window.innerHeight);
}
qualityControl.addEventListener('change', () => {
  preferences.quality = qualityControl.value as typeof preferences.quality;
  savePreferences(preferences); applyQualityChoice();
});
element('diagnostics').addEventListener('change', () => { dbgEl.hidden = !element<HTMLInputElement>('diagnostics').checked; });
function syncControls() {
  if (element<HTMLDetailsElement>('settings').open) uiEl.style.setProperty('--ui-bottom', `${uiEl.getBoundingClientRect().bottom}px`);
  cameraControl.value = String(cameraSel.currentIdx);
  for (const option of cameraControl.options) {
    const mode = cameraSel.modes[Number(option.value)];
    option.disabled = (mode.kind === 'chase' || mode.kind === 'cockpit') && ships[mode.shipIdx].phase === 'dormant';
  }
  const auto = director.cinematicAuto && preferences.motion >= 0.05;
  const button = element<HTMLButtonElement>('director');
  const label = auto ? 'Automatic camera on' : 'Automatic camera off';
  if (button.textContent !== label) button.textContent = label;
  button.setAttribute('aria-pressed', String(auto));
  element('sync-value').textContent = `${preferences.syncMs > 0 ? '+' : ''}${preferences.syncMs} ms`;
}
window.matchMedia('(prefers-reduced-motion: reduce)').addEventListener('change', event => {
  if (event.matches) {
    preferences.motion = preferences.flash = 0;
    element<HTMLInputElement>('motion').value = element<HTMLInputElement>('flash').value = '0';
    syncControls();
  }
});
applyQualityChoice(); refreshSourceUi(); syncControls();

canvas.addEventListener('webglcontextlost', () => { renderer.setAnimationLoop(null); stopSource(); });

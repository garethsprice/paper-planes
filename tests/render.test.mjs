import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { ScaledBloomPass, resizePipeline } from '../src/render/pipeline.ts';
import { createSimulationClock, SIMULATION_STEP } from '../src/render/simulation.ts';
import { createQuality, updateQuality, createFrameMetrics, QUALITY_LEVELS } from '../src/render/quality.ts';
import { createTerrain, bilerpHeight, envelopeAt, updateEnvelope, shiftTerrainRows, setFlowOffset } from '../src/scene/terrain.ts';
import { createSceneCore } from '../src/scene/core.ts';
import { createShips, updateShip, separateShips } from '../src/scene/ship.ts';
import { createDirector, runDirector } from '../src/camera/director.ts';
import { createCameraSelection, applyCut, isModeAvailable } from '../src/camera/modes.ts';
import { createDynamics } from '../src/audio/dynamics.ts';
import { createRhyme } from '../src/camera/rhyme.ts';
import { createTrails } from '../src/scene/trails.ts';
import { createCameraRig, updateCamera } from '../src/camera/update.ts';
import { createOrbit } from '../src/camera/orbit.ts';

test('simulation speed is identical at 30, 60, 120 and 144 Hz', () => {
  for (const hz of [30,60,120,144]) {
    const clock = createSimulationClock(); let distance = 0, steps = 0;
    for (let i = 0; i < hz * 10; i++) clock.advance(1 / hz, dt => { distance += dt * 23.4375; steps++; });
    assert.equal(steps, 600); assert.ok(Math.abs(distance - 234.375) < 1e-7);
  }
});
test('a stall advances all simulation consumers by the same bounded duration', () => {
  const clock = createSimulationClock(); let terrain = 0, ship = 0;
  clock.advance(8, dt => { terrain += dt * 60 * 0.390625; ship += dt * 23.4375; });
  assert.equal(terrain, ship); assert.ok(Math.abs(terrain - 2.34375) < 1e-7);
});
test('bloom dimensions are identical at startup and resize, including DPR', () => {
  for (const dpr of [1,1.5,2]) {
    const renderer = { getPixelRatio:()=>dpr, getSize:v=>v.set(1000,800) };
    const composer = new EffectComposer(renderer);
    const bloom = new ScaledBloomPass(new THREE.Vector2(500,400),0.2,0.32,0.65);
    composer.addPass(bloom);
    const before = [bloom.renderTargetBright.width,bloom.renderTargetBright.height];
    composer.setSize(1000,800);
    assert.deepEqual(before,[bloom.renderTargetBright.width,bloom.renderTargetBright.height]);
    assert.deepEqual(before,[250*dpr,200*dpr]);
    composer.dispose(); bloom.dispose();
  }
});
test('quality falls under sustained load and recovers only after a stable interval', () => {
  const q = createQuality();
  for (let i=0;i<360;i++) updateQuality(q,30,22,1/60);
  assert.ok(q.level > 0);
  const degraded = q.level;
  for (let i=0;i<120;i++) updateQuality(q,16.7,5,1/60);
  assert.equal(q.level,degraded);
  for (let i=0;i<1200;i++) updateQuality(q,16.7,5,1/60);
  assert.ok(q.level < degraded);
});
test('collision samples match shader height and flight remains above the animated terrain', () => {
  globalThis.window = {innerWidth:1000,innerHeight:800};
  const core = createSceneCore(); const terrain = createTerrain(core);
  terrain.heights.fill(6); core.uniforms.uHeightMul.value = 1.105; updateEnvelope(terrain);
  assert.equal(bilerpHeight(terrain,0,0),6*1.105); assert.equal(envelopeAt(terrain,0,0),6*1.105);
  const {list,formation}=createShips(); const ship=list[0]; ship.group.position.y=6;
  for(let i=0;i<600;i++) updateShip(ship,0,list,formation,terrain,{dt:1/60,time:i/60,groundFlow:23.4375,level:0.5,centroid:0.5,bassEnergy:0.3,beatPulse:0,anticipation:0,arrowKeys:{left:false,right:false,up:false,down:false}},false);
  assert.ok(ship.group.position.y >= 6*1.105+0.95);
  assert.ok(Number.isFinite(ship.flex));
});
test('coincident ships receive a separating command',()=>{
  const {list}=createShips(); list[1].phase='active';
  separateShips(list); assert.notEqual(list[0].sepX,0); assert.equal(list[0].sepX,-list[1].sepX);
});
test('a reserved reveal survives a recent build shot, but pilot control wins', () => {
  const native=globalThis.performance; let now=20000; globalThis.performance={now:()=>now};
  try {
    const director=createDirector(),sel=createCameraSelection(3),dynamics=createDynamics();
    applyCut(sel,1,0); director.reservedUntil=now+8000;
    const ctx={dynamics,dropFiredThisFrame:true,beatCount:8,bpm:120,beatConfidence:1,beatEdge:true,upcomingDropIn:Infinity,upcomingCueAt:-Infinity,motion:1,time:20,rhyme:createRhyme()};
    now+=1000;runDirector(director,sel,ctx); assert.notEqual(sel.currentIdx,1);
    const current=sel.currentIdx;director.holdUntil=0;director.reservedUntil=now+8000;director.pilotActiveUntil=now+5000;
    runDirector(director,sel,ctx);assert.equal(sel.currentIdx,current);
  } finally {globalThis.performance=native;}
});

test('vapour lifetime is stable across rendering refresh rates', () => {
  for (const hz of [30,60,120,144]) {
    const scene = new THREE.Scene(), trails = createTrails(scene), {list} = createShips();
    const clock = createSimulationClock();
    list[0].load=1;
    for (let i=0;i<hz;i++) clock.advance(1/hz,dt=>trails.update(list,23.4375*dt,dt));
    assert.equal(trails.lines.visible,true);
    list[0].load=0;
    for (let i=0;i<hz;i++) clock.advance(1/hz,dt=>trails.update(list,23.4375*dt,dt));
    assert.equal(trails.lines.visible,false);
    trails.lines.geometry.dispose();trails.lines.material.dispose();
  }
});
test('an upcoming cue starts a reveal early and does not restart it on the arrival', () => {
  const native=globalThis.performance;let now=20000;globalThis.performance={now:()=>now};
  try {
    const director=createDirector(),sel=createCameraSelection(3),dynamics=createDynamics();
    const ctx={dynamics,dropFiredThisFrame:false,beatCount:8,bpm:120,beatConfidence:1,beatEdge:false,upcomingDropIn:0.75,upcomingCueAt:25,motion:1,time:20,rhyme:createRhyme()};
    runDirector(director,sel,ctx);
    assert.equal(sel.transitionS,0.75);const idx=sel.currentIdx,changed=sel.modeChangedAt;
    now+=800;ctx.upcomingDropIn=Infinity;ctx.dropFiredThisFrame=true;
    runDirector(director,sel,ctx);assert.equal(sel.currentIdx,idx);assert.equal(sel.modeChangedAt,changed);
  } finally {globalThis.performance=native;}
});

test('severe slow frames reduce quality and remain in the reported percentile', () => {
  const q=createQuality();
  for(let i=0;i<40;i++)updateQuality(q,250,200,0.25);
  assert.ok(q.level>0);
  const metrics=createFrameMetrics();
  for(let i=0;i<20;i++)metrics.sample(4,16.7,i*17);
  for(let i=0;i<3;i++)metrics.sample(200,250,1200+i*1200);
  assert.equal(metrics.p95Ms,250);
});

test('camera reveals finish on presentation time despite bounded physics steps', () => {
  const native=globalThis.performance;let now=10000;globalThis.performance={now:()=>now};
  try {
    globalThis.window={innerWidth:1000,innerHeight:800};
    const {camera}=createSceneCore(),sel=createCameraSelection(3),rig=createCameraRig(),orbit=createOrbit(),{list}=createShips();
    const input={bassEnergy:0,intensity:0,buildLevel:0,dt:1/60,time:0,anticipation:0,motion:1,terrainHeightAt:()=>0};
    updateCamera(camera,sel,orbit,rig,list,input);
    applyCut(sel,3,0,0.85);updateCamera(camera,sel,orbit,rig,list,input);
    now+=900;
    // A source reset may reset shot age, but must not restart an in-flight reveal.
    sel.modeChangedAt=now;
    updateCamera(camera,sel,orbit,rig,list,input);
    assert.ok(rig.blendT>=rig.blendDur);
  } finally {globalThis.performance=native;}
});
test('camera availability follows actual ships when departures leave a gap',()=>{
  const sel=createCameraSelection(3);sel.presentShips=2;sel.availableShips=[true,false,true];
  assert.equal(isModeAvailable(sel,6),false);assert.equal(isModeAvailable(sel,7),true);
});


test('bright terrain rows keep their identity and move continuously at every render cadence', () => {
  globalThis.window = { innerWidth: 1000, innerHeight: 800 };
  const hasEdge = (geometry, a, b) => {
    const index = geometry.index.array;
    for (let i = 0; i < index.length; i += 2) if (index[i] === a && index[i + 1] === b) return true;
    return false;
  };
  for (const cadence of [[1/30], [1/60], [1/120], [1/144], [1/144, 1/90, 1/47, 1/120]]) {
    const terrain = createTerrain(createSceneCore());
    const clock = createSimulationClock();
    const cols = 129, spacing = 50 / 128, flow = 60 * spacing;
    const initialRow = 80;
    const initialZ = terrain.posAttr.getZ(initialRow * cols);
    terrain.heights[initialRow * cols] = 7;
    let shifted = 0, elapsed = 0, previousZ = initialZ, rowAcc = 0;
    const simulate = dt => {
      rowAcc += dt * 60;
      const rows = Math.floor(rowAcc + 1e-9);
      rowAcc -= rows;
      shiftTerrainRows(terrain, rows);
      shifted += rows;
    };
    // Match startup: the first render interpolates back to the initial pose.
    clock.advance(SIMULATION_STEP, simulate);
    for (let frame = 0; elapsed < 0.75; frame++) {
      const dt = cadence[frame % cadence.length];
      elapsed += dt;
      const alpha = clock.advance(dt, simulate);
      setFlowOffset(terrain, rowAcc - (1 - alpha));
      const row = initialRow - shifted;
      assert.equal(terrain.heights[row * cols], 7, 'the height feature must travel with its row');
      assert.equal(hasEdge(terrain.geometry, row * cols, row * cols + 1), true, 'the same feature must stay bright');
      assert.equal(hasEdge(terrain.detail.geometry, row * cols, row * cols + 1), false);
      assert.equal(hasEdge(terrain.detail.geometry, (row - 1) * cols, (row - 1) * cols + 1), true);
      const z = terrain.posAttr.getZ(row * cols) + terrain.mesh.position.z;
      assert.ok(Math.abs(z - (initialZ - flow * elapsed)) < 1e-6, 'scroll position must follow continuous elapsed time');
      assert.ok(Math.abs(z - previousZ + flow * dt) < 1e-6, 'a row boundary must not introduce a jump');
      assert.equal(terrain.mirror.geometry, terrain.geometry);
      assert.equal(terrain.mirror.position.z, terrain.mesh.position.z);
      previousZ = z;
    }
  }
});

test('terrain index phases partition all edges and support multi-row shifts without rebuilding', () => {
  globalThis.window = { innerWidth: 1000, innerHeight: 800 };
  const terrain = createTerrain(createSceneCore());
  const initialIndex = terrain.geometry.index;
  for (let phase = 0; phase < 4; phase++) {
    const edges = new Set();
    let count = 0;
    for (const geometry of [terrain.geometry, terrain.detail.geometry]) {
      const index = geometry.index.array;
      for (let i = 0; i < index.length; i += 2) { edges.add(`${index[i]},${index[i + 1]}`); count++; }
    }
    assert.equal(count, 129 * 128 * 2);
    assert.equal(edges.size, count, 'every edge belongs to exactly one brightness group');
    shiftTerrainRows(terrain, 3);
  }
  assert.equal(terrain.geometry.index, initialIndex, 'reuse the original GPU attribute after a full phase cycle');
});

test('quality reduces effects before scene resolution and preserves antialiasing at every level', () => {
  globalThis.window = { devicePixelRatio: 1.5 };
  const renderer = {
    ratio: 1.5,
    getPixelRatio() { return this.ratio; },
    setPixelRatio(value) { this.ratio = value; },
    getSize: v => v.set(1000, 800),
    setSize() {},
  };
  const composer = new EffectComposer(renderer);
  const bloom = new ScaledBloomPass(new THREE.Vector2(500, 400), 0.2, 0.32, 0.65);
  composer.addPass(bloom);
  const pipeline = { renderer, composer, bloom, quality: createQuality() };
  resizePipeline(pipeline, 1000, 800);
  const sceneWidth = composer.renderTarget1.width;
  const bloomWidth = bloom.renderTargetBright.width;
  pipeline.quality.level = 1;
  resizePipeline(pipeline, 1000, 800);
  assert.equal(composer.renderTarget1.width, sceneWidth, 'first downgrade preserves line resolution');
  assert.ok(bloom.renderTargetBright.width < bloomWidth);
  assert.equal(QUALITY_LEVELS[1].reflection, false);
  assert.ok(QUALITY_LEVELS[1].detail < QUALITY_LEVELS[0].detail);
  for (let level = 0; level < QUALITY_LEVELS.length; level++) {
    pipeline.quality.level = level;
    resizePipeline(pipeline, 1000, 800);
    assert.ok(composer.renderTarget1.samples >= 2);
    assert.ok(composer.renderTarget2.samples >= 2);
  }
  assert.ok(composer.renderTarget1.width < sceneWidth, 'sustained load can still reduce resolution');
  composer.dispose(); bloom.dispose();
});

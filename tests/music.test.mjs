import test from 'node:test';
import assert from 'node:assert/strict';
import { createDynamics, updateDynamics, releaseDynamics } from '../src/audio/dynamics.ts';
import { createBeatClock, updateBeatClock } from '../src/audio/beatClock.ts';
import { frequencyBin, createFeatureTracker } from '../src/audio/features.ts';
import { analyseTrack } from '../src/audio/trackFeatures.ts';
import { parseLrc, lyricAt } from '../src/audio/lrc.ts';
import { createMood, updateMood } from '../src/scene/mood.ts';

function feed(d, seconds, level, onsetAtStart = false) {
  for (let i = 0; i < seconds * 60; i++) updateDynamics(d, level, 1 / 60, onsetAtStart && i === 0);
}
test('a steady start never produces a drop, even with repeated attacks', () => {
  const d = createDynamics();
  for (let i = 0; i < 1200; i++) updateDynamics(d, 0.8, 1 / 60, i % 30 === 0);
  assert.equal(d.dropCount, 0);
});
test('a loud transient requires anticipation; a sustained arrival after quiet releases once', () => {
  const d = createDynamics();
  feed(d, 4, 0.4); feed(d, 0.2, 0.95, true); feed(d, 2, 0.4);
  assert.equal(d.dropCount, 0);
  feed(d, 2, 0); feed(d, 2, 0.8, true);
  assert.equal(d.dropCount, 1);
  feed(d, 8, 0.8, true);
  assert.equal(d.dropCount, 1);
});
test('beat clock acquires phase from repeated evidence and loses confidence without attacks', () => {
  const c = createBeatClock();
  for (let i = 0; i < 600; i++) updateBeatClock(c, i / 60, i % 30 === 0, 120, 1 / 60);
  assert.ok(c.confidence > 0.8);
  assert.ok(Math.abs(c.bpm - 120) < 1);
  assert.ok(c.count >= 19 && c.count <= 21, String(c.count));
  for (let i = 600; i < 1000; i++) updateBeatClock(c, i / 60, false, 120, 1 / 60);
  assert.ok(c.confidence < 0.2);
});
test('a tempo estimate alone does not invent beats', () => {
  const c = createBeatClock();
  for (let i = 0; i < 600; i++) updateBeatClock(c, i / 60, false, 120, 1 / 60);
  assert.equal(c.count, 0); assert.equal(c.confidence, 0);
});
test('frequency bands are defined in Hz and silence has no spectral attack', () => {
  for (const rate of [44100, 48000, 96000]) {
    const bin = frequencyBin(250, rate, 2048);
    assert.ok(Math.abs(bin * rate / 2048 - 250) <= rate / 2048 / 2);
  }
  const tracker = createFeatureTracker(1024);
  const spectrum = new Float32Array(1024).fill(-Infinity);
  for (let i = 0; i < 120; i++) {
    const f = tracker.read(new Float32Array(2048), spectrum, 48000, i / 60);
    assert.equal(f.rms, 0); assert.equal(f.onset, false); assert.equal(f.level, 0);
  }
});
test('offline cues ignore startup and isolated spikes but detect a sustained arrival', () => {
  const rate = 1000, samples = new Float32Array(rate * 24);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i * 0.31) * (i / rate < 12 ? 0.015 : 0.25);
  samples[8000] = 1;
  const cues = analyseTrack(samples, rate);
  assert.ok(cues.some(c => Math.abs(c.time - 12) < 0.1), JSON.stringify(cues));
  assert.ok(cues.every(c => c.time >= 11.9));
});
test('LRC supports offsets, repeated timestamps, sorting, and seek lookup', () => {
  const lines = parseLrc('[offset:-100]\n[00:02.50][00:04.500]return\n[00:01.00]first\n[00:99]invalid');
  assert.deepEqual(lines, [{time:0.9,text:'first'},{time:2.4,text:'return'},{time:4.4,text:'return'}]);
  assert.equal(lyricAt(lines, 0), -1); assert.equal(lyricAt(lines, 3), 1); assert.equal(lyricAt(lines, 1), 0);
});

test('regular eighth-note attacks do not prevent tempo lock or double the beat rate', () => {
  const c=createBeatClock();
  for(let i=0;i<900;i++)updateBeatClock(c,i/60,i%15===0,120,1/60);
  assert.ok(c.confidence>0.8);assert.ok(Math.abs(c.bpm-120)<1);
  // Initial unconfident attacks are immediate; after lock the period is half a second.
  const before=c.count;
  for(let i=900;i<1500;i++)updateBeatClock(c,i/60,i%15===0,120,1/60);
  assert.ok(c.count-before>=19 && c.count-before<=21);
});

test('a release holds its afterglow instead of immediately rebuilding anticipation',()=>{
  const d=createDynamics(),m=createMood();feed(d,4,0.3);
  releaseDynamics(d,d.age);updateMood(m,d,true,true,1/60);
  for(let i=0;i<180;i++) {
    updateDynamics(d,0.9,1/60,i%30===0,1);
    updateMood(m,d,false,true,1/60);
    assert.equal(m.anticipation,0);assert.equal(d.build,0);
  }
  assert.equal(d.dropCount,1);assert.ok(m.afterglow>0);
});

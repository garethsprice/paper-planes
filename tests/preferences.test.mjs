import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPreferences, savePreferences } from '../src/ui/preferences.ts';
test('reduced motion starts with motion and flashes off, even with previous preferences', () => {
  globalThis.window={matchMedia:()=>({matches:true})};
  globalThis.localStorage={getItem:()=>JSON.stringify({motion:1,flash:1,quality:'low'})};
  assert.deepEqual(loadPreferences(),{motion:0,flash:0,syncMs:0,quality:'low'});
});
test('corrupt or unavailable preference storage retains usable defaults', () => {
  globalThis.window={matchMedia:()=>({matches:false})};
  globalThis.localStorage={getItem:()=>{throw Error('unavailable');}};
  assert.deepEqual(loadPreferences(),{motion:0.8,flash:0.35,syncMs:0,quality:'high'});
});

test('High is the default and legacy Automatic settings migrate without losing other preferences', () => {
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  globalThis.localStorage = { getItem: () => null };
  assert.equal(loadPreferences().quality, 'high');
  globalThis.localStorage = { getItem: () => JSON.stringify({ quality: 'auto', motion: 0.4, flash: 0.2, syncMs: 80 }) };
  assert.deepEqual(loadPreferences(), { quality: 'high', motion: 0.4, flash: 0.2, syncMs: 80 });
});
test('an explicit Automatic or Low selection survives a reload with the new High default', () => {
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  let saved = null;
  globalThis.localStorage = { getItem: () => saved, setItem: (_, value) => { saved = value; } };
  for (const quality of ['auto', 'low', 'high']) {
    savePreferences({ quality, motion: 0.8, flash: 0.35, syncMs: 0 });
    assert.equal(loadPreferences().quality, quality);
  }
});

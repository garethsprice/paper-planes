import test from 'node:test';
import assert from 'node:assert/strict';
import { loadAudioFile, attachStream, disconnectCurrent } from '../src/audio/sources.ts';
import { createBpmHandle } from '../src/audio/bpm.ts';
class AudioNode {
  constructor(){this.outputs=new Set();this.gain={value:0};}
  connect(target){this.outputs.add(target);}
  disconnect(target){if(target)this.outputs.delete(target);else this.outputs.clear();}
}
function fixture() {
  const destination=new AudioNode(), media=new AudioNode(), capture=new AudioNode();
  const bpm=createBpmHandle();bpm.analyzer={reset(){}};bpm.gain=new AudioNode();
  const state={ctx:{destination,createMediaElementSource:()=>media,createMediaStreamSource:()=>capture},analyser:new AudioNode(),featureAnalyser:new AudioNode(),features:{reset(){}},kind:'none',generation:0,audioEl:{pause(){},load(){},removeAttribute(){}},currentSourceNode:null,micStream:null,currentObjectUrl:null};
  return {state,bpm,media,capture,destination};
}
test('file → mic → file → tab never routes capture into playback', async () => {
  const {state,bpm,media,capture,destination}=fixture();
  const file=new File(['probe'],'test.wav');
  loadAudioFile(state,bpm,file);await Promise.resolve();assert.ok(media.outputs.has(destination));
  const stream={getTracks:()=>[]};
  attachStream(state,bpm,stream,'mic');await Promise.resolve();
  assert.equal(media.outputs.has(destination),false);assert.equal(state.analyser.outputs.has(destination),false);
  assert.equal(capture.outputs.has(destination),false);assert.equal(bpm.gain.gain.value,8);
  loadAudioFile(state,bpm,file);await Promise.resolve();
  attachStream(state,bpm,stream,'tab');await Promise.resolve();assert.equal(bpm.gain.gain.value,1);
  assert.equal(capture.outputs.has(destination),false);assert.equal(state.featureAnalyser.outputs.has(destination),false);
  disconnectCurrent(state,bpm);if(state.currentObjectUrl) URL.revokeObjectURL(state.currentObjectUrl);
});
test('a late BPM setup cannot reconnect a stopped source', async()=>{
  const {state,bpm,media}=fixture();let resolve;
  bpm.analyzer=null;bpm.pending=new Promise(done=>{resolve=done;});
  loadAudioFile(state,bpm,new File(['probe'],'test.wav'));
  disconnectCurrent(state,bpm);
  resolve({reset(){}});await Promise.resolve();await Promise.resolve();
  assert.equal(media.outputs.size,0);
  if(state.currentObjectUrl) URL.revokeObjectURL(state.currentObjectUrl);
});

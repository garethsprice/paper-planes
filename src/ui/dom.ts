// Cached DOM element references. Single import point so we don't sprinkle
// `document.getElementById` calls across modules and so the cast assertions
// live in exactly one file.

export const dom = {
  canvas:   document.getElementById('stage')   as HTMLCanvasElement,
  fileInput: document.getElementById('file')   as HTMLInputElement,
  playBtn:  document.getElementById('play')    as HTMLButtonElement,
  micBtn:   document.getElementById('mic')     as HTMLButtonElement,
  tabBtn:   document.getElementById('tab')     as HTMLButtonElement,
  stereoBtn: document.getElementById('stereo') as HTMLButtonElement,
  vrBtn:    document.getElementById('vr')      as HTMLButtonElement | null,
  lyricsBtn: document.getElementById('lyrics') as HTMLButtonElement,
  debugBtn: document.getElementById('debug')   as HTMLButtonElement,
  uiEl:     document.getElementById('ui')      as HTMLDivElement,
  statusEl: document.getElementById('status')  as HTMLSpanElement,
  bpmNumEl: document.querySelector('#bpm .num') as HTMLSpanElement,
  bpmDotEl: document.getElementById('bpm-dot') as HTMLSpanElement,
  dbgEl:    document.getElementById('dbg')     as HTMLSpanElement,
};

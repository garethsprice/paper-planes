// Keyboard handlers + arrow-key joystick state. The arrow keys are read by
// updateShip when the active camera mode is chase/cockpit; everything else
// invokes module callbacks (toggle bloom / nebula / cinematic / cycle cam /
// reset BPM / toggle stereo / nudge eyeSep / fullscreen / play-pause).

export type ArrowKeys = { left: boolean; right: boolean; up: boolean; down: boolean };
export const arrowKeys: ArrowKeys = { left: false, right: false, up: false, down: false };

export type KeyCallbacks = {
  togglePlay: () => void;
  toggleBloom: () => void;
  toggleNebula: () => void;
  toggleCinematic: () => void;
  toggleStereo: () => void;
  toggleLyrics: () => void;
  nudgeEyeSep: (delta: number) => void;
  cycleCamera: () => void;
  resetBpm: () => void;
  bumpPilotControl: () => void;
  toggleFullscreen: () => void;
};

export function installKeyHandlers(cb: KeyCallbacks): void {
  document.addEventListener('keydown', (e) => {
    // ignore key events fired inside form fields
    if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
    switch (e.key.toLowerCase()) {
      case ' ':         e.preventDefault(); cb.togglePlay(); break;
      case 'b':         cb.toggleBloom(); break;
      case 'f':         cb.toggleFullscreen(); break;
      case 'r':         cb.resetBpm(); break;
      case 'n':         cb.toggleNebula(); break;
      case 'l':         cb.toggleLyrics(); break;
      case 'c':         cb.cycleCamera(); break;
      case 'v':         cb.toggleCinematic(); break;
      case '3':         cb.toggleStereo(); break;
      case '[':         cb.nudgeEyeSep(-0.05); break;
      case ']':         cb.nudgeEyeSep(+0.05); break;
      case 'arrowleft':  arrowKeys.left  = true; cb.bumpPilotControl(); e.preventDefault(); break;
      case 'arrowright': arrowKeys.right = true; cb.bumpPilotControl(); e.preventDefault(); break;
      case 'arrowup':    arrowKeys.up    = true; cb.bumpPilotControl(); e.preventDefault(); break;
      case 'arrowdown':  arrowKeys.down  = true; cb.bumpPilotControl(); e.preventDefault(); break;
    }
  });

  document.addEventListener('keyup', (e) => {
    switch (e.key.toLowerCase()) {
      case 'arrowleft':  arrowKeys.left = false; break;
      case 'arrowright': arrowKeys.right = false; break;
      case 'arrowup':    arrowKeys.up = false; break;
      case 'arrowdown':  arrowKeys.down = false; break;
    }
  });

  // Lose held inputs on window blur — switching tabs while holding an arrow
  // would otherwise leave the ship locked into a turn forever.
  window.addEventListener('blur', () => {
    arrowKeys.left = arrowKeys.right = arrowKeys.up = arrowKeys.down = false;
  });
}

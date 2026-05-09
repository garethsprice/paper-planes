# paper planes

An audio-reactive 3D spectrogram visualizer with autonomous paper-airplane ships flying the landscape.

Drop in an audio file, share a tab's audio, or use your microphone. The terrain is a scrolling waterfall FFT, the ships are autopiloted wedges that bank through valleys and over peaks in time with the music, and the camera cycles through cinematic views on bar boundaries when the BPM is locked.

## What this is

Since I was a kid I've watched something like this in my head whenever I've listened to music: terrain unrolling out of the sound, paper planes carving through valleys, the whole landscape breathing with the kick. Headphones, eyes closed, and there it was. This is my attempt to actually see it from the outside — it's not quite the version in my head, but it's the closest I've gotten.

## Features

- **Live spectrogram** — `AnalyserNode` (`fftSize: 1024`, `smoothing: 0.8`) drives a 129×129 wireframe grid scrolling in -Z.
- **Audio sources** — file drop / pick, microphone, or a tab via `getDisplayMedia` (Chrome/Edge).
- **Three autopilot ships** — each a 3D triangular wedge with a sharp nose and tall back. They use a real flight model (heading + scalar speed integrated with dt, P-controller turn rate, intrinsic yaw→pitch→roll), wander to targets driven by simplex noise + spectral centroid, and bank into turns.
- **BPM detection** — [`realtime-bpm-analyzer`](https://github.com/dlepaux/realtime-bpm-analyzer) feeds a live readout and a per-beat dot indicator. A 200 Hz biquad lowpass focuses peak detection on the kick band; mic input gets a 8× gain stage so quiet rooms still lock.
- **Beat reactivity** — ships get a thrust kick on every detected peak; the whole landscape breathes vertically; the camera bass-pushes in; the cool→hot gradient drifts in hue.
- **11 cameras** — five cinematic presets (eye-level, 3/4 high-side, low-left, overhead reverse, straight overhead), three chase cameras (one per ship), three FPV cockpit cameras (own ship hidden). Auto-cycles every 8 beats; press `C` to advance manually.
- **Ethereal post-processing** — UnrealBloomPass at half resolution, a custom radial chromatic-aberration pass that pulses with bass, and a faint mirror world reflected below the terrain.
- **Iridescent shimmer** — slow oil-slick hue noise in the fragment shader, BPM-driven hue offset on top.
- **Star field** — 600 points in an upper-hemisphere shell.
- **Optional particle nebula** — toggled with `N` for added haze.

## Controls

| Key | Action |
|-----|--------|
| **drag canvas** | manual orbit (when not in cinematic mode) |
| **drop audio file** | load and play |
| **space** | play / pause |
| **C** | next camera (cinematic preset → chase ships → cockpit ships) |
| **V** | toggle cinematic auto-advance |
| **arrows** | (chase / cockpit only) joystick — left/right yaw, up/down pitch |
| **B** | toggle bloom |
| **N** | toggle particle nebula |
| **3** | toggle side-by-side stereo (for AR glasses that split the screen) |
| **[** / **]** | nudge stereo eye separation |
| **F** | fullscreen |
| **R** | reset BPM lock |

The UI strip auto-hides after 3 seconds of inactivity; move the mouse to bring it back.

## Quick start

```bash
make install   # npm install
make serve     # serves on https://0.0.0.0:<random-free-port>
```

The dev server uses a self-signed certificate (via `@vitejs/plugin-basic-ssl`) because `navigator.mediaDevices` requires a secure context — accept the browser warning once and the mic works on any LAN host.

`make build` produces a static `dist/` for deployment. `make preview` serves the production build.

## Deployment

A GitHub Actions workflow (`.github/workflows/deploy.yml`) automatically builds and deploys to GitHub Pages on every push to `main`. To enable:

1. Push the repo to GitHub.
2. **Settings → Pages → Source: GitHub Actions**.
3. Push to `main` (or run the workflow manually). Site goes live at `https://<user>.github.io/<repo>/`.

`vite.config.ts` uses `base: './'` so the build works under any subdirectory — no need to hardcode the repo name.

## Stack

- TypeScript + Vite
- [three.js](https://threejs.org/) (WebGL2, `LineSegments` + `ShaderMaterial` + `EffectComposer`)
- [`simplex-noise`](https://www.npmjs.com/package/simplex-noise) for organic ship-wander targets
- [`realtime-bpm-analyzer`](https://www.npmjs.com/package/realtime-bpm-analyzer) for live BPM lock

## Browser support

- **Chrome / Edge** — fully supported (mic, tab audio, all post passes).
- **Firefox** — supported except `getDisplayMedia({ audio: true })`; mic and file input still work.
- **Safari** — supported with caveats: `getDisplayMedia` audio support is limited.

All audio sources require a user gesture to start (browser autoplay policy). Click anywhere on the canvas after page load to grant mic access if you want the default flow.

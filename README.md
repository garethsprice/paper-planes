# paper planes

An audio-reactive 3D spectrogram visualizer with autonomous paper-airplane ships flying the landscape.

Drop in an audio file, share a tab's audio, or use your microphone. The terrain is a scrolling waterfall FFT, the ships are autopiloted wedges that bank through valleys and over peaks in time with the music, and the camera cycles through cinematic views on bar boundaries when the BPM is locked.

## What this is

Since I was a kid I've watched something like this in my head whenever I've listened to music: terrain unrolling out of the sound, paper planes carving through valleys, the whole landscape breathing with the kick. Headphones, eyes closed, and there it was. This is my attempt to actually see it from the outside — it's not quite the version in my head, but it's the closest I've gotten.

## Features

- **Live spectrogram** — `AnalyserNode` (`fftSize: 1024`, `smoothing: 0.8`) drives a 129×129 wireframe grid scrolling in -Z.
- **Audio sources** — file drop / pick, microphone, or a tab via `getDisplayMedia` (Chrome/Edge).
- **A flock that breathes with the music** — one paper plane in quiet passages, a handful through a verse, and — exponentially, only at the top of the energy range — up to `SHIP_MAX` (28) at the peak of the song, arriving in a rush when the gap is large and ebbing away slowly. Musical energy is the mean spectrum level normalised against a ~90 s running peak, so it self-calibrates to any source; arrivals surge in from the dark behind the flock, departures throttle back, bank outward and fade as the landscape carries them away. The leader never leaves.
- **Autopilot ships** — paper wedges with frosted panels and a glowing edge, drawn as two instanced draw calls for the whole flock (edges and panels) plus one for all wingtip vapour, with a neighbour-separation term so a dense flock keeps its spacing. They fly in the *landscape's* reference frame: the spectrogram streams past at one grid row per frame, the planes are carried with it, and they hold station by flying into the flow at airspeed ≈ ground speed. Every motion is a physical consequence — bank gives a coordinated turn (ω = g·tan φ / v) and lateral drift, pitch gives climb/dive (dives speed up, climbs bleed), throttle surges the flock forward on bass and lets it fall back in quiet, and acceleration pitches the nose: a plane drops its nose to gain speed and flares as it sheds it. Altitude rides a slow terrain *envelope* — rising quickly onto loud passages, sinking gently after. Wander targets come from simplex noise + spectral centroid.
- **BPM detection** — [`realtime-bpm-analyzer`](https://github.com/dlepaux/realtime-bpm-analyzer) feeds a live readout and a per-beat dot indicator. A 200 Hz biquad lowpass focuses peak detection on the kick band; mic input gets a 8× gain stage so quiet rooms still lock.
- **Beat reactivity** — ships get a thrust kick on every detected peak; the whole landscape breathes vertically; the camera bass-pushes in; the cool→hot gradient drifts in hue.
- **11 cameras** — five cinematic presets (eye-level, 3/4 high-side, low-left, overhead reverse, high crane), three chase cameras (one per ship), three FPV cockpit cameras (own ship hidden). There are no cuts: every shot change is a crane-style glide (≈3 s, 1.8 s on a drop) from wherever the camera is into the new mode's live pose. Presets drift gently while held; chase is a damped tether that tilts with the ship's bank. A music-driven director holds shots for 16–48 beats and moves on drops, builds and quiet onsets — never sooner than ~14 s into a shot. Press `C` to advance manually, `V` to toggle the director.
- **Mood** — a build *withholds*: exposure dims, fog creeps in, the aurora fades, the camera pushes in and low, the flock draws into formation and climbs. The drop *releases*: a quarter-second flash to white, the sky ignites, the lens opens and the camera pulls back to a wide reveal while the flock scatters and dives. Genuine quiet lets the grid sink toward black — stars and the lone leader remain — and the first kick brings the light straight back.
- **Wingtip vapour** — thin additive ribbons off each wingtip that form only under aerodynamic load (bank g, hard acceleration, the drop dive, an arrival surging in) and fade within a second, carried back into the flow with the landscape.
- **Visual rhyme** — every shot change is tagged with a fingerprint of the music that led into it (energy, bass, timbre) and the event that caused it; when a later change matches a remembered one, the director returns to that shot, so the second chorus is seen from where the first was. A `rhyme` tag shows in the status strip when it fires.
- **Horizon light** — a sky dome with a sun disc and a haze gathered on one side. Its elevation follows the song's long-term energy (a glow below the horizon in quiet, risen ~14° at full intensity) and its colour warms from ember to gold — sunrise as crescendo. The same light rim-lights the ships' sun-facing surfaces, shades their frosted panels per face (flat-shaded from screen-space derivatives: hemisphere ambient, wrapped diffuse, and transmission through faces lit from behind, so a plane crossing the glow lights up like a lantern rather than cutting a black shape), washes the far side of the grid, catches the mountain crests and tints the mountain lines with the haze where they cross the glow; the hush dims it and the drop flares the disc.
- **Crest sparks** — on each beat a few points of light lift off the highest crests (more with intensity, a burst on a drop, none in the hush), arc gently, drift back with the landscape and fade like embers. A GPU pool integrated in the vertex shader.
- **Mountain ring** — a coarse wireframe range encircling the grid at 66–112 u, peaks breathing with the song's long arc and swelling faintly on the beat, fading ring by ring toward the sky for atmospheric depth. Its height field scrolls through world Z at a fraction of the ground flow (quicker with energy), so near peaks pass while far ones crawl — the parallax of moving through a landscape at scale.
- **Ethereal post-processing** — restrained UnrealBloomPass at half resolution (high threshold, tight radius — a halo on the brightest crests, never a wash), a whisper of radial chromatic aberration that pulses with bass, and a faint mirror world reflected below the terrain.
- **Iridescent shimmer** — slow oil-slick hue noise in the fragment shader, BPM-driven hue offset on top, and tiny glints that drift along the crests so the grid glimmers rather than glows.
- **Star field** — 600 points in an upper-hemisphere shell.
- **Optional particle nebula** — toggled with `N` for added haze.

## Controls

| Key | Action |
|-----|--------|
| **drag canvas** | nudge the orbit in preset views (relaxes back over ~25 s) |
| **drop audio file** | load and play |
| **space** | play / pause |
| **C** | next camera (cinematic preset → chase ships → cockpit ships; tracked views only for ships currently in the flock) |
| **V** | toggle cinematic auto-advance |
| **arrows** | (chase / cockpit only) joystick — left/right yaw, up/down pitch |
| **B** | toggle bloom |
| **N** | toggle particle nebula |
| **3** | toggle side-by-side stereo (for AR glasses that split the screen) |
| **[** / **]** | nudge stereo eye separation |
| **enter vr** | (button, shown only when WebXR is supported) immersive 360° stereo on Quest browser — head rotation looks around the scene from a fixed scenic anchor; cinematic auto-cycle and post-processing pause while presenting |
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

## Code map

`main.ts` is now a thin orchestrator (~400 lines) that wires modules together and runs the per-frame loop. Each module exports an `init`/factory function returning a POJO handle, and an `update(handle, frame)` (or similar) for per-frame work. The `Frame` object in `src/frame.ts` is the per-frame context that subsystems read/write.

```
src/
├── main.ts            bootstrap + animation loop
├── constants.ts       all numeric tunables (grid, ship, audio, camera)
├── frame.ts           per-frame Frame type
│
├── scene/
│   ├── core.ts        scene, fog, master camera, shared uniforms
│   ├── terrain.ts     line-grid spectrogram + shaders + bilerpHeight + coarse envelope
│   ├── stars.ts       full-sphere star field
│   ├── nebula.ts      spherical particle nebula
│   ├── ship.ts        Ship type, kinematic flight model, formation, separation
│   ├── shipRender.ts  instanced edges + lit panels for the whole flock
│   ├── flock.ts       music-energy → flock size; arrivals and departures
│   ├── mood.ts        anticipation / flash / afterglow / hush scalars
│   ├── trails.ts      wingtip vapour ribbons under load
│   ├── sky.ts         sky dome + horizon light
│   ├── sparks.ts      beat-driven crest sparks (GPU pool)
│   └── mountains.ts   distant wireframe range for scale
│
├── audio/
│   ├── sources.ts     AudioContext + analyser + file/mic/tab attach
│   ├── analyser.ts    per-frame fft → bass/level/centroid extraction
│   ├── bpm.ts         realtime-bpm-analyzer wiring + beat events
│   └── dynamics.ts    short/mid/long EMAs → intensity/build/quiet/drops
│
├── camera/
│   ├── modes.ts       CamMode union, role pools, pickCinematicMode
│   ├── orbit.ts       mouse-drag spring physics for preset cams
│   ├── update.ts      per-frame switch over the active mode
│   ├── director.ts    music-driven cuts + pilot-extension override
│   └── rhyme.ts       section fingerprints → remembered shots
│
├── render/
│   ├── pipeline.ts    renderer + composer + bloom + chromatic + post-fx
│   └── stereo.ts      StereoCamera + HybridRenderPass for AR-glasses SBS
│
├── xr/
│   └── session.ts     WebXR Quest session lifecycle
│
├── input/
│   └── keys.ts        keyboard shortcuts + arrow-key joystick state
│
└── ui/
    ├── dom.ts         cached DOM element refs
    └── status.ts      BPM readout, debug panel, UI auto-hide
```

## Browser support

- **Chrome / Edge** — fully supported (mic, tab audio, all post passes).
- **Firefox** — supported except `getDisplayMedia({ audio: true })`; mic and file input still work.
- **Safari** — supported with caveats: `getDisplayMedia` audio support is limited.

All audio sources require a user gesture to start (browser autoplay policy). Click anywhere on the canvas after page load to grant mic access if you want the default flow.

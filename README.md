# paper planes

An audio-reactive 3D spectrogram visualizer with autonomous paper-airplane ships flying the landscape.

Drop in an audio file, share a tab's audio, or use your microphone. The terrain is a scrolling waterfall FFT, the ships are autopiloted wedges that bank through valleys and over peaks in time with the music, and the camera cycles through cinematic views on bar boundaries when the BPM is locked.

## What this is

Since I was a kid I've watched something like this in my head whenever I've listened to music: terrain unrolling out of the sound, paper planes carving through valleys, the whole landscape breathing with the kick. Headphones, eyes closed, and there it was. This is my attempt to actually see it from the outside — it's not quite the version in my head, but it's the closest I've gotten.

## Listening

Choose **Load track**, **Tab audio**, or **Microphone**, or try the original 40-second demo. Dropping a file starts playback. **Stop** disconnects the source, stops captured tracks and speech recognition, and returns to the source chooser.

**View & sound** contains camera selection, automatic direction, camera motion, flash intensity, visual timing, quality, stereo and lyrics. Controls hide after three seconds of inactivity and remain visible while hovered, focused or open. The layout supports narrow screens and keyboard navigation.

## Musical response

- **Two analysis paths:** the terrain uses a smoothed 1024-point display FFT; a separate unsmoothed 2048-point analyser measures RMS and spectral flux. Frequency bands use the actual sample rate: bass 35–250 Hz, mids 250 Hz–4 kHz, highs 4–16 kHz.
- **Beat confidence:** repeated onsets establish a tempo and phase, including eighth-note subdivisions. The BPM worklet supplies tempo candidates. The clock loses confidence when attacks disappear; a tempo estimate by itself never fabricates a beat or a bar boundary.
- **Conservative releases:** startup establishes a baseline. A live release requires prior quiet or a sustained build, an attack, a meaningful increase in energy and an eight-second recovery interval. The scene moves through settle, anticipate, release and recover states.
- **File lookahead:** a worker finds sustained arrivals in a locally decoded, low-rate waveform. It can prepare a reveal up to eight seconds ahead and start the camera move so it arrives with the cue. This is an energy-based heuristic, not harmonic or downbeat recognition. It skips files over 50 MB or decoded durations over 15 minutes; normal live analysis and playback still work. Replacing or stopping a source cancels pending analysis.
- **Presentation timing:** file cues and lyric timestamps account for the audio output clock where available. The timing slider advances visuals with positive values and delays them with negative values. Live capture uses observed attacks and does not predict unheard audio.
- **Visual rhyme:** the director retains the existing energy/timbre fingerprint memories so repeated sections can return to an earlier composition. Memories reset on source changes and seeking.

## Graphics and flight

- A scrolling spectrogram blended with broad bass swells, ridged midrange terrain, fine high-frequency texture and slow geological accumulation.
- A warm, recognizable leader with a central crease. Neighboring ships share smooth gusts; aerodynamic load drives spring-based wing flex in both their panels and outlines.
- Coordinated bank/pitch flight with speed-dependent terrain lookahead, boundary steering and separation, including coincident ships. Camera clearance, ship clearance and spark emission use the same beat-scaled terrain heights as the shader.
- Builds gather the flock and reserve a reveal; releases scatter it and hold the wider composition. File lookahead stages arrivals before the cue. User camera changes and pilot input take precedence.
- A major/minor grid: nearby detail remains visible while minor lines fade with distance. The mountain ring, horizon light, stars, crest sparks and restrained mirror create depth.
- Vapour forms under load as tapered, camera-facing ribbons and fades over 0.7 seconds.

### Time and render quality

Physics runs at a fixed **60 steps per second**, with interpolated ship and camera poses between steps. Terrain flow is always **60 rows per second**, independent of screen refresh. Catch-up is bounded to 100 ms per render callback; all simulation consumers advance together after a stall.

High is the default quality. Every quality level preserves 2× MSAA in the scene render target. Bright terrain rows follow the scrolling history, keeping the grid continuous across simulation steps. Bloom owns its resolution scaling, so adding it to the composer and resizing use the same physical-pixel calculation. Tone mapping and output conversion also work in the direct-render XR path.

Optional **Automatic** quality reduces reflections, fine detail and bloom resolution first, then lowers pixel density under sustained load. It waits for a longer stable interval before restoring quality. **High** keeps full detail; **Low** offers a lighter manual setting. Legacy saved Automatic defaults migrate to High; newly selected Automatic settings are remembered. **Show performance** exposes CPU submission time, GPU render time when timer queries are supported, and the 95th percentile of recent frame intervals. These are separate measurements; unavailable GPU timing displays a dash.

A recovery screen handles graphics initialization failure and context loss. Context loss stops playback/capture and the animation loop. **Try again** reloads the app.

## Lyrics and comfort

- **Mic lyrics** are off by default and only listen while the microphone source is active. Browser speech recognition may send audio to the browser vendor’s service. Switching sources or stopping ends recognition; late results are ignored.
- **Load lyrics (.lrc)** uses local timestamped text. Multiple timestamps, fractional seconds and the `[offset:...]` field are supported. Lyrics follow playback and seeking; **Clear lyrics** removes them.
- The system’s reduced-motion preference starts with automatic camera motion and flashes off. You can adjust the sliders for the current experience. Settings are saved locally when storage is available.
- WebXR uses a stationary observer anchor and disables automatic camera changes while presenting. Side-by-side stereo remains available for glasses. Headset comfort and target-device performance should be checked on physical hardware.

## Controls

| Control | Action |
|---|---|
| Drag the scene | Adjust a preset camera |
| Space | Play / pause a file |
| C / camera menu | Next / selected camera |
| V | Toggle automatic camera |
| Arrow keys | Pilot a ship in chase or cockpit view |
| F | Fullscreen |
| B | Toggle bloom |
| N | Toggle particle nebula |
| L | Toggle microphone lyric recognition |
| 3 | Toggle side-by-side stereo |
| [ / ] | Adjust stereo eye separation |
| R | Reset tempo and beat confidence |

## Development

Use **Node.js 22.18 or newer**.

```bash
npm ci
npm run dev     # HTTPS; accepts microphone/tab capture on the LAN
npm test        # focused timing, routing, physics and rendering regressions
npm run build   # TypeScript checking + production assets
```

The local HTTPS certificate is self-signed. `make serve` chooses a free port; `make build` and `make test` run the same checks as the npm scripts. Production assets use a relative base path for subdirectory hosting.

GitHub Actions runs tests and builds before deploying pushes to `main` to GitHub Pages. Configure **Settings → Pages → Source: GitHub Actions** to enable deployment.

## Code map

| Area | Files |
|---|---|
| Startup and orchestration | `src/bootstrap.ts`, `src/main.ts` |
| Sources and musical features | `src/audio/sources.ts`, `features.ts`, `analyser.ts`, `bpm.ts`, `beatClock.ts`, `dynamics.ts` |
| File cues and lyrics | `src/audio/track.ts`, `track.worker.ts`, `trackFeatures.ts`, `lrc.ts`, `lyrics.ts`, `demo.ts` |
| Simulation and rendering | `src/render/simulation.ts`, `quality.ts`, `pipeline.ts`, `stereo.ts` |
| Scene and flight | `src/scene/terrain.ts`, `landscape.ts`, `ship.ts`, `shipRender.ts`, `flock.ts`, `trails.ts`, `mood.ts` |
| Cinematography | `src/camera/director.ts`, `update.ts`, `modes.ts`, `rhyme.ts`, `orbit.ts` |
| UI and preferences | `src/ui/`, `src/input/keys.ts`, `index.html`, `src/style.css` |
| Regression checks | `tests/*.test.mjs` |

Chrome/Edge support the full source flow. Tab-audio capture and speech recognition depend on browser/platform support. File playback works independently of speech recognition and offline analysis.

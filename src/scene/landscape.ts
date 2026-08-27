// Front-row synthesis: turns the spectrum into a place rather than a plot.
//
// Each new row of the height grid is a blend of two readings of the audio:
//   spectrogram — the FFT folded about the centre (bass in the middle, highs
//                 at both edges) so the flock flies along a spine, not beside
//                 a wall;
//   landscape   — a sum of noise layers whose *spatial scale* follows the
//                 audio's *frequency*: bass drives broad swells, mids drive
//                 ridges, highs drive fine texture. Sampled in world units
//                 against distance travelled, so features are isotropic and
//                 scroll past as real geography would.
// Under both sits a slow per-column geology — the land the song has built:
// it rises under loud passages and erodes through quiet ones — and the whole
// layout meanders left and right with low-frequency noise and the spectral
// centroid, so the valley winds rather than running dead straight.
//
// TERRAIN_SPECTRUM_MIX dials between the two readings.

import {
  COLS, ROWS, WIDTH, HEIGHT_SCALE, NOISE_AMP, TERRAIN_ROW_SPACING,
  TERRAIN_ROW_BLEND, TERRAIN_SWELL,
  TERRAIN_SPECTRUM_MIX, TERRAIN_BAND_WAVELENGTHS, TERRAIN_BAND_GAINS,
  TERRAIN_BAND_MAX_MEMORY_S, TERRAIN_GEO_WEIGHT, TERRAIN_GEO_RISE_S, TERRAIN_GEO_FALL_S,
  TERRAIN_MEANDER_AMP, TERRAIN_MEANDER_WAVELENGTH, TERRAIN_CENTROID_MEANDER,
} from '../constants.ts';
import { sampleLogBin, type Terrain } from './terrain.ts';

export type Landscape = {
  /** World distance the landscape has travelled — the Z axis of the noise field. */
  travel: number;
  /** Slow per-column base elevation (u). */
  geo: Float32Array;
  /** Self-calibrating band ceilings (bass, mid, high). */
  bandMax: [number, number, number];
  /** Smoothed band energies, 0..1 of their ceilings. */
  bands: [number, number, number];
  centroid: number;
  meander: number;
  raw: Float32Array;
  /** Scratch: this frame's finished row profile. */
  shaped: Float32Array;
};

export function createLandscape(): Landscape {
  return {
    travel: 0,
    geo: new Float32Array(COLS),
    bandMax: [0.2, 0.1, 0.05],
    bands: [0, 0, 0],
    centroid: 0.5,
    meander: 0,
    raw: new Float32Array(COLS),
    shaped: new Float32Array(COLS),
  };
}

export type LandscapeInput = {
  fftBins: Uint8Array | null;
  dt: number;
  time: number;
  intensity: number;
  centroid: number;
};

// FFT bin ranges (fftSize 1024 → 43 Hz per bin): bass 40–860 Hz, mids
// 0.86–6.5 kHz, highs 6.5–17 kHz.
const BAND_BINS: [number, number][] = [[1, 20], [20, 150], [150, 400]];

function bandMean(bins: Uint8Array, lo: number, hi: number): number {
  let s = 0;
  const h = Math.min(hi, bins.length);
  for (let i = lo; i < h; i++) s += bins[i];
  return s / ((h - lo) * 255);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Write this frame's row profile into the front of `heights`. Called once
 * per frame; `rows` is how many rows the flow advanced (and the caller
 * shifted) this frame — usually 1, 0 on a display faster than the row rate
 * (the front row is simply refreshed from the live spectrum), more after a
 * dropped frame, in which case the same profile fills every new row. The
 * time-based state (band envelopes, meander, geology) advances by `dt`
 * exactly once regardless.
 */
export function writeLandscapeRow(
  ls: Landscape,
  terrain: Terrain,
  heights: Float32Array,
  input: LandscapeInput,
  rows: number,
): void {
  const { fftBins, dt, time, intensity } = input;
  const { noise3, binMap } = terrain;
  ls.travel += TERRAIN_ROW_SPACING * rows;
  const firstRow = ROWS - Math.max(1, rows);

  if (!fftBins) {
    // Idle: a low, slow noise floor.
    for (let ix = 0; ix < COLS; ix++) {
      ls.shaped[ix] = (noise3(ix * 0.08, time * 0.25, 0) * 0.5 + 0.5) * NOISE_AMP * 4;
    }
    for (let iy = firstRow; iy < ROWS; iy++) heights.set(ls.shaped, iy * COLS);
    for (let ix = 0; ix < COLS; ix++) ls.geo[ix] *= 1 - dt / TERRAIN_GEO_FALL_S;
    return;
  }

  // ----- band energies, self-calibrated -----
  for (let b = 0; b < 3; b++) {
    const [lo, hi] = BAND_BINS[b];
    const raw = Math.pow(bandMean(fftBins, lo, hi), 0.8);
    ls.bandMax[b] = Math.max(raw, 0.02, ls.bandMax[b] * Math.exp(-dt / TERRAIN_BAND_MAX_MEMORY_S));
    const norm = Math.min(1, raw / ls.bandMax[b]);
    // fast attack, ~0.3 s release
    const k = norm > ls.bands[b] ? 1 - Math.exp(-dt / 0.05) : 1 - Math.exp(-dt / 0.3);
    ls.bands[b] += (norm - ls.bands[b]) * k;
  }
  ls.centroid += (input.centroid - ls.centroid) * (1 - Math.exp(-dt / 1.5));

  // ----- meander: where the spine sits this row -----
  const meanderTarget =
    noise3(ls.travel / TERRAIN_MEANDER_WAVELENGTH, 3.3, 0) * TERRAIN_MEANDER_AMP
    + (ls.centroid - 0.5) * 2 * TERRAIN_CENTROID_MEANDER;
  ls.meander += (meanderTarget - ls.meander) * (1 - Math.exp(-dt / 2));

  const [bass, mid, high] = ls.bands;
  const [lamB, lamM, lamH] = TERRAIN_BAND_WAVELENGTHS;
  const [gB, gM, gH] = TERRAIN_BAND_GAINS;
  const gainNorm = gB + gM + gH;
  const z = ls.travel;
  const raw = ls.raw;

  for (let ix = 0; ix < COLS; ix++) {
    const xw = (ix / (COLS - 1) - 0.5) * WIDTH;
    const xm = xw - ls.meander; // spine-relative

    // Folded spectrogram: distance from the spine → frequency.
    const u = clamp(Math.abs(xm) / (WIDTH * 0.5), 0, 1);
    const fbin = binMap[Math.round(u * (COLS - 1))];
    const spec = Math.pow(sampleLogBin(fftBins, fbin) / 255, 0.85);

    // Landscape layers: band energy × noise at that band's spatial scale.
    const nb = noise3(xm / lamB, z / lamB, 1.1) * 0.5 + 0.5;
    // Ridged noise for the mids — crests, not bumps — is what makes it mountains.
    const nmRaw = 1 - Math.abs(noise3(xm / lamM, z / lamM, 4.7));
    const nm = nmRaw * nmRaw;
    const nh = noise3(xm / lamH, z / lamH, 8.2) * 0.5 + 0.5;
    const land = (bass * nb * gB + mid * nm * gM + high * nh * gH) / gainNorm;

    // Geology: the land the song has built so far, per column.
    const geoTarget = land * HEIGHT_SCALE * TERRAIN_GEO_WEIGHT;
    const gk = geoTarget > ls.geo[ix]
      ? 1 - Math.exp(-dt / TERRAIN_GEO_RISE_S)
      : 1 - Math.exp(-dt / TERRAIN_GEO_FALL_S);
    ls.geo[ix] += (geoTarget - ls.geo[ix]) * gk;

    const mixed = TERRAIN_SPECTRUM_MIX * spec + (1 - TERRAIN_SPECTRUM_MIX) * land;
    raw[ix] = mixed * HEIGHT_SCALE + ls.geo[ix];
  }

  // Cross-column blur rounds spikes into ridges; the slow swell rolls
  // underneath.
  const shaped = ls.shaped;
  for (let ix = 0; ix < COLS; ix++) {
    const l = raw[Math.max(0, ix - 1)];
    const r = raw[Math.min(COLS - 1, ix + 1)];
    const n = noise3(ix * 0.08, time * 0.35, 0) * NOISE_AMP;
    const swell = (noise3(ix * 0.018, time * 0.12, 7) * 0.5 + 0.5) * TERRAIN_SWELL * intensity;
    shaped[ix] = (l + 2 * raw[ix] + r) * 0.25 + n + swell;
  }
  // The temporal blend with the row behind lets a transient rise over a
  // few rows rather than stepping up at once.
  for (let iy = firstRow; iy < ROWS; iy++) {
    const base = iy * COLS;
    const prev = base - COLS;
    for (let ix = 0; ix < COLS; ix++) {
      const h = heights[prev + ix];
      heights[base + ix] = h + (shaped[ix] - h) * TERRAIN_ROW_BLEND;
    }
  }
}

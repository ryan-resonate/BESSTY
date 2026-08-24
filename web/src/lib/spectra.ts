// Catalog spectra: projecting a stored mode onto the solver's band system.
//
// Split out of `catalog.ts` for the same reason `catalogDims` was: this is pure
// arithmetic over data already in hand, but `catalog.ts` reaches Firestore at
// module load, so anything importing it — the curtailment model, a unit test —
// dragged the whole Firebase SDK along and could not run under `node:test`.
//
// Nothing here touches a store. `catalog.ts` re-exports all of it, so every
// existing `from './catalog'` import keeps working.

import type { CatalogEntry, CatalogModeData } from './types';
import { exactCentreHz, weightingAt } from './weighting';

/// Derive a per-band Lw spectrum from a catalog entry + mode + project wind
/// speed, projecting onto the solver's chosen band system.
///
///   - octave + octave source             → energy-snap to standard octave centres
///   - octave + third-octave source       → sum each octave's 3 child thirds
///   - third-octave + third-octave source → energy-snap to standard 1/3-oct centres
///   - third-octave + octave source       → distribute each octave's energy
///                                          equally across its 3 children
///                                          (lp_third = lp_oct − 10 log10(3))
export function spectrumFor(
  entry: CatalogEntry,
  modeName: string,
  windSpeed: number,
  bandSystem: 'octave' | 'oneThirdOctave',
): Float64Array {
  // NOTE the fallback: an unrecognised name silently becomes the FIRST mode.
  // That is why `lib/modes.ts` owns override resolution and a wiring test
  // guards every call site — see the note at the top of that file. Callers that
  // already hold the mode itself should use `spectrumForMode` and skip the
  // name lookup entirely.
  const mode = entry.modes.find((m) => m.name === modeName) ?? entry.modes[0];
  if (!mode) return new Float64Array(bandSystem === 'octave' ? OCTAVE_CENTRES.length : THIRD_OCT_CENTRES.length);
  return spectrumForMode(mode, bandSystem, windSpeed);
}

/// The same projection, for a caller that already has the mode object.
///
/// Preferred wherever the mode came from `entry.modes` rather than from a
/// stored override: there is no name to be wrong, so the silent
/// first-mode fallback above cannot happen at all.
export function spectrumForMode(
  mode: CatalogModeData,
  bandSystem: 'octave' | 'oneThirdOctave',
  windSpeed: number,
): Float64Array {

  // Pull the raw per-band Lw values for the requested wind speed, then
  // un-weight if the catalog mode is stored in A-weighted form. The WASM
  // solver always works in Z (un-weighted) per-band space — see the
  // A-weighting note in `lib/solver.ts`.
  const rawLevels = pickWindSpeed(mode, windSpeed);
  const sourceLevels = (mode.weighting === 'A')
    ? unweightFromA(mode.frequencies, rawLevels)
    : rawLevels;

  if (bandSystem === 'octave') {
    if (mode.bandSystem === 'octave') {
      return snapToCentres(mode.frequencies, sourceLevels, OCTAVE_CENTRES, octaveBand);
    }
    return foldThirdsToOctave(mode.frequencies, sourceLevels);
  }

  if (mode.bandSystem === 'oneThirdOctave') {
    return snapToCentres(mode.frequencies, sourceLevels, THIRD_OCT_CENTRES, thirdOctaveBand);
  }
  return distributeOctavesToThirds(mode.frequencies, sourceLevels);
}

/// Convert per-band LwA values to Lw (un-weighted) by subtracting the
/// IEC 61672-1 A-weighting offset for each band's centre frequency. The
/// inverse of "apply A-weighting" — at 1 kHz nothing changes (offset 0);
/// at the 16 Hz band a value of 49.2 dBA becomes 49.2 - (-56.7) = 105.9 dB
/// un-weighted (much higher because A-weighting heavily suppresses LF).
function unweightFromA(frequencies: number[], lwA: number[]): number[] {
  const out: number[] = new Array(lwA.length);
  for (let i = 0; i < lwA.length; i++) {
    const f = frequencies[i];
    const aw = aWeightingAt(f);
    out[i] = lwA[i] - aw;
  }
  return out;
}

/// A-weighting for a catalog band, at the band's EXACT centre frequency.
///
/// A catalog frequency is a nominal LABEL — "16 Hz" names the band centred on
/// 15.85 Hz — and the solver weights that band at its exact centre. Un-weighting
/// the input at the label while re-weighting the output at the centre leaves a
/// residue of up to 0.27 dB in the bottom band that never cancels: the round
/// trip has to use the same frequency in both directions.
///
/// Negligible under A-weighting, where the bottom bands are suppressed by 50 dB
/// anyway — but dB(Z) and dB(C) are selectable now, and neither suppresses them.
function aWeightingAt(nominalHz: number): number {
  return weightingAt(exactCentreHz(nominalHz), 'A');
}

/// Overall (single-figure) sound power from a per-band spectrum, returned as
/// both A-weighted dB(A) and un-weighted dB. `weighting` says whether the
/// stored per-band values are ALREADY A-weighted ('A') or un-weighted ('Z'):
///   - 'Z': band A-level = Lw_band + A(f); overall dB(A) is the energy sum of
///          those; overall Z is the energy sum of the raw bands.
///   - 'A': the stored bands ARE the A-levels (energy-sum them directly for
///          dB(A)); subtract A(f) to recover the Z bands for the overall Z.
/// Bands that are non-finite or <= 0 are treated as "unset" and skipped (the
/// same convention the solver uses for catalog spectra), so an empty 0-cell
/// doesn't drag the total down to a 0 dB floor.
export function overallLwFromBands(
  frequencies: number[],
  levels: number[],
  weighting: 'A' | 'Z',
): { dbA: number; dbZ: number } {
  let energyA = 0;
  let energyZ = 0;
  const n = Math.min(frequencies.length, levels.length);
  for (let i = 0; i < n; i++) {
    const lv = levels[i];
    if (lv == null || !Number.isFinite(lv) || lv <= 0) continue;
    const aw = aWeightingAt(frequencies[i]);
    const lz = weighting === 'A' ? lv - aw : lv;   // un-weighted band level
    const la = weighting === 'A' ? lv : lv + aw;   // A-weighted band level
    energyZ += Math.pow(10, lz / 10);
    energyA += Math.pow(10, la / 10);
  }
  return {
    dbA: energyA > 0 ? 10 * Math.log10(energyA) : 0,
    dbZ: energyZ > 0 ? 10 * Math.log10(energyZ) : 0,
  };
}

/// Backwards-compatible alias for the original octave-only API.
export function octaveSpectrumFor(
  entry: CatalogEntry,
  modeName: string,
  windSpeed: number,
): Float64Array {
  return spectrumFor(entry, modeName, windSpeed, 'octave');
}

/// Linear-interpolate (in dB) the spectrum at the requested wind speed.
function pickWindSpeed(mode: { spectra: Record<string, number[]>; windSpeeds?: number[] }, ws: number): number[] {
  if (!mode.windSpeeds || mode.windSpeeds.length === 0) {
    // Wind-independent (BESS / Aux): single 'broadband' key.
    const k = Object.keys(mode.spectra)[0];
    return mode.spectra[k] ?? [];
  }
  const sorted = mode.windSpeeds.slice().sort((a, b) => a - b);
  if (ws <= sorted[0]) return mode.spectra[String(sorted[0])] ?? [];
  if (ws >= sorted[sorted.length - 1]) return mode.spectra[String(sorted[sorted.length - 1])] ?? [];
  for (let i = 1; i < sorted.length; i++) {
    if (ws <= sorted[i]) {
      const lo = sorted[i - 1];
      const hi = sorted[i];
      const t = (ws - lo) / (hi - lo);
      const a = mode.spectra[String(lo)] ?? [];
      const b = mode.spectra[String(hi)] ?? [];
      const out: number[] = [];
      for (let j = 0; j < a.length; j++) out.push(a[j] + (b[j] - a[j]) * t);
      return out;
    }
  }
  return [];
}

/// 10 octave-band centres matching the solver (16 Hz – 8 kHz).
const OCTAVE_CENTRES = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];
/// 31 one-third octave centres (10 Hz – 10 kHz).
const THIRD_OCT_CENTRES = [
  10, 12.5, 16, 20, 25, 31.5, 40,
  50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
  500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000,
];

function octaveBand(f: number, centre: number): boolean {
  const lo = centre / Math.SQRT2;
  const hi = centre * Math.SQRT2;
  return f >= lo && f < hi;
}
function thirdOctaveBand(f: number, centre: number): boolean {
  // ratio is 10^(1/20) ≈ 1.122 each side of centre.
  const lo = centre / Math.pow(10, 1 / 20);
  const hi = centre * Math.pow(10, 1 / 20);
  return f >= lo && f < hi;
}

function snapToCentres(
  frequencies: number[],
  levels: number[],
  centres: number[],
  inBand: (f: number, c: number) => boolean,
): Float64Array {
  const out = new Float64Array(centres.length);
  for (let i = 0; i < centres.length; i++) {
    let energy = 0;
    for (let j = 0; j < frequencies.length; j++) {
      if (!inBand(frequencies[j], centres[i])) continue;
      const lp = levels[j];
      if (lp == null || !isFinite(lp) || lp <= 0) continue;
      energy += Math.pow(10, lp / 10);
    }
    out[i] = energy > 0 ? 10 * Math.log10(energy) : 0;
  }
  return out;
}

function foldThirdsToOctave(frequencies: number[], levels: number[]): Float64Array {
  return snapToCentres(frequencies, levels, OCTAVE_CENTRES, octaveBand);
}

/// Octave-band Lw distributed equally (in linear energy) across each octave's
/// three child third-octaves: each child receives `lw - 10·log10(3)` ≈ lw − 4.77 dB.
function distributeOctavesToThirds(frequencies: number[], levels: number[]): Float64Array {
  const out = new Float64Array(THIRD_OCT_CENTRES.length);
  const split = -10 * Math.log10(3);
  for (let i = 0; i < THIRD_OCT_CENTRES.length; i++) {
    const t = THIRD_OCT_CENTRES[i];
    // Find the source octave that contains this third-octave.
    let energy = 0;
    for (let j = 0; j < frequencies.length; j++) {
      if (!octaveBand(t, frequencies[j])) continue;
      const lp = levels[j];
      if (lp == null || !isFinite(lp) || lp <= 0) continue;
      energy += Math.pow(10, (lp + split) / 10);
    }
    out[i] = energy > 0 ? 10 * Math.log10(energy) : 0;
  }
  return out;
}

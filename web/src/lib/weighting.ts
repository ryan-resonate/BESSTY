// Frequency weighting for the assessment level.
//
// The solver works entirely in Z-weighted (un-weighted) per-band space; the
// weighting is applied here, at sum time. That was already true of A-weighting,
// but the offsets were written out by hand in three separate modules — and had
// already drifted apart: the exporters carried -56.4 dB at 16 Hz where the
// other two, correctly, carried -56.7. One number, three copies, two answers.
//
// So the curves are COMPUTED from the IEC 61672-1 pole frequencies rather than
// tabulated. That is exact at any centre frequency, it makes the normalisation
// explicit instead of a magic 2.00 dB constant, and there is nowhere left for a
// fourth copy to disagree.

import type { BandSystem } from './types';

export type Weighting = 'A' | 'C' | 'Z';

/// Nominal band centres, matching what the Rust crate emits.
export const OCTAVE_CENTRES_HZ = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];
export const THIRD_OCTAVE_CENTRES_HZ = [
  10, 12.5, 16, 20, 25, 31.5, 40,
  50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
  500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
  4000, 5000, 6300, 8000, 10000,
];

export function centresFor(bs: BandSystem): number[] {
  return bs === 'oneThirdOctave' ? THIRD_OCTAVE_CENTRES_HZ : OCTAVE_CENTRES_HZ;
}

/// EXACT midband frequency for a band, per IEC 61260: `10^(n/10)`.
///
/// The nominal figures above are labels — "16 Hz" is really 15.849 Hz — and the
/// weightings in IEC 61672-1's table are evaluated at the exact centres, not the
/// labels. The difference matters most where the curve is steepest: at the
/// bottom band it is 0.3 dB, which is precisely the discrepancy between the
/// app's old hand-written copies. Weighting therefore uses these; everything
/// user-facing keeps the nominal labels.
export function exactCentreHz(nominal: number): number {
  // Recover the band index from the nominal label, then rebuild the exact
  // centre from it. Rounding to the nearest index is what absorbs the label's
  // own approximation (12.5 for 12.589, 31.5 for 31.623, …).
  const n = Math.round(10 * Math.log10(nominal));
  return Math.pow(10, n / 10);
}

export function exactCentresFor(bs: BandSystem): number[] {
  return centresFor(bs).map(exactCentreHz);
}

// IEC 61672-1 pole frequencies (Hz).
const F1 = 20.598997;
const F2 = 107.65265;
const F3 = 737.86223;
const F4 = 12194.217;

/// Un-normalised A response in dB.
function aRaw(f: number): number {
  const f2 = f * f;
  const num = F4 * F4 * f2 * f2;
  const den = (f2 + F1 * F1)
    * Math.sqrt((f2 + F2 * F2) * (f2 + F3 * F3))
    * (f2 + F4 * F4);
  return 20 * Math.log10(num / den);
}

/// Un-normalised C response in dB.
function cRaw(f: number): number {
  const f2 = f * f;
  const num = F4 * F4 * f2;
  const den = (f2 + F1 * F1) * (f2 + F4 * F4);
  return 20 * Math.log10(num / den);
}

// Both curves are defined to pass through 0 dB at 1 kHz. Deriving the offset
// rather than hard-coding the published 2.00 / 0.06 dB keeps it exact.
const A_NORM = -aRaw(1000);
const C_NORM = -cRaw(1000);

/// Weighting offset at one frequency, in dB. Z is flat by definition.
export function weightingAt(f: number, weighting: Weighting): number {
  if (weighting === 'Z') return 0;
  if (!(f > 0)) return -Infinity;              // DC has no weighted level
  return weighting === 'A' ? aRaw(f) + A_NORM : cRaw(f) + C_NORM;
}

/// Per-band offsets for a band system, cached: this is called once per solve
/// per receiver, and recomputing 31 logarithms each time is pure waste.
const cache = new Map<string, Float64Array>();

export function weightsFor(bs: BandSystem, weighting: Weighting): Float64Array {
  const key = `${bs}:${weighting}`;
  let w = cache.get(key);
  if (!w) {
    w = Float64Array.from(exactCentresFor(bs).map((f) => weightingAt(f, weighting)));
    cache.set(key, w);
  }
  return w;
}

/// Energy-sum per-band levels into one weighted total.
///
/// `dOmegaDb` is the project's solid-angle correction, added per band before
/// the sum exactly as the callers did when each held its own copy of this.
/// Returns -Infinity for an all-empty spectrum, which the callers already treat
/// as "nothing here".
export function weightedTotal(
  perBandLp: ArrayLike<number>,
  weights: ArrayLike<number>,
  dOmegaDb = 0,
): number {
  // A LENGTH MISMATCH IS A BUG, NOT A CASE TO HANDLE. Truncating to the shorter
  // array silently pairs the wrong frequencies: a 10-band octave spectrum fed
  // third-octave weights got the 10 Hz–80 Hz offsets applied to its 16 Hz–8 kHz
  // levels, and exported 27 dB low without a word. Returning NaN makes the
  // mistake visible at the point it happens.
  if (perBandLp.length !== weights.length) {
    if (perBandLp.length === 0) return -Infinity;
    // eslint-disable-next-line no-console
    console.error(
      `weightedTotal: ${perBandLp.length} bands against ${weights.length} weights — `
      + 'the spectrum and the band system disagree.',
    );
    return NaN;
  }
  let sum = 0;
  for (let i = 0; i < perBandLp.length; i++) {
    const v = perBandLp[i];
    if (Number.isFinite(v)) sum += Math.pow(10, (v + weights[i] + dOmegaDb) / 10);
  }
  return sum > 0 ? 10 * Math.log10(sum) : -Infinity;
}

/// How a level in this weighting is written: `dB(A)`, `dB(C)`, `dB(Z)`.
export function weightingLabel(weighting: Weighting): string {
  return `dB(${weighting})`;
}

/// The assessment weighting a project uses. Absent ⇒ `'A'`, which is what every
/// project computed with before the setting existed.
export function weightingFor(project: {
  settings?: { assessment?: { weighting?: Weighting } };
}): Weighting {
  const w = project.settings?.assessment?.weighting;
  return w === 'C' || w === 'Z' ? w : 'A';
}

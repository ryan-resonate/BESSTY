// Tonality screening at the receiver.
//
// Screened on the RECEIVED spectrum, not the source's. Air absorption reshapes
// a spectrum with distance — an 8 kHz tone that stands 10 dB proud at 50 m is
// buried by 2 km — so a tone flagged in a catalog entry says nothing about
// whether anyone will hear one at a dwelling. The received per-band Lp is what
// the assessment is about, and it is already computed.
//
// The band levels used are the solver's own Z-weighted ones. Tonal prominence
// is a property of the physical spectrum; applying a weighting first would tilt
// the comparison between neighbouring bands, and most where the curve is
// steepest, which is exactly the low-frequency region the 15 dB criterion
// covers.
//
// Methods are a closed union with one entry today. Adding another is a new
// member plus a function in METHODS — nothing else changes, including the UI,
// which renders the registry.

import { centresFor, type Weighting } from './weighting';
import type { BandSystem } from './types';

/// Method ids are stable storage keys, so this one keeps its name even though
/// the label around it has been corrected.
export type TonalityMethod = 'iso1996-2-annexJ';

export const DEFAULT_TONALITY_METHOD: TonalityMethod = 'iso1996-2-annexJ';

/// One band that stands proud of its neighbours.
export interface TonalBand {
  index: number;
  centreHz: number;
  /// How far above the LOUDER usable neighbour it sits.
  excessDb: number;
  /// What it had to exceed them by to count.
  thresholdDb: number;
  /// True when only ONE neighbour was available — the top and bottom bands of
  /// the spectrum, or a band beside an empty one. Such a band is reported as a
  /// CANDIDATE, never as a confirmed tone: with nothing above it, a genuine
  /// tone and a spectrum still rising at the edge look identical, and calling
  /// either way would be inventing a verdict. It does not attract a penalty.
  oneSided: boolean;
}

export interface TonalityResult {
  /// False when the method cannot be applied at all — at octave resolution
  /// there are no adjacent bands to compare against in any meaningful sense.
  assessable: boolean;
  /// Why not, when `assessable` is false. Shown to the user verbatim.
  reason?: string;
  /// A tone was CONFIRMED: some band stood proud of neighbours on both sides.
  /// Only this drives the penalty.
  tonal: boolean;
  /// Confirmed tones.
  bands: TonalBand[];
  /// Edge bands that met the criterion against their single neighbour. Worth
  /// surfacing — a BESS inverter's switching tone often lands in the top
  /// third-octave — but not worth penalising on one-sided evidence.
  candidates: TonalBand[];
}

export interface TonalityMethodInfo {
  id: TonalityMethod;
  label: string;
  /// One line for the Settings dropdown's hint.
  summary: string;
}

/// The adjacent-band excess a band must show to count as tonal, by frequency.
///
/// ISO 1996-2 Annex J's simplified screen: the ear resolves a tone against
/// broadband noise less readily at low frequency, so the bar is set higher
/// there.
function simplifiedThreshold(centreHz: number): number {
  if (centreHz < 160) return 15;          // 25–125 Hz
  if (centreHz < 500) return 8;           // 160–400 Hz
  return 5;                               // 500 Hz and above
}

/// The method is stated over 25 Hz – 10 kHz. Below 25 Hz it says nothing, so
/// neither do we: applying the 15 dB bar to 10/12.5/20 Hz would be inventing
/// coverage the standard does not give.
const LOWEST_SCREENED_HZ = 25;

function screenSimplified(perBandLp: ArrayLike<number>, centres: number[]): TonalBand[] {
  const out: TonalBand[] = [];
  for (let i = 0; i < centres.length; i++) {
    if (centres[i] < LOWEST_SCREENED_HZ) continue;
    const lv = perBandLp[i];
    if (!Number.isFinite(lv)) continue;
    // The two END bands have only one neighbour. Skipping them entirely was
    // wrong in a way that mattered: a BESS inverter's switching tone often
    // lands in the top third-octave, and the screen was reporting "no tones"
    // rather than admitting it had not looked. Judged one-sided instead, which
    // is all the data supports and is still a real test.
    const neighbours = [perBandLp[i - 1], perBandLp[i + 1]]
      .filter((v) => v !== undefined && Number.isFinite(v)) as number[];
    if (neighbours.length === 0) continue;
    // Measured against the LOUDER neighbour: exceeding only the quieter one is
    // a slope, not a peak.
    const excess = lv - Math.max(...neighbours);
    const threshold = simplifiedThreshold(centres[i]);
    if (excess >= threshold) {
      out.push({
        index: i, centreHz: centres[i], excessDb: excess, thresholdDb: threshold,
        oneSided: neighbours.length < 2,
      });
    }
  }
  return out;
}

const METHODS: Record<TonalityMethod, {
  info: TonalityMethodInfo;
  run(perBandLp: ArrayLike<number>, centres: number[]): TonalBand[];
}> = {
  'iso1996-2-annexJ': {
    info: {
      // Deliberately NOT citing an annex letter. The test itself is the
      // standard's simplified / survey method and the thresholds are right, but
      // the letter moved between editions (and differs from the reference
      // narrowband method), and this string reaches client-facing exports.
      // Confirm against the controlled copy before adding a citation.
      id: 'iso1996-2-annexJ',
      label: 'ISO 1996-2 simplified (constant difference)',
      summary: 'A one-third-octave band standing 15 dB (25–125 Hz), 8 dB '
        + '(160–400 Hz) or 5 dB (500 Hz and above) above its neighbours.',
    },
    run: screenSimplified,
  },
};

export function tonalityMethods(): TonalityMethodInfo[] {
  return Object.values(METHODS).map((m) => m.info);
}

export function tonalityMethodInfo(id: TonalityMethod): TonalityMethodInfo {
  return METHODS[id]?.info ?? METHODS[DEFAULT_TONALITY_METHOD].info;
}

/// Run the screen over one receiver's received spectrum.
export function screenTonality(
  perBandLp: ArrayLike<number> | null | undefined,
  bandSystem: BandSystem,
  method: TonalityMethod = DEFAULT_TONALITY_METHOD,
): TonalityResult {
  if (bandSystem !== 'oneThirdOctave') {
    return {
      assessable: false,
      // Said plainly rather than reported as "no tones found": at octave
      // resolution a tone is smeared across a whole band, so a clean result
      // would be a claim the data cannot support.
      reason: 'Tonality needs one-third-octave resolution — switch the band system in Settings.',
      tonal: false,
      bands: [],
      candidates: [],
    };
  }
  if (!perBandLp || perBandLp.length < 3) {
    return {
      assessable: false, reason: 'No spectrum at this receiver yet.',
      tonal: false, bands: [], candidates: [],
    };
  }
  const impl = METHODS[method] ?? METHODS[DEFAULT_TONALITY_METHOD];
  const found = impl.run(perBandLp, centresFor(bandSystem));
  const bands = found.filter((b) => !b.oneSided);
  const candidates = found.filter((b) => b.oneSided);
  return { assessable: true, tonal: bands.length > 0, bands, candidates };
}

/// The penalty to add to a receiver's level, given the screen and the settings.
/// Zero unless the user has switched the penalty on AND a tone was found.
export function tonalityPenaltyDb(
  result: TonalityResult,
  settings: { applyPenalty?: boolean; penaltyDb?: number } | undefined,
): number {
  if (!settings?.applyPenalty || !result.assessable || !result.tonal) return 0;
  const db = settings.penaltyDb;
  return Number.isFinite(db) ? Math.max(0, db as number) : DEFAULT_TONALITY_PENALTY_DB;
}

export const DEFAULT_TONALITY_PENALTY_DB = 5;

/// Short human summary of the flagged bands, for a results row or a cell.
export function describeTonalBands(bands: TonalBand[]): string {
  if (!bands.length) return '';
  return bands
    .map((b) => `${formatBandHz(b.centreHz)} +${b.excessDb.toFixed(0)} dB${b.oneSided ? ' (edge band, unconfirmed)' : ''}`)
    .join(', ');
}

/// A band centre as a report writes it: `250 Hz`, `1 kHz`, `3.15 kHz`.
export function formatBandHz(hz: number): string {
  if (hz < 1000) return `${hz} Hz`;
  const k = hz / 1000;
  return `${Number.isInteger(k) ? k : k.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')} kHz`;
}

/// Assessment level = solved level + any tonality penalty. Kept here so the
/// results dock, the exports and the pass/fail test cannot disagree about what
/// is being compared with the limit.
export function assessmentLevel(levelDb: number | null, penaltyDb: number): number | null {
  if (levelDb == null || !Number.isFinite(levelDb)) return null;
  return levelDb + penaltyDb;
}

/// Settings shape, mirrored on `ProjectSettings.assessment.tonality`.
export interface TonalitySettings {
  method?: TonalityMethod;
  /// Default false: the screen reports, but nothing is added to the level
  /// unless the user asks for it.
  applyPenalty?: boolean;
  penaltyDb?: number;
}

export function tonalitySettingsFor(project: {
  settings?: { assessment?: { tonality?: TonalitySettings } };
}): Required<TonalitySettings> {
  const t = project.settings?.assessment?.tonality;
  return {
    method: t?.method && t.method in METHODS ? t.method : DEFAULT_TONALITY_METHOD,
    applyPenalty: t?.applyPenalty === true,
    penaltyDb: Number.isFinite(t?.penaltyDb) ? (t!.penaltyDb as number) : DEFAULT_TONALITY_PENALTY_DB,
  };
}

// Re-exported so callers that need both do not import two modules for one idea.
export type { Weighting };

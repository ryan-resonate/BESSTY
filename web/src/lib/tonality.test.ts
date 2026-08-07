// Tonality screening.
//
// The screen decides whether a receiver picks up a 5 dB penalty, so the cases
// that matter are the boundaries: exactly at the threshold, one band below it,
// a slope that is not a peak, and the frequency regions where the bar moves.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assessmentLevel, describeTonalBands, DEFAULT_TONALITY_PENALTY_DB, screenTonality,
  formatBandHz, tonalityMethodInfo, tonalityMethods, tonalityPenaltyDb, tonalitySettingsFor,
} from './tonality';
import { THIRD_OCTAVE_CENTRES_HZ } from './weighting';

/// A flat 60 dB third-octave spectrum, with named bands raised.
function spectrum(peaks: Record<number, number> = {}, floor = 60): Float64Array {
  const s = new Float64Array(31).fill(floor);
  for (const [hz, level] of Object.entries(peaks)) {
    const i = THIRD_OCTAVE_CENTRES_HZ.indexOf(Number(hz));
    assert.ok(i >= 0, `no band at ${hz} Hz`);
    s[i] = level;
  }
  return s;
}

// ---------- the frequency-dependent threshold ----------

test('a 1 kHz band needs 5 dB over its neighbours', () => {
  assert.equal(screenTonality(spectrum({ 1000: 64.9 }), 'oneThirdOctave').tonal, false);
  const at = screenTonality(spectrum({ 1000: 65 }), 'oneThirdOctave');
  assert.equal(at.tonal, true);
  assert.equal(at.bands[0].centreHz, 1000);
  assert.equal(at.bands[0].thresholdDb, 5);
  assert.ok(Math.abs(at.bands[0].excessDb - 5) < 1e-9);
});

test('a 250 Hz band needs 8 dB', () => {
  assert.equal(screenTonality(spectrum({ 250: 67.9 }), 'oneThirdOctave').tonal, false);
  assert.equal(screenTonality(spectrum({ 250: 68 }), 'oneThirdOctave').tonal, true);
});

test('a 50 Hz band needs 15 dB — a tone is harder to pick out down there', () => {
  assert.equal(screenTonality(spectrum({ 50: 74.9 }), 'oneThirdOctave').tonal, false);
  assert.equal(screenTonality(spectrum({ 50: 75 }), 'oneThirdOctave').tonal, true);
});

test('the thresholds change at the stated band boundaries', () => {
  // 125 Hz is still in the 15 dB region; 160 Hz is the first 8 dB band.
  assert.equal(screenTonality(spectrum({ 125: 70 }), 'oneThirdOctave').tonal, false);
  assert.equal(screenTonality(spectrum({ 160: 70 }), 'oneThirdOctave').tonal, true);
  // 400 Hz is the last 8 dB band; 500 Hz is the first 5 dB one.
  assert.equal(screenTonality(spectrum({ 400: 66 }), 'oneThirdOctave').tonal, false);
  assert.equal(screenTonality(spectrum({ 500: 66 }), 'oneThirdOctave').tonal, true);
});

// ---------- peak vs slope ----------

test('a rising slope is not a tone, however steep', () => {
  // Each band 10 dB above the one below it: every band beats its lower
  // neighbour by 10 dB and none of them is a peak.
  const s = new Float64Array(31);
  for (let i = 0; i < s.length; i++) s[i] = 10 + i * 10;
  assert.equal(screenTonality(s, 'oneThirdOctave').tonal, false);
});

test('the excess is measured against the LOUDER neighbour', () => {
  // 1 kHz sits 20 dB above the band below and 4 dB above the one above: it is
  // a shoulder on a falling spectrum, not a 20 dB tone.
  const s = spectrum({ 800: 45, 1000: 65, 1250: 61 });
  assert.equal(screenTonality(s, 'oneThirdOctave').tonal, false);
});

test('several tones are all reported, not just the first', () => {
  const r = screenTonality(spectrum({ 100: 80, 1000: 70, 4000: 70 }), 'oneThirdOctave');
  assert.deepEqual(r.bands.map((b) => b.centreHz), [100, 1000, 4000]);
});

// ---------- edges and bad input ----------

test('the end bands are not judged — they have only one neighbour', () => {
  const first = new Float64Array(31).fill(60);
  first[0] = 200;
  assert.equal(screenTonality(first, 'oneThirdOctave').tonal, false);
  const last = new Float64Array(31).fill(60);
  last[30] = 200;
  assert.equal(screenTonality(last, 'oneThirdOctave').tonal, false);
});

test('octave resolution reports NOT ASSESSABLE rather than "no tones"', () => {
  // A clean pass would be a claim the data cannot support: at octave width a
  // tone is smeared across the whole band.
  const r = screenTonality(new Float64Array(10).fill(60), 'octave');
  assert.equal(r.assessable, false);
  assert.equal(r.tonal, false);
  assert.match(r.reason ?? '', /one-third-octave/);
});

test('a missing spectrum is not assessable either', () => {
  assert.equal(screenTonality(null, 'oneThirdOctave').assessable, false);
  assert.equal(screenTonality(new Float64Array(2), 'oneThirdOctave').assessable, false);
});

test('non-finite bands are skipped rather than producing a phantom tone', () => {
  const s = spectrum({ 1000: 80 });
  s[19] = -Infinity;                       // the 800 Hz neighbour
  // With one neighbour unusable the band cannot be judged, so nothing is
  // claimed about it.
  assert.equal(screenTonality(s, 'oneThirdOctave').bands.some((b) => b.centreHz === 1000), false);
});

// ---------- penalty ----------

const flagged = () => screenTonality(spectrum({ 1000: 80 }), 'oneThirdOctave');

test('no penalty is applied unless the user switches it on', () => {
  assert.equal(flagged().tonal, true);
  assert.equal(tonalityPenaltyDb(flagged(), undefined), 0);
  assert.equal(tonalityPenaltyDb(flagged(), { applyPenalty: false, penaltyDb: 5 }), 0);
  assert.equal(tonalityPenaltyDb(flagged(), { applyPenalty: true, penaltyDb: 5 }), 5);
});

test('a clean or unassessable receiver never picks up a penalty', () => {
  const clean = screenTonality(spectrum(), 'oneThirdOctave');
  assert.equal(tonalityPenaltyDb(clean, { applyPenalty: true, penaltyDb: 5 }), 0);
  const octave = screenTonality(new Float64Array(10).fill(60), 'octave');
  assert.equal(tonalityPenaltyDb(octave, { applyPenalty: true, penaltyDb: 5 }), 0);
});

test('a missing or negative penalty falls back to the default', () => {
  assert.equal(tonalityPenaltyDb(flagged(), { applyPenalty: true }), DEFAULT_TONALITY_PENALTY_DB);
  assert.equal(tonalityPenaltyDb(flagged(), { applyPenalty: true, penaltyDb: -3 }), 0);
});

test('the assessment level is the solved level plus the penalty', () => {
  assert.equal(assessmentLevel(38.4, 5), 43.4);
  assert.equal(assessmentLevel(38.4, 0), 38.4);
  assert.equal(assessmentLevel(null, 5), null);
  assert.equal(assessmentLevel(-Infinity, 5), null);
});

// ---------- settings + registry ----------

test('settings default to the first method, penalty off, 5 dB', () => {
  const s = tonalitySettingsFor({});
  assert.equal(s.method, 'iso1996-2-annexJ');
  assert.equal(s.applyPenalty, false);
  assert.equal(s.penaltyDb, 5);
});

test('an unknown method falls back rather than screening with nothing', () => {
  const s = tonalitySettingsFor({
    settings: { assessment: { tonality: { method: 'made-up' as never } } },
  });
  assert.equal(s.method, 'iso1996-2-annexJ');
  // …and the screen still runs.
  assert.equal(screenTonality(spectrum({ 1000: 80 }), 'oneThirdOctave', s.method).tonal, true);
});

test('the method registry is what the UI renders, so it must not be empty', () => {
  const all = tonalityMethods();
  assert.ok(all.length >= 1);
  assert.equal(all[0].id, 'iso1996-2-annexJ');
  assert.ok(all[0].label.length > 0 && all[0].summary.length > 0);
  assert.equal(tonalityMethodInfo('iso1996-2-annexJ').id, 'iso1996-2-annexJ');
});

test('flagged bands describe themselves compactly', () => {
  const r = screenTonality(spectrum({ 100: 80, 4000: 70 }), 'oneThirdOctave');
  assert.equal(describeTonalBands(r.bands), '100 Hz +20 dB, 4 kHz +10 dB');
  assert.equal(describeTonalBands([]), '');
  // Band centres read as a report writes them.
  assert.equal(formatBandHz(250), '250 Hz');
  assert.equal(formatBandHz(1000), '1 kHz');
  assert.equal(formatBandHz(3150), '3.15 kHz');
  assert.equal(formatBandHz(10000), '10 kHz');
});

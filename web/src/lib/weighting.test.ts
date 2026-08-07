// Frequency weighting, against the published IEC 61672-1 values.
//
// The curves are computed from the pole frequencies rather than tabulated, so
// the thing worth checking is that they reproduce the table everyone else
// quotes — including the 16 Hz value where the app's three hand-written copies
// had already drifted apart.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  centresFor, exactCentresFor, OCTAVE_CENTRES_HZ, THIRD_OCTAVE_CENTRES_HZ, weightedTotal,
  weightingAt, weightingFor, weightingLabel, weightsFor,
} from './weighting';

/// IEC 61672-1 Table 3, A-weighting, listed against the nominal octave labels
/// but evaluated at the exact midband frequencies.
const A_OCTAVE = [-56.7, -39.4, -26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];

/// The same table's C-weighting.
const C_OCTAVE = [-8.5, -3.0, -0.8, -0.2, 0.0, 0.0, 0.0, -0.2, -0.8, -3.0];

test('the A curve reproduces the published octave table', () => {
  const w = weightsFor('octave', 'A');
  OCTAVE_CENTRES_HZ.forEach((f, i) => {
    assert.ok(
      Math.abs(w[i] - A_OCTAVE[i]) < 0.05,
      `${f} Hz: ${w[i].toFixed(2)} vs published ${A_OCTAVE[i]}`,
    );
  });
});

test('the C curve reproduces the published octave table', () => {
  const w = weightsFor('octave', 'C');
  OCTAVE_CENTRES_HZ.forEach((f, i) => {
    assert.ok(
      Math.abs(w[i] - C_OCTAVE[i]) < 0.05,
      `${f} Hz: ${w[i].toFixed(2)} vs published ${C_OCTAVE[i]}`,
    );
  });
});

test('the A curve reproduces the published third-octave table', () => {
  // The full 10 Hz – 10 kHz set, which is where a tonality screen lives.
  const published = [
    -70.4, -63.4, -56.7, -50.5, -44.7, -39.4, -34.6,
    -30.2, -26.2, -22.5, -19.1, -16.1, -13.4, -10.9, -8.6, -6.6, -4.8,
    -3.2, -1.9, -0.8, 0.0, 0.6, 1.0, 1.2, 1.3, 1.2,
    1.0, 0.5, -0.1, -1.1, -2.5,
  ];
  const w = weightsFor('oneThirdOctave', 'A');
  THIRD_OCTAVE_CENTRES_HZ.forEach((f, i) => {
    assert.ok(
      Math.abs(w[i] - published[i]) < 0.05,
      `${f} Hz: ${w[i].toFixed(2)} vs published ${published[i]}`,
    );
  });
});

test('weighting uses the EXACT band centre, which is what the tables tabulate', () => {
  // The nominal "16 Hz" band is really centred on 10^1.2 = 15.849 Hz, and the
  // published -56.7 dB is the value there. At the label itself the curve reads
  // -56.4 — which is exactly what the app's exporters had been using, while the
  // solver and grid used -56.7. Not a typo in either: two different frequencies.
  assert.ok(Math.abs(weightingAt(16, 'A') - -56.42) < 0.02, 'at the nominal label');
  assert.ok(Math.abs(weightingAt(15.8489, 'A') - -56.7) < 0.02, 'at the true centre');
  // The band weights must use the latter.
  assert.ok(Math.abs(weightsFor('octave', 'A')[0] - -56.7) < 0.02);
});

test('exact centres are recovered from the nominal labels', () => {
  const oct = exactCentresFor('octave');
  assert.ok(Math.abs(oct[0] - 15.8489) < 1e-3);
  assert.ok(Math.abs(oct[1] - 31.6228) < 1e-3);
  assert.equal(oct[6], 1000);
  const toc = exactCentresFor('oneThirdOctave');
  // 12.5 is the label for 12.589 — the rounding has to survive that.
  assert.ok(Math.abs(toc[1] - 12.5893) < 1e-3);
  assert.ok(Math.abs(toc[THIRD_OCTAVE_CENTRES_HZ.indexOf(3150)] - 3162.28) < 1e-2);
});

test('both curves pass through 0 dB at 1 kHz, by definition', () => {
  assert.ok(Math.abs(weightingAt(1000, 'A')) < 1e-9);
  assert.ok(Math.abs(weightingAt(1000, 'C')) < 1e-9);
});

test('Z is flat, so a Z total is a plain energy sum', () => {
  for (const f of THIRD_OCTAVE_CENTRES_HZ) assert.equal(weightingAt(f, 'Z'), 0);
  // Two equal bands sum to +3 dB with no weighting applied.
  const z = weightsFor('oneThirdOctave', 'Z');
  const bands = new Float64Array(31);
  bands.fill(-Infinity);
  bands[20] = 50;
  bands[21] = 50;
  assert.ok(Math.abs(weightedTotal(bands, z) - 53.01) < 0.01);
});

test('a third-octave A curve is consistent with the octave one at shared centres', () => {
  // 63 Hz appears in both systems and must weigh the same in each — the two
  // hand-written tables could not guarantee that.
  const oct = weightsFor('octave', 'A');
  const toc = weightsFor('oneThirdOctave', 'A');
  assert.equal(oct[OCTAVE_CENTRES_HZ.indexOf(63)], toc[THIRD_OCTAVE_CENTRES_HZ.indexOf(63)]);
  assert.equal(oct[OCTAVE_CENTRES_HZ.indexOf(1000)], toc[THIRD_OCTAVE_CENTRES_HZ.indexOf(1000)]);
});

test('weights are the right length for the band system', () => {
  assert.equal(weightsFor('octave', 'A').length, 10);
  assert.equal(weightsFor('oneThirdOctave', 'A').length, 31);
  assert.equal(centresFor('octave').length, 10);
  assert.equal(centresFor('oneThirdOctave').length, 31);
});

test('C reads higher than A on a low-frequency spectrum — the point of having it', () => {
  const bands = new Float64Array(10);
  bands.fill(-Infinity);
  bands[1] = 70;                                  // 31.5 Hz
  bands[2] = 70;                                  // 63 Hz
  const a = weightedTotal(bands, weightsFor('octave', 'A'));
  const c = weightedTotal(bands, weightsFor('octave', 'C'));
  assert.ok(c > a + 20, `C ${c.toFixed(1)} should far exceed A ${a.toFixed(1)}`);
});

test('the solid-angle correction shifts the total by exactly its own value', () => {
  const bands = new Float64Array(10).fill(50);
  const w = weightsFor('octave', 'A');
  assert.ok(Math.abs(weightedTotal(bands, w, 3) - (weightedTotal(bands, w) + 3)) < 1e-9);
});

test('an empty spectrum totals to -Infinity rather than 0 dB', () => {
  const bands = new Float64Array(10).fill(-Infinity);
  assert.equal(weightedTotal(bands, weightsFor('octave', 'A')), -Infinity);
  assert.equal(weightedTotal([], weightsFor('octave', 'A')), -Infinity);
});

test('non-finite bands are skipped, not treated as zero', () => {
  const bands = [50, NaN, -Infinity, 50];
  const flat = new Float64Array(4);
  assert.ok(Math.abs(weightedTotal(bands, flat) - 53.01) < 0.01);
});

test('the weighting is read off the project, defaulting to A', () => {
  assert.equal(weightingFor({}), 'A');
  assert.equal(weightingFor({ settings: {} }), 'A');
  assert.equal(weightingFor({ settings: { assessment: {} } }), 'A');
  assert.equal(weightingFor({ settings: { assessment: { weighting: 'C' } } }), 'C');
  assert.equal(weightingFor({ settings: { assessment: { weighting: 'Z' } } }), 'Z');
  // Anything unrecognised falls back rather than propagating.
  assert.equal(weightingFor({ settings: { assessment: { weighting: 'B' as never } } }), 'A');
});

test('labels read the way a report writes them', () => {
  assert.equal(weightingLabel('A'), 'dB(A)');
  assert.equal(weightingLabel('C'), 'dB(C)');
  assert.equal(weightingLabel('Z'), 'dB(Z)');
});

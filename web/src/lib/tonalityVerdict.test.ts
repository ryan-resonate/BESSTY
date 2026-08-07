// The tonality penalty where it actually bites: the pass/fail verdict.
//
// The screen and the penalty arithmetic are unit-tested next door. What this
// pins is the wiring — that a penalty computed once in the solve is the number
// every consumer judges, so a badge cannot read green beside a red export.

import test from 'node:test';
import assert from 'node:assert/strict';

import { assessedLevel, exceedsLimit } from './limits';
import { exportReceiversCsv } from './exporters';
import type { ReceiverResult } from './solver';
import type { Project } from './types';
import { screenTonality, tonalityPenaltyDb, tonalitySettingsFor } from './tonality';
import { THIRD_OCTAVE_CENTRES_HZ } from './weighting';

function projectWith(tonality: Record<string, unknown> | undefined): Project {
  return {
    schemaVersion: 1, name: 'T', description: '', createdAt: '', updatedAt: '', owner: 'x',
    scenario: { windSpeed: 10, windSpeedReferenceHeight: 10, period: 'night', bandSystem: 'oneThirdOctave' },
    sources: [], barriers: [],
    receivers: [{
      id: 'R1', name: 'R1', latLng: [-33.6, 138.7], heightAboveGroundM: 1.5,
      limitDayDbA: 40, limitEveningDbA: 40, limitNightDbA: 40,
    }],
    settings: {
      ground: { defaultG: 0.5 },
      annexD: {
        barrierAbarCapDb: 3, useElevatedSourceForBarrier: true,
        applyConcaveCorrection: true, wtReceiverHeightMin: 4,
      },
      general: { defaultReceiverHeight: 1.5 },
      limitComparison: 'exact',
      assessment: tonality ? { tonality } : undefined,
    } as Project['settings'],
  };
}

/// A spectrum with a clear 1 kHz tone whose A-weighted total sits just under
/// a 40 dB limit — so only the penalty can push it over.
function tonalSpectrum(): Float64Array {
  const s = new Float64Array(31).fill(-Infinity);
  const i1k = THIRD_OCTAVE_CENTRES_HZ.indexOf(1000);
  s[i1k - 1] = 20;
  s[i1k] = 38.5;
  s[i1k + 1] = 20;
  return s;
}

function resultFor(project: Project): ReceiverResult {
  const perBandLp = tonalSpectrum();
  const cfg = tonalitySettingsFor(project);
  const tonality = screenTonality(perBandLp, 'oneThirdOctave', cfg.method);
  const penalty = tonalityPenaltyDb(tonality, cfg);
  // 1 kHz weighs 0 dB in A, so the total is the band level itself.
  const total = 38.5;
  return {
    receiverId: 'R1', perBandLp, totalDbA: total,
    tonality, tonalityPenaltyDb: penalty, assessedDbA: total + penalty,
    perSource: [{ sourceId: 'S1', perBandLp }],
  };
}

test('with the penalty off, a tonal receiver still passes on its own level', () => {
  const project = projectWith(undefined);
  const r = resultFor(project);
  assert.equal(r.tonality?.tonal, true, 'the tone should still be REPORTED');
  assert.equal(r.tonalityPenaltyDb, 0);
  assert.equal(assessedLevel(r), 38.5);
  assert.equal(exceedsLimit(assessedLevel(r), 40, 'exact'), false);
});

test('switching the penalty on turns the same receiver red', () => {
  const project = projectWith({ applyPenalty: true, penaltyDb: 5 });
  const r = resultFor(project);
  assert.equal(r.tonalityPenaltyDb, 5);
  assert.equal(assessedLevel(r), 43.5);
  assert.equal(exceedsLimit(assessedLevel(r), 40, 'exact'), true);
});

test('the export agrees with the badge, and shows its working', async () => {
  const project = projectWith({ applyPenalty: true, penaltyDb: 5 });
  const csv = await exportReceiversCsv(project, [resultFor(project)]).text();
  const [header, row] = csv.trim().split(/\r?\n/);
  const cols = header.split(',');
  const vals = row.split(',');
  const get = (name: string) => vals[cols.indexOf(name)];

  assert.equal(get('total_dba'), '38.5', 'the solved level is reported as solved');
  assert.equal(get('tonal'), 'yes');
  assert.ok(get('tonal_bands').includes('1 kHz'), get('tonal_bands'));
  assert.equal(get('tonality_penalty_db'), '5');
  assert.equal(get('assessed_dba'), '43.5');
  // …and the verdict follows the ASSESSED level, not the solved one.
  assert.equal(get('pass_night'), 'fail');
});

test('with the penalty off the export passes and records no penalty', async () => {
  const project = projectWith(undefined);
  const csv = await exportReceiversCsv(project, [resultFor(project)]).text();
  const [header, row] = csv.trim().split(/\r?\n/);
  const cols = header.split(',');
  const vals = row.split(',');
  assert.equal(vals[cols.indexOf('tonal')], 'yes', 'still reported');
  assert.equal(vals[cols.indexOf('tonality_penalty_db')], '0');
  assert.equal(vals[cols.indexOf('pass_night')], 'pass');
});

test('a result from before tonality existed is judged on its own level', () => {
  // Old cached results have no `assessedDbA`; falling back to `totalDbA` is
  // what keeps them behaving exactly as they did.
  const legacy = { receiverId: 'R1', perBandLp: new Float64Array(31), totalDbA: 41, perSource: [] };
  assert.equal(assessedLevel(legacy), 41);
  assert.equal(exceedsLimit(assessedLevel(legacy), 40, 'exact'), true);
  assert.equal(assessedLevel(null), null);
  assert.equal(assessedLevel({ receiverId: 'x', totalDbA: -Infinity } as never), null);
});

// The receiver export reports all three periods.
//
// The screen shows one period (Q12), so the export is the only place a
// compliance table gets day, evening and night together. With per-period modes
// those are three different solves, and the two failures worth guarding are:
// judging all three against the ACTIVE period's level (night compliance
// reported from a daytime solve), and changing what the export looks like for
// the projects that never turn the feature on.

import test from 'node:test';
import assert from 'node:assert/strict';

import { exportReceiversCsv } from './exporters';
import type { ReceiverResult } from './solver';
import type { Period, Project } from './types';

const SPLIT_LINES = /\r?\n/;

function project(): Project {
  return {
    schemaVersion: 1, name: 'T', description: '', createdAt: '', updatedAt: '', owner: 'x',
    scenario: { windSpeed: 10, windSpeedReferenceHeight: 10, period: 'day', bandSystem: 'octave' },
    sources: [], barriers: [],
    receivers: [{
      id: 'R1', name: 'R1', latLng: [-33.6, 138.7], heightAboveGroundM: 1.5,
      limitDayDbA: 45, limitEveningDbA: 42, limitNightDbA: 35,
    }],
    settings: {
      ground: { defaultG: 0.5 },
      annexD: {
        barrierAbarCapDb: 3, useElevatedSourceForBarrier: true,
        applyConcaveCorrection: true, wtReceiverHeightMin: 4,
      },
      general: { defaultReceiverHeight: 1.5 },
      limitComparison: 'exact',
    } as Project['settings'],
  };
}

function resultAt(totalDbA: number): ReceiverResult[] {
  return [{
    receiverId: 'R1',
    perBandLp: new Float64Array(10).fill(30),
    totalDbA,
    perSource: [],
  }];
}

async function columns(p: Project, results: Parameters<typeof exportReceiversCsv>[1]) {
  const csv = await exportReceiversCsv(p, results).text();
  const [header, row] = csv.trim().split(SPLIT_LINES);
  const cols = header.split(',');
  const vals = row.split(',');
  return (name: string) => {
    const i = cols.indexOf(name);
    assert.ok(i >= 0, `no column "${name}" in ${header}`);
    return vals[i];
  };
}

test('one set of results fills all three period columns', async () => {
  // The collapse case, which is every project until someone turns per-period
  // modes on: the three columns repeat the single solved level, and the export
  // means exactly what it always meant.
  const get = await columns(project(), resultAt(41));
  assert.equal(get('level_day_dba'), '41');
  assert.equal(get('level_evening_dba'), '41');
  assert.equal(get('level_night_dba'), '41');
  // Limits still differ per period, so the verdicts still can.
  assert.equal(get('pass_day'), 'pass');       // 41 vs 45
  assert.equal(get('pass_evening'), 'pass');   // 41 vs 42
  assert.equal(get('pass_night'), 'fail');     // 41 vs 35
});

test('each period is judged on its OWN solve, not the active one', async () => {
  // The failure this is here for: a project curtailed at night solves quiet
  // after dark, and reporting the daytime level against the night limit would
  // fail a receiver that complies.
  const byPeriod: Record<Period, ReceiverResult[]> = {
    day: resultAt(44),
    evening: resultAt(43),
    night: resultAt(33),
  };
  const get = await columns(project(), byPeriod);
  assert.equal(get('level_day_dba'), '44');
  assert.equal(get('level_evening_dba'), '43');
  assert.equal(get('level_night_dba'), '33');
  // Each verdict is its own level against its own limit. Judged on the active
  // (day) level of 44 instead, night would read fail — the exact mistake.
  assert.equal(get('pass_day'), 'pass');       // 44 vs 45
  assert.equal(get('pass_evening'), 'fail');   // 43 vs 42
  assert.equal(get('pass_night'), 'pass');     // 33 vs 35
});

test('a period fail caused by a tonality penalty is explainable from the row', async () => {
  // The reviewer's scenario: the night solve turns tonal and carries a +5
  // penalty, so it fails BELOW its limit (33 + 5 = 38 vs 35). The single
  // tonal/penalty columns describe the active (day) period, so without the
  // per-period assessed columns that fail is unexplainable from the file's own
  // numbers and reads as an export bug.
  const night: ReceiverResult[] = [{
    receiverId: 'R1',
    perBandLp: new Float64Array(10).fill(30),
    totalDbA: 33,
    tonalityPenaltyDb: 5,
    assessedDbA: 38,
    perSource: [],
  }];
  const byPeriod: Record<Period, ReceiverResult[]> = {
    day: resultAt(44), evening: resultAt(41), night,
  };
  const get = await columns(project(), byPeriod);
  assert.equal(get('level_night_dba'), '33');
  assert.equal(get('assessed_night_dba'), '38', 'the number the verdict compared');
  assert.equal(get('pass_night'), 'fail');     // 38 vs 35 — explained by the row
  // The active period (day) has no penalty, and its columns say so.
  assert.equal(get('tonality_penalty_db'), '0');
  assert.equal(get('assessed_day_dba'), '44');
});

test('a receiver with no result reports levels blank and verdicts as "—"', async () => {
  const get = await columns(project(), null);
  assert.equal(get('level_day_dba'), '');
  assert.equal(get('level_night_dba'), '');
  assert.equal(get('assessed_night_dba'), '');
  assert.equal(get('pass_night'), '—');
});

test('the active period still drives the spectrum-derived columns', async () => {
  // dB(C) − dB(A) and the tonality screen describe ONE spectrum, so they follow
  // the period on screen rather than being tripled.
  const p = project();
  p.scenario.period = 'night';
  const byPeriod: Record<Period, ReceiverResult[]> = {
    day: resultAt(44), evening: resultAt(41), night: resultAt(33),
  };
  const get = await columns(p, byPeriod);
  assert.equal(get('total_dba'), '33', 'the headline level is the active period');
  assert.equal(get('level_day_dba'), '44', 'and the day column is still day');
});

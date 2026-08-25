// Wind-speed-dependent limits: the lookup, the gate, and the paste parsers.
//
// The failure this file exists to prevent is a limit nobody entered being used
// to judge a project — by silent extrapolation, by a ragged table being padded,
// or by a stored table taking effect while its editor is switched off.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyBulkLimits,
  isUsableTable,
  limitFor,
  matchBulkRows,
  normaliseTable,
  parseBulkLimits,
  parseLimitGrid,
  resolveLimit,
  tableFromScalars,
  windSpeedBin,
} from './limitTable';
import type { LimitTable, Project, Receiver } from './types';

const table: LimitTable = {
  windSpeeds: [4, 6, 8, 10],
  limits: {
    day: [40, 41, 43, 45],
    evening: [38, 39, 41, 43],
    night: [35, 36, 38, 40],
  },
};

function rx(over: Partial<Receiver> = {}): Receiver {
  return {
    id: 'R1', name: 'R1', latLng: [-33.6, 138.7], heightAboveGroundM: 1.5,
    limitDayDbA: 50, limitEveningDbA: 48, limitNightDbA: 45,
    ...over,
  } as Receiver;
}

function project(over: { on?: boolean; windSpeed?: number; receivers?: Receiver[] } = {}): Project {
  return {
    schemaVersion: 1, name: 'T', description: '', createdAt: '', updatedAt: '', owner: 'x',
    scenario: {
      windSpeed: over.windSpeed ?? 8, windSpeedReferenceHeight: 10,
      period: 'night', bandSystem: 'octave',
    },
    sources: [], barriers: [],
    receivers: over.receivers ?? [rx({ limitTable: table })],
    settings: {
      ground: { defaultG: 0.5 },
      annexD: {
        barrierAbarCapDb: 3, useElevatedSourceForBarrier: true,
        applyConcaveCorrection: true, wtReceiverHeightMin: 4,
      },
      general: { defaultReceiverHeight: 1.5 },
      compliance: over.on === undefined ? undefined : { windSpeedLimits: over.on },
    } as Project['settings'],
  } as Project;
}

// -------------------------------------------------------------------- the gate

test('a stored table does nothing until the setting is on', () => {
  // Honouring a table whose editor is hidden would change every verdict on the
  // project with nothing on screen to explain it.
  const r = rx({ limitTable: table });
  assert.equal(limitFor(project({ on: false }), r), 45, 'the scalar night limit');
  assert.equal(limitFor(project(), r), 45, 'absent setting behaves as off');
  assert.equal(limitFor(project({ on: true }), r), 38, 'table night limit at 8 m/s');
});

test('with the setting on but no table, the scalar limits still apply', () => {
  const bare = rx();
  assert.equal(limitFor(project({ on: true, receivers: [bare] }), bare), 45);
  assert.equal(resolveLimit(project({ on: true }), bare).source, 'scalar');
});

// ------------------------------------------------------------------ the lookup

test('the limit is read at the binned wind speed', () => {
  // 8 m/s means the 7.5–8.5 bin (Q16), so anything in it reads the 8 column.
  const p = (ws: number) => project({ on: true, windSpeed: ws });
  const r = rx({ limitTable: table });
  assert.equal(limitFor(p(8), r), 38);
  assert.equal(limitFor(p(7.6), r), 38);
  assert.equal(limitFor(p(8.4), r), 38);
  assert.equal(windSpeedBin(7.5), 8);
});

test('an interior gap takes the nearest column, ties to the lower wind speed', () => {
  // 8.6 bins to 9, which this table skips. Interpolating would invent a limit
  // (39 dB is not implied by 38 at 8 and 40 at 10), so the nearest column wins;
  // 9 is equidistant, and the tie is fixed to the lower — stricter — speed
  // rather than left to whichever way the array happened to be sorted.
  const r = rx({ limitTable: table });
  const got = resolveLimit(project({ on: true, windSpeed: 8.6 }), r);
  assert.deepEqual([got.db, got.source, got.atWindSpeed], [38, 'clamped', 8]);

  // Same table sorted the other way must give the same answer.
  const reversed = rx({
    limitTable: {
      windSpeeds: [10, 8, 6, 4],
      limits: { day: [45, 43, 41, 40], evening: [43, 41, 39, 38], night: [40, 38, 36, 35] },
    },
  });
  assert.equal(resolveLimit(project({ on: true, windSpeed: 8.6 }), reversed).atWindSpeed, 8);
});

test('each period reads its own row', () => {
  const p = project({ on: true, windSpeed: 6 });
  const r = rx({ limitTable: table });
  assert.equal(limitFor(p, r, 'day'), 41);
  assert.equal(limitFor(p, r, 'evening'), 39);
  assert.equal(limitFor(p, r, 'night'), 36);
});

test('a wind speed off the table clamps to the nearest end, and says so', () => {
  // Limit curves plateau, so the nearest end is the intended reading — but the
  // caller is told, because the number shown is then not one in the table.
  const r = rx({ limitTable: table });
  const low = resolveLimit(project({ on: true, windSpeed: 2 }), r);
  assert.deepEqual([low.db, low.source, low.atWindSpeed], [35, 'clamped', 4]);
  const high = resolveLimit(project({ on: true, windSpeed: 25 }), r);
  assert.deepEqual([high.db, high.source, high.atWindSpeed], [40, 'clamped', 10]);
  const hit = resolveLimit(project({ on: true, windSpeed: 6 }), r);
  assert.deepEqual([hit.db, hit.source, hit.atWindSpeed], [36, 'table', 6]);
});

test('a ragged or empty table is rejected rather than padded', () => {
  // Padding invents limits, and an invented limit is the worst possible thing
  // to judge a project against — so an unusable table falls back to the scalars.
  assert.equal(isUsableTable(undefined), false);
  assert.equal(isUsableTable({ windSpeeds: [], limits: { day: [], evening: [], night: [] } }), false);
  const ragged = {
    windSpeeds: [4, 6],
    limits: { day: [40], evening: [38, 39], night: [35, 36] },
  } as LimitTable;
  assert.equal(isUsableTable(ragged), false);
  const r = rx({ limitTable: ragged });
  assert.equal(limitFor(project({ on: true, receivers: [r] }), r), 45, 'falls back to the scalar');
});

// ----------------------------------------------------------------- housekeeping

test('normalising sorts by wind speed and keeps the period rows in step', () => {
  const messy: LimitTable = {
    windSpeeds: [10, 4, 6],
    limits: { day: [45, 40, 41], evening: [43, 38, 39], night: [40, 35, 36] },
  };
  assert.deepEqual(normaliseTable(messy), {
    windSpeeds: [4, 6, 10],
    limits: { day: [40, 41, 45], evening: [38, 39, 43], night: [35, 36, 40] },
  });
});

test('a new table starts from the scalar limits, not from blanks', () => {
  assert.deepEqual(tableFromScalars(rx(), [6, 4, 4]), {
    windSpeeds: [4, 6],
    limits: { day: [50, 50], evening: [48, 48], night: [45, 45] },
  });
});

// --------------------------------------------------------------------- pasting

test('a labelled grid pastes in any row order', () => {
  const got = parseLimitGrid([
    '\t4\t6\t8',
    'Night\t35\t36\t38',
    'Day\t40\t41\t43',
    'Evening\t38\t39\t41',
  ].join('\n'));
  assert.ok(got.ok, got.ok ? '' : got.reason);
  assert.deepEqual(got.table, {
    windSpeeds: [4, 6, 8],
    limits: { day: [40, 41, 43], evening: [38, 39, 41], night: [35, 36, 38] },
  });
  assert.equal(got.note, undefined);
});

test('an unlabelled grid is read in order and SAYS it guessed', () => {
  const got = parseLimitGrid(['4\t6', '40\t41', '38\t39', '35\t36'].join('\n'));
  assert.ok(got.ok, got.ok ? '' : got.reason);
  assert.deepEqual(got.table.limits.night, [35, 36]);
  assert.match(got.note ?? '', /day, evening, night/,
    'guessing silently is how a night limit ends up enforced during the day');
});

test('a grid whose rows do not match its header is refused', () => {
  const short = parseLimitGrid(['\t4\t6\t8', 'Day\t40\t41', 'Evening\t38\t39\t41', 'Night\t35\t36\t38'].join('\n'));
  assert.equal(short.ok, false);
  assert.match(short.ok ? '' : short.reason, /2 values but there are 3/);

  const noSpeeds = parseLimitGrid(['Day\tEvening', '40\t41'].join('\n'));
  assert.equal(noSpeeds.ok, false);

  assert.equal(parseLimitGrid('').ok, false);
  assert.equal(parseLimitGrid(['\t4\t6', 'Day\t40\t41'].join('\n')).ok, false, 'needs three rows');
});

test('CSV pastes too, and units on the numbers are tolerated', () => {
  const got = parseLimitGrid(['Period,4,6', 'Day,40 dB,41dBA', 'Evening,38,39', 'Night,35,36'].join('\n'));
  assert.ok(got.ok, got.ok ? '' : got.reason);
  assert.deepEqual(got.table.limits.day, [40, 41]);
});

// ------------------------------------------------------------------------ bulk

test('a bulk block is wind-speed columns by receiver rows', () => {
  const got = parseBulkLimits(['\t4\t6\t8', 'House A\t35\t36\t38', 'House B\t40\t41\t42'].join('\n'));
  assert.ok(got.ok, got.ok ? '' : got.reason);
  assert.deepEqual(got.block.windSpeeds, [4, 6, 8]);
  assert.deepEqual(got.block.rows.map((r) => r.name), ['House A', 'House B']);
  assert.deepEqual(got.block.rows[1].values, [40, 41, 42]);
});

test('receiver matching is exact, then loose, and never a guess', () => {
  const a = rx({ id: 'a', name: 'House A' });
  const b = rx({ id: 'b', name: 'House B' });
  const m = matchBulkRows(
    [{ name: '  house a ', values: [1] }, { name: 'Nowhere', values: [2] }],
    [a, b],
  );
  assert.equal(m.matched.get('a')?.values[0], 1, 'trimmed + case-insensitive');
  assert.deepEqual(m.unmatchedRows, ['Nowhere']);
  assert.deepEqual(m.missingReceivers, ['House B'],
    'a receiver the file said nothing about is reported, not silently stale');
});

test('an ambiguous name is left unmatched rather than guessed', () => {
  const a = rx({ id: 'a', name: 'House' });
  const b = rx({ id: 'b', name: 'house' });
  const m = matchBulkRows([{ name: 'HOUSE', values: [1] }], [a, b]);
  assert.equal(m.matched.size, 0);
  assert.deepEqual(m.unmatchedRows, ['HOUSE']);
});

test('a bulk apply writes one period and preserves the others', () => {
  const r = rx({ id: 'a', name: 'A', limitTable: table });
  const p = project({ on: true, receivers: [r] });
  const block = { windSpeeds: [4, 6, 8, 10], rows: [{ name: 'A', values: [20, 21, 22, 23] }] };
  const out = applyBulkLimits(p, 'night', block, matchBulkRows(block.rows, [r]).matched);
  assert.deepEqual(out[0].limitTable!.limits.night, [20, 21, 22, 23]);
  assert.deepEqual(out[0].limitTable!.limits.day, [40, 41, 43, 45], 'day is untouched');
});

test('a bulk apply onto different wind speeds re-reads the other periods', () => {
  // The incoming axis wins; periods it doesn't carry are re-read at the new
  // speeds, falling to the scalar where the old table doesn't reach — rather
  // than merging two axes, which would invent limits.
  const r = rx({ id: 'a', name: 'A', limitTable: table });
  const p = project({ on: true, receivers: [r] });
  const block = { windSpeeds: [6, 20], rows: [{ name: 'A', values: [30, 31] }] };
  const out = applyBulkLimits(p, 'night', block, matchBulkRows(block.rows, [r]).matched);
  assert.deepEqual(out[0].limitTable!.windSpeeds, [6, 20]);
  assert.deepEqual(out[0].limitTable!.limits.night, [30, 31]);
  assert.deepEqual(out[0].limitTable!.limits.day, [41, 50],
    '6 came from the old table; 20 was not in it, so the scalar day limit');
});

test('an unmatched receiver is not touched at all', () => {
  const r = rx({ id: 'a', name: 'A' });
  const p = project({ on: true, receivers: [r] });
  const out = applyBulkLimits(p, 'night', { windSpeeds: [4], rows: [] }, new Map());
  assert.equal(out[0], r, 'same object — no table invented for it');
});

// ---------------------------------------------------- review-driven guards

test('a cell holding only a unit is no data, not a limit of zero', () => {
  // The unit-stripping regex can consume the whole cell, and `Number('')` is 0.
  // A merged Excel header or a partial copy therefore produced a silently
  // accepted 0 dB limit — a value nobody entered, judged against.
  const grid = parseLimitGrid('\t4\t6\nDay\t40\tdB\nEvening\t38\t39\nNight\t35\t36');
  assert.equal(grid.ok, false, 'a unit-only cell must be refused, not read as 0');

  const bulk = parseBulkLimits('\t4\t6\nR1\t35\tdBA');
  assert.equal(bulk.ok, false);

  // The units that DO belong on a number are still tolerated.
  const withUnits = parseLimitGrid('\t4\t6\nDay\t40 dB\t41dB(A)\nEvening\t38\t39\nNight\t35\t36');
  assert.equal(withUnits.ok, true);
  assert.deepEqual(withUnits.ok && withUnits.table.limits.day, [40, 41]);
});

test('two rows naming the same receiver are both refused, not silently last-wins', () => {
  // The commonest way these blocks are edited is a corrected row above a stale
  // one. Last-wins wrote the stale limit and reported a clean import; worse, a
  // later LOOSE match beat an earlier EXACT one, inverting the documented
  // precedence.
  const r = rx({ id: 'a', name: 'House A' });
  const rows = [
    { name: 'House A', values: [30] },
    { name: 'house a', values: [99] },
  ];
  const m = matchBulkRows(rows, [r]);
  assert.equal(m.matched.size, 0, 'neither row may win');
  assert.deepEqual(m.unmatchedRows, ['House A', 'house a']);
  assert.deepEqual(m.missingReceivers, ['House A'], 'the receiver is reported as untouched');
});

test('a single unambiguous row still matches, loosely if it must', () => {
  const r = rx({ id: 'a', name: 'House A' });
  assert.equal(matchBulkRows([{ name: 'House A', values: [30] }], [r]).matched.get('a')?.values[0], 30);
  assert.equal(matchBulkRows([{ name: ' house a ', values: [31] }], [r]).matched.get('a')?.values[0], 31);
});

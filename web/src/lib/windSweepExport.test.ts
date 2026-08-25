// What a sweep writes to disk.
//
// The sweep's whole value is that someone else can check it, so the tests here
// are about the file being self-describing: every contour feature says which
// wind speed and period it came from, every receiver row carries the limit it
// was judged against, and the settings sheet records the assumptions rather
// than leaving them to be remembered.

import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';

import {
  exportWindSweepContoursKml,
  exportWindSweepContoursShp,
  exportWindSweepGeoTiffZip,
  exportWindSweepXlsx,
  exportGridGeoTiff,
} from './exporters';
import type { SweepContourLayer, SweepResult } from './windSweep';
import type { GridResult, ReceiverResult } from './solver';
import type { LimitTable, Period, Project, Receiver } from './types';

function rx(id: string, over: Partial<Receiver> = {}): Receiver {
  return {
    id, name: id, latLng: [-33.6, 138.7], heightAboveGroundM: 1.5,
    limitDayDbA: 45, limitEveningDbA: 42, limitNightDbA: 40,
    ...over,
  } as Receiver;
}

function project(over: Partial<Project> = {}): Project {
  return {
    schemaVersion: 1, name: 'Farm A', description: '', createdAt: '', updatedAt: '', owner: 'x',
    scenario: { windSpeed: 10, windSpeedReferenceHeight: 10, period: 'night', bandSystem: 'octave' },
    sources: [], barriers: [],
    receivers: [rx('R1'), rx('R2')],
    settings: {
      ground: { defaultG: 0.5 },
      annexD: {
        barrierAbarCapDb: 3, useElevatedSourceForBarrier: true,
        applyConcaveCorrection: true, wtReceiverHeightMin: 4,
      },
      general: { defaultReceiverHeight: 1.5 },
      limitComparison: 'exact',
    } as Project['settings'],
    ...over,
  } as Project;
}

function gridAt(base: number): GridResult {
  return {
    cols: 2, rows: 2, bounds: { sw: [-33.7, 138.6], ne: [-33.5, 138.8] },
    dbA: new Float32Array([base, base + 1, base + 2, base + 3]), computedMs: 1,
  };
}

/// A sweep whose R1 level rises with wind speed and whose R2 level does not.
function sweep(opts: {
  speeds?: number[];
  periods?: Period[];
  grids?: boolean;
  receivers?: boolean;
} = {}): SweepResult {
  const speeds = opts.speeds ?? [8, 10, 12];
  const periods = opts.periods ?? (['night'] as Period[]);
  const wantRx = opts.receivers ?? true;
  const wantGrid = opts.grids ?? false;
  const states = [];
  for (const windSpeed of speeds) {
    for (const period of periods) {
      states.push({
        period,
        windSpeed,
        receivers: wantRx
          ? [
            result('R1', 30 + windSpeed),
            result('R2', 35),
          ]
          : null,
        grid: wantGrid ? gridAt(windSpeed) : null,
      });
    }
  }
  return {
    config: { windSpeeds: speeds, periods, receivers: wantRx, grids: wantGrid },
    states,
    warnings: [],
    elapsedMs: 1234,
    gridSpacingM: wantGrid ? 50 : undefined,
    receiverHeightM: wantGrid ? 1.5 : undefined,
  };
}

function result(receiverId: string, totalDbA: number): ReceiverResult {
  return { receiverId, perBandLp: new Float64Array(10), totalDbA, perSource: [] };
}

function sheet(blob: Blob, name: string): Promise<unknown[][]> {
  return blob.arrayBuffer().then((buf) => {
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    assert.ok(wb.SheetNames.includes(name), `no sheet "${name}" in ${wb.SheetNames.join(', ')}`);
    return XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1 }) as unknown[][];
  });
}

/// The row a block header starts, so a test can read the block under it without
/// hard-coding line numbers that shift whenever a column is added.
function blockAt(rows: unknown[][], title: string): unknown[][] {
  const i = rows.findIndex((r) => typeof r[0] === 'string' && r[0].startsWith(title));
  assert.ok(i >= 0, `no block "${title}"`);
  const out: unknown[][] = [];
  for (let j = i + 1; j < rows.length && rows[j].length > 0; j++) out.push(rows[j]);
  return out;
}

// ------------------------------------------------------------------- XLSX

test('one sheet per period, with a level / limit / margin block on each', async () => {
  const blob = exportWindSweepXlsx(project(), sweep({ periods: ['day', 'night'] }));
  const buf = await blob.arrayBuffer();
  const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
  assert.deepEqual(wb.SheetNames, ['Day', 'Night', 'Settings']);

  const rows = await sheet(blob, 'Night');
  const levels = blockAt(rows, 'Level at receiver');
  assert.deepEqual(levels[0], ['R1', 38, 40, 42]);
  assert.deepEqual(levels[1], ['R2', 35, 35, 35]);
  // Limits are constant here — the receivers have scalar limits — and the
  // margin block is the subtraction, so the reader can check every verdict.
  assert.deepEqual(blockAt(rows, 'Limit')[0], ['R1', 40, 40, 40]);
  assert.deepEqual(blockAt(rows, 'Margin')[0], ['R1', 2, 0, -2]);
});

test('the wind-speed columns are labelled, so a column cannot be misread', async () => {
  const rows = await sheet(exportWindSweepXlsx(project(), sweep()), 'Night');
  const header = rows.find((r) => r[0] === 'Level at receiver (dB(A))')!;
  assert.deepEqual(header.slice(1), ['8 m/s', '10 m/s', '12 m/s']);
});

test('the summary names the worst wind speed and every speed that fails', async () => {
  const rows = await sheet(exportWindSweepXlsx(project(), sweep()), 'Night');
  const head = rows.findIndex((r) => r[0] === 'Receiver');
  const byName = new Map(rows.slice(head + 1).map((r) => [r[0], r]));
  const r1 = byName.get('R1')!;
  const cols = rows[head] as string[];
  const col = (name: string) => r1[cols.indexOf(name)];
  // 42 dB at 12 m/s against a 40 dB limit — the sweep's answer, and one a
  // single-wind-speed run at 8 m/s would have missed entirely.
  assert.equal(col('Worst wind speed (m/s)'), 12);
  assert.equal(col('Margin there'), -2);
  assert.equal(col('Verdict'), 'fail');
  assert.equal(col('Fails at (m/s)'), '12');
  assert.equal(byName.get('R2')![cols.indexOf('Verdict')], 'pass');
});

test('a limit read off the end of a table is disclosed as such in the row', async () => {
  const table: LimitTable = {
    windSpeeds: [8, 10],
    limits: { day: [45, 46], evening: [42, 43], night: [38, 39] },
  };
  const p = project({
    receivers: [rx('R1', { limitTable: table })],
    settings: {
      ...project().settings,
      compliance: { windSpeedLimits: true },
    } as Project['settings'],
  });
  const rows = await sheet(exportWindSweepXlsx(p, sweep({ speeds: [8, 10, 12] })), 'Night');
  const head = rows.findIndex((r) => r[0] === 'Receiver');
  const cols = rows[head] as string[];
  const r1 = rows[head + 1];
  assert.match(String(r1[cols.indexOf('Limit read from')]), /nearest column used at 12 m\/s/);
  // …and the limit block shows the clamp rather than hiding it.
  assert.deepEqual(blockAt(rows, 'Limit')[0], ['R1', 38, 39, 39]);
});

test('the settings sheet records what the run assumed, including that wind direction was not', async () => {
  const rows = await sheet(exportWindSweepXlsx(project(), sweep({ grids: true })), 'Settings');
  const kv = new Map(rows.map((r) => [String(r[0]), String(r[1] ?? '')]));
  assert.equal(kv.get('Wind speeds (m/s)'), '8, 10, 12');
  assert.equal(kv.get('Contour grids solved'), 'yes');
  assert.equal(kv.get('Grid spacing (m)'), '50');
  assert.match(kv.get('Wind direction') ?? '', /treated as downwind/);
  assert.match(kv.get('Levels are') ?? '', /tonality penalty/);
  assert.match(kv.get('Wind-speed limits') ?? '', /^off/);
});

test('a sweep’s warnings reach the file, not just the screen', async () => {
  const s = sweep();
  s.warnings = ['Nothing in this project varies with wind speed.'];
  const rows = await sheet(exportWindSweepXlsx(project(), s), 'Settings');
  assert.ok(rows.some((r) => String(r[0]).startsWith('Nothing in this project varies')));
});

// -------------------------------------------------------------- contours

const layers: SweepContourLayer[] = [
  {
    period: 'night',
    windSpeed: 8,
    sets: [{ threshold: 35, lines: [[[-27.0, 152.0], [-27.001, 152.001]]] }],
  },
  {
    period: 'night',
    windSpeed: 12,
    sets: [
      { threshold: 35, lines: [[[-27.0, 152.0], [-27.002, 152.002]]] },
      { threshold: 37.5, label: 'Night limit', lines: [[[-27.0, 152.0], [-27.003, 152.0]]] },
    ],
  },
];

test('every contour feature carries the wind speed and period that produced it', async () => {
  const zip = await exportWindSweepContoursShp(project(), layers).arrayBuffer();
  const text = new TextDecoder('latin1').decode(new Uint8Array(zip));
  // Field names live in the DBF header as plain ASCII.
  for (const field of ['WS_MS', 'PERIOD', 'THRESH_DB', 'LABEL']) {
    assert.ok(text.includes(field), `missing DBF field ${field}`);
  }
  // Without the tag the whole export is a pile of unattributable lines, so the
  // VALUES matter as much as the schema.
  assert.ok(text.includes('night'));
  assert.ok(text.includes('Night limit'));
});

test('the KML puts each wind speed in its own folder, and hides all but the first', async () => {
  const xml = await exportWindSweepContoursKml(project(), layers).text();
  assert.ok(xml.includes('<name>Night — 8 m/s</name>'));
  assert.ok(xml.includes('<name>Night — 12 m/s</name>'));
  assert.equal(xml.match(/<Folder>/g)?.length, 2);
  // One visible folder: forty contour sets drawn at once is not a map.
  assert.equal(xml.match(/<visibility>1<\/visibility>/g)?.length, 1);
  assert.ok(xml.includes('<Data name="wind_speed_ms"><value>12</value></Data>'));
  assert.ok(xml.includes('<Data name="period"><value>night</value></Data>'));
});

test('a project name with an ampersand does not break the KML', async () => {
  const xml = await exportWindSweepContoursKml(project({ name: 'A & B' }), layers).text();
  assert.ok(xml.includes('A &amp; B'));
  assert.ok(!/<name>A & B/.test(xml));
});

// -------------------------------------------------------------- GeoTIFFs

test('the GeoTIFF zip names each raster by wind speed and period, zero-padded to sort', async () => {
  const bytes = new Uint8Array(
    await exportWindSweepGeoTiffZip(sweep({
      speeds: [8, 10], periods: ['night'], grids: true, receivers: false,
    })).arrayBuffer(),
  );
  const text = new TextDecoder('latin1').decode(bytes);
  assert.ok(text.includes('grid_ws08_night.tif'), 'wind speed should be zero-padded');
  assert.ok(text.includes('grid_ws10_night.tif'));
  // Padding is what makes a file manager sort 8 before 10 — the unpadded name
  // would be the one this guards against.
  assert.ok(!text.includes('grid_ws8_night.tif'));
});

test('a receivers-only sweep still exports, and produces an empty raster zip rather than a broken one', async () => {
  const s = sweep({ grids: false });
  const zip = await exportWindSweepGeoTiffZip(s).arrayBuffer();
  // A valid empty zip is 22 bytes (end-of-central-directory only).
  assert.ok(zip.byteLength >= 22);
  // …and the XLSX is unaffected by there being no grids.
  const rows = await sheet(exportWindSweepXlsx(project(), s), 'Settings');
  const kv = new Map(rows.map((r) => [String(r[0]), String(r[1] ?? '')]));
  assert.equal(kv.get('Contour grids solved'), 'no');
  assert.ok(!kv.has('Grid spacing (m)'));
});

// ------------------------------------------------- review-driven guards

/// Decode a DBF's records into plain objects. The sweep's whole grid export
/// rests on every feature carrying the state that produced it, and asserting
/// that field NAMES appear in the zip cannot tell a correct file from one where
/// every record repeated the first feature's values — which is precisely the
/// bug the hand-rolled shapefile writer exists to have fixed.
function decodeDbf(bytes: Uint8Array): Array<Record<string, string>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const nRecords = dv.getUint32(4, true);
  const headerLen = dv.getUint16(8, true);
  const recordLen = dv.getUint16(10, true);
  const fields: Array<{ name: string; len: number }> = [];
  for (let off = 32; off < headerLen - 1; off += 32) {
    if (bytes[off] === 0x0d) break;
    const raw = new TextDecoder('latin1').decode(bytes.subarray(off, off + 11));
    fields.push({ name: raw.replace(/\0.*$/, ''), len: bytes[off + 16] });
  }
  const out: Array<Record<string, string>> = [];
  for (let i = 0; i < nRecords; i++) {
    let p = headerLen + i * recordLen + 1;      // +1 skips the deletion flag
    const rec: Record<string, string> = {};
    for (const f of fields) {
      rec[f.name] = new TextDecoder('latin1').decode(bytes.subarray(p, p + f.len)).trim();
      p += f.len;
    }
    out.push(rec);
  }
  return out;
}

/// Pull one entry's bytes out of a store-mode zip by name.
function zipEntry(bytes: Uint8Array, name: string): Uint8Array | null {
  const text = new TextDecoder('latin1').decode(bytes);
  const at = text.indexOf(name);
  if (at < 0) return null;
  // Local file header: sig(4) ver(2) flag(2) method(2) time(4) crc(4)
  // compSize(4) uncompSize(4) nameLen(2) extraLen(2) = 30 bytes, then the name.
  const lfh = at - 30;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (dv.getUint32(lfh, true) !== 0x04034b50) return null;
  const size = dv.getUint32(lfh + 18, true);
  const nameLen = dv.getUint16(lfh + 26, true);
  const extraLen = dv.getUint16(lfh + 28, true);
  const start = lfh + 30 + nameLen + extraLen;
  return bytes.subarray(start, start + size);
}

test('each contour feature carries ITS OWN wind speed and period, record by record', async () => {
  const zip = new Uint8Array(
    await exportWindSweepContoursShp(project(), layers).arrayBuffer(),
  );
  const dbf = zipEntry(zip, 'wind_sweep_contours.dbf');
  assert.ok(dbf, 'no .dbf in the bundle');
  const records = decodeDbf(dbf!);
  // layers = [8 m/s × 1 set] then [12 m/s × 2 sets] — three features in order.
  assert.equal(records.length, 3);
  assert.deepEqual(records.map((r) => r.WS_MS), ['8.0', '12.0', '12.0']);
  assert.deepEqual(records.map((r) => r.PERIOD), ['night', 'night', 'night']);
  assert.deepEqual(records.map((r) => r.THRESH_DB), ['35.00', '35.00', '37.50']);
  assert.deepEqual(records.map((r) => r.LABEL), ['', '', 'Night limit']);
});

test('each swept raster holds its own grid, not a copy of the first', async () => {
  const s = sweep({ speeds: [8, 10], periods: ['night'], grids: true, receivers: false });
  const zip = new Uint8Array(await exportWindSweepGeoTiffZip(s).arrayBuffer());
  const a = zipEntry(zip, 'grid_ws08_night.tif');
  const b = zipEntry(zip, 'grid_ws10_night.tif');
  assert.ok(a && b);
  // `gridAt(ws)` seeds each raster from its own wind speed, so identical bytes
  // would mean one state's grid was written under both names.
  assert.notDeepEqual(Array.from(a!), Array.from(b!));
  // …and each is byte-identical to the standalone writer for the same grid.
  const solo = new Uint8Array(await exportGridGeoTiff(gridAt(8)).arrayBuffer());
  assert.deepEqual(Array.from(a!), Array.from(solo));
});

test('a receiver that never solved is not reported as compliant', async () => {
  // `exceedsLimit` answers false for a null level — absence is not exceedance —
  // so an unsolved receiver has no failures and used to read "pass" with every
  // other cell in its row blank. That is a compliance claim made on no data.
  const p = project({ receivers: [rx('R1'), rx('R2')] });
  const s = sweep();
  for (const st of s.states) {
    st.receivers = st.receivers!.filter((r) => r.receiverId === 'R1');
  }
  const rows = await sheet(exportWindSweepXlsx(p, s), 'Night');
  const head = rows.findIndex((r) => r[0] === 'Receiver');
  const cols = rows[head] as string[];
  const byName = new Map(rows.slice(head + 1).map((r) => [r[0], r]));
  assert.equal(byName.get('R2')![cols.indexOf('Verdict')], '—');
  assert.equal(byName.get('R2')![cols.indexOf('Worst wind speed (m/s)')], '');
  // The solved one is unaffected.
  assert.equal(byName.get('R1')![cols.indexOf('Verdict')], 'fail');
});

test('a margin that decided a verdict is not rounded away', async () => {
  // At one decimal, 40.04 against a 40 dB limit printed level 40, limit 40,
  // margin 0 — and "fail". A row that contradicts its own caption.
  const p = project({ receivers: [rx('R1', { limitNightDbA: 40 })] });
  const s = sweep({ speeds: [10] });
  s.states[0].receivers = [result('R1', 40.04)];
  const rows = await sheet(exportWindSweepXlsx(p, s), 'Night');
  assert.deepEqual(blockAt(rows, 'Margin')[0], ['R1', -0.04]);
});

// Custom named contour lines — the tracing/attribution layer and the export
// tagging that hangs off it.
//
// The geometry itself is d3-contour's, already exercised through the map; what
// is new (and what these tests pin) is that a custom level is traced in the
// SAME pass as the stepped contours without leaking into them, and that a line
// carries its name all the way into KML and the shapefile.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildContourLines, clampLineWidth, customTracesFrom, dashArrayFor, sanitiseCustomContours,
  steppedTracesFrom, unionContourLevels, CUSTOM_LABEL_MAX, CUSTOM_LINE_WIDTH_MAX,
  CUSTOM_LINE_WIDTH_MIN, type ContourLineSet,
} from './contourLines';
import { escapeHtml, safeCssColor } from './html';
import { exportContoursKml, exportContoursShp } from './exporters';
import type { CustomContourLine, Project } from './types';
import type { GridResult } from './gridCore';

function line(over: Partial<CustomContourLine> = {}): CustomContourLine {
  return {
    id: 'cl-1', label: 'Night limit', levelDb: 37.5,
    color: '#dc2626', widthPx: 2.5, dashed: true, export: true, ...over,
  };
}

/// A radially symmetric cone over a 1° × 1° box: `dbA = peak − k·r`, with r in
/// CELLS from the centre. An iso-level L therefore sits at radius
/// `(peak − L) / k` cells, which is what makes the traced geometry checkable
/// against an exact answer rather than against itself.
function coneGrid(cols = 81, rows = 81, peak = 80, k = 0.5): GridResult {
  const dbA = new Float32Array(cols * rows);
  const cx = (cols - 1) / 2;
  const cy = (rows - 1) / 2;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      dbA[r * cols + c] = peak - k * Math.hypot(c - cx, r - cy);
    }
  }
  return {
    cols, rows, dbA,
    bounds: { sw: [0, 0], ne: [1, 1] },
  } as unknown as GridResult;
}

// ---------- level union ----------

test('the traced level list is the union of stepped and custom, deduped', () => {
  const levels = unionContourLevels([35, 40, 45], [line({ levelDb: 37.5 }), line({ id: 'b', levelDb: 40 })]);
  assert.deepEqual(levels, [35, 40, 45, 37.5]);
});

test('a non-finite custom level is dropped rather than passed to the tracer', () => {
  const levels = unionContourLevels([40], [line({ levelDb: NaN }), line({ id: 'b', levelDb: Infinity })]);
  assert.deepEqual(levels, [40]);
});

// ---------- attribution ----------

test('a custom line takes the geometry traced at its own level', () => {
  const grid = coneGrid();
  // 65 dB sits at (80 − 65) / 0.5 = 30 cells from the centre of an 81-cell
  // grid, i.e. 30/81 of the bounds in each direction.
  const custom = [line({ levelDb: 65 })];
  const sets = buildContourLines(grid, unionContourLevels([], custom));
  const traced = customTracesFrom(sets, custom);
  assert.equal(traced.length, 1);
  assert.equal(traced[0].set.label, 'Night limit');
  assert.equal(traced[0].set.threshold, 65);

  const pts = traced[0].set.lines.flat();
  assert.ok(pts.length > 20, 'expected a closed ring, not a fragment');
  const expected = 30 / 81;
  for (const [lat, lng] of pts) {
    const r = Math.hypot(lat - 0.5, lng - 0.5);
    assert.ok(Math.abs(r - expected) < 0.02, `radius ${r.toFixed(4)} != ${expected.toFixed(4)}`);
  }
});

test('two custom lines at one level share the traced geometry, keeping their own names', () => {
  const grid = coneGrid();
  const custom = [line({ id: 'a', label: 'Day' }), line({ id: 'b', label: 'Night' })];
  const sets = buildContourLines(grid, unionContourLevels([], custom));
  const traced = customTracesFrom(sets, custom);
  assert.deepEqual(traced.map((t) => t.set.label), ['Day', 'Night']);
  assert.deepEqual(traced[0].set.lines, traced[1].set.lines);
});

test('a custom level outside the grid range yields no line rather than an empty one', () => {
  const grid = coneGrid();
  const custom = [line({ levelDb: 200 })];
  const sets = buildContourLines(grid, unionContourLevels([], custom));
  // d3 answers with a feature carrying zero rings — dropping it here is what
  // keeps the PDF legend from listing a line the map never draws.
  assert.equal(sets.length, 1);
  assert.equal(sets[0].lines.length, 0);
  assert.equal(customTracesFrom(sets, custom).length, 0);
});

test('a custom level does NOT become a stepped contour — the leak this guards', () => {
  const grid = coneGrid();
  const stepped = [60, 65, 70];
  const custom = [line({ levelDb: 62.5 })];
  const sets = buildContourLines(grid, unionContourLevels(stepped, custom));
  // The tracer returns four levels; only three of them are the user's steps.
  assert.equal(sets.length, 4);
  const kept = steppedTracesFrom(sets, stepped);
  assert.deepEqual(kept.map((s) => s.threshold).sort((a, b) => a - b), [60, 65, 70]);
  assert.ok(!kept.some((s) => s.threshold === 62.5));
});

test('stepped sets carry no label, so exports can tell the two apart', () => {
  const grid = coneGrid();
  const sets = steppedTracesFrom(buildContourLines(grid, [65]), [65]);
  assert.equal(sets[0].label, undefined);
});

// ---------- export tagging ----------

const project: Project = {
  schemaVersion: 1, name: 'T', description: '', createdAt: '', updatedAt: '',
  owner: 'x', scenario: { windSpeed: 10, windSpeedReferenceHeight: 10, period: 'night', bandSystem: 'octave' },
  sources: [], barriers: [], receivers: [],
};

const namedSet: ContourLineSet = {
  threshold: 37.5,
  label: 'Night limit',
  lines: [[[-27.0, 152.0], [-27.001, 152.001], [-27.002, 152.0]]],
};
const steppedSet: ContourLineSet = {
  threshold: 40,
  lines: [[[-27.0, 152.0], [-27.001, 152.001]]],
};

test('KML names a custom line by its label and keeps the level as data', async () => {
  const xml = await exportContoursKml(project, [steppedSet, namedSet]).text();
  assert.ok(xml.includes('<name>Night limit (37.5 dB) — line 1</name>'));
  assert.ok(xml.includes('<Data name="label"><value>Night limit</value></Data>'));
  // A stepped contour is still identified by its level alone.
  assert.ok(xml.includes('<name>40 dB(A) — line 1</name>'));
  // …and gains no empty label element.
  assert.equal(xml.match(/name="label"/g)?.length, 1);
});

test('KML escapes a label — an ampersand in a name must not break the document', async () => {
  const xml = await exportContoursKml(project, [{ ...namedSet, label: 'A & B <x>' }]).text();
  assert.ok(xml.includes('A &amp; B &lt;x&gt;'));
  assert.ok(!xml.includes('A & B <x>'));
});

test('the shapefile carries LABEL alongside the threshold', async () => {
  const zip = await exportContoursShp(project, [steppedSet, namedSet]).arrayBuffer();
  const bytes = new Uint8Array(zip);
  // The DBF field descriptors sit in the header as plain ASCII; finding both
  // names is enough to pin the schema without decoding the whole bundle.
  const text = new TextDecoder('latin1').decode(bytes);
  // Named THRESH_DB, not THRESH_DBA: the value follows the project's
  // assessment weighting, so the field must not promise A.
  assert.ok(text.includes('THRESH_DB'));
  assert.ok(text.includes('LABEL'));
  assert.ok(text.includes('Night limit'), 'the label value should reach the DBF records');
});

// ---------- hardening against a hostile / hand-edited document ----------

test('a colour is whitelisted to a hex literal, not merely escaped', () => {
  // The colour is interpolated into a style="" attribute. Escaping is not
  // enough there: `red;background:url(...)` injects a declaration without
  // needing a single quote or angle bracket.
  assert.equal(safeCssColor('#dc2626'), '#dc2626');
  assert.equal(safeCssColor('#ABC'), '#ABC');
  assert.equal(safeCssColor(' #dc2626 '), '#dc2626');
  for (const hostile of [
    'red"><img src=x onerror=alert(1)>',
    'red;background:url(https://evil.example/x)',
    'expression(alert(1))',
    'rgb(1,2,3)',
    '',
    undefined,
    42,
    { toString: () => '#000000' },
  ]) {
    assert.equal(safeCssColor(hostile), '#1f2937', String(hostile));
  }
});

test('custom lines off a project document are normalised before use', () => {
  const raw = [
    { id: 'a', label: 'Night', levelDb: 40, color: 'javascript:alert(1)', widthPx: 1e9, dashed: true, export: true },
    { id: 'b', levelDb: 35 },                       // sparse but usable
    { id: 'c', levelDb: 'forty' },                  // level is not a number
    { levelDb: 40 },                                // no id
    null,
    'not an object',
  ];
  const clean = sanitiseCustomContours(raw);
  assert.deepEqual(clean.map((c) => c.id), ['a', 'b']);
  assert.equal(clean[0].color, '#dc2626', 'a bad colour falls back');
  assert.ok(clean[0].widthPx <= 12, 'width is clamped');
  assert.equal(clean[1].label, '');
  assert.equal(clean[1].color, '#dc2626');
  assert.equal(sanitiseCustomContours(undefined).length, 0);
  assert.equal(sanitiseCustomContours({ nope: 1 }).length, 0);
});

test('a label is capped to the width the shapefile can actually store', () => {
  const long = 'Night-time lease boundary criterion — LAeq,15min 40 dB(A) and more';
  const [c] = sanitiseCustomContours([{ id: 'x', levelDb: 40, label: long }]);
  assert.equal(c.label.length, CUSTOM_LABEL_MAX);
  // Otherwise the KML keeps the whole name while the DBF silently truncates,
  // and two exports of one figure disagree about what the line is called.
});

// ---------- line weight and dashes ----------

test('the line width is clamped, so a negative value cannot make a line vanish', () => {
  // The field accepted anything: Leaflet draws a negative weight as nothing at
  // all, so the line silently disappeared with no clue why.
  assert.equal(clampLineWidth(-3), CUSTOM_LINE_WIDTH_MIN);
  assert.equal(clampLineWidth(0), CUSTOM_LINE_WIDTH_MIN);
  assert.equal(clampLineWidth(1e6), CUSTOM_LINE_WIDTH_MAX);
  assert.equal(clampLineWidth(NaN), 2.5);
  assert.equal(clampLineWidth(3), 3);
  // …and the same clamp applies to whatever is already stored on a project.
  const [c] = sanitiseCustomContours([{ id: 'x', levelDb: 40, widthPx: -5 }]);
  assert.equal(c.widthPx, CUSTOM_LINE_WIDTH_MIN);
});

test('dashes stay visible at every weight', () => {
  // A fixed "7 5" pattern merges into a solid line once the stroke is heavier
  // than the gap — the dashed box appears to do nothing at 8 px.
  for (const w of [0.5, 1, 2.5, 5, 8, 12]) {
    const [dash, gap] = dashArrayFor(w).split(' ').map(Number);
    assert.ok(dash > w, `${w}px: dash ${dash} is not longer than the stroke`);
    assert.ok(gap > w, `${w}px: gap ${gap} would be swallowed by the stroke`);
  }
  // Out-of-range widths still produce a usable pattern rather than "NaN NaN".
  assert.match(dashArrayFor(-1), /^[\d.]+ [\d.]+$/);
  assert.match(dashArrayFor(NaN), /^[\d.]+ [\d.]+$/);
});

// ---------- export identity ----------

test('a custom line on a stepped level is ONE feature, not two', () => {
  const grid = coneGrid();
  const stepped = [60, 65, 70];
  const custom = [line({ levelDb: 65, label: 'Night limit' })];
  const traced = buildContourLines(grid, unionContourLevels(stepped, custom));
  const named = customTracesFrom(traced, custom).map((c) => c.set);
  const sets = [...steppedTracesFrom(traced, stepped, named.map((s) => s.threshold)), ...named];
  const thresholds = sets.map((s) => s.threshold).sort((a, b) => a - b);
  assert.deepEqual(thresholds, [60, 65, 70]);
  // The 65 that survives is the NAMED one.
  assert.equal(sets.find((s) => s.threshold === 65)?.label, 'Night limit');
});

test('an unnamed custom line still exports as a named one', () => {
  const grid = coneGrid();
  const custom = [line({ label: '', levelDb: 65 })];
  const traced = buildContourLines(grid, unionContourLevels([], custom));
  const [only] = customTracesFrom(traced, custom);
  // A blank LABEL is indistinguishable from a stepped contour, so a consumer
  // filtering on it to find the compliance lines would miss this one.
  assert.equal(only.set.label, '65 dB');
});

// ---------- label escaping ----------

test('escapeHtml neutralises a label before it reaches divIcon innerHTML', () => {
  assert.equal(
    escapeHtml('<img src=x onerror="alert(1)">'),
    '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;',
  );
  assert.equal(escapeHtml("O'Brien & Co"), 'O&#39;Brien &amp; Co');
  assert.equal(escapeHtml('40 dB'), '40 dB');
});

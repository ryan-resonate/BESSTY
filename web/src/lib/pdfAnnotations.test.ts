// Annotations as they reach the PDF.
//
// `buildPdf` as a whole needs a DOM (it fetches basemap tiles into a canvas),
// but the annotation layer does not, so it is drawn against a bare jsPDF
// document here. What matters is that the words a user typed and the distance a
// dimension measures actually land on the page, inside the map frame, in the
// house font — the parts that are silently wrong if the geometry is off.

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsPDF } from 'jspdf';

import { drawAnnotations } from './pdfReport';
import { fitFrame, PAGES } from './pdfExport';
import { useHouseFont } from './pdfFont';
import type { Annotation, Project } from './types';

const extent = { sw: [-33.61, 138.69] as [number, number], ne: [-33.59, 138.71] as [number, number] };
const frame = fitFrame(extent, PAGES['a4-landscape'], 16);
const MID: [number, number] = [-33.6, 138.7];

function projectWith(annotations: Annotation[]): Project {
  return {
    schemaVersion: 1, name: 'T', description: '', createdAt: '', updatedAt: '', owner: 'x',
    scenario: { windSpeed: 10, windSpeedReferenceHeight: 10, period: 'night', bandSystem: 'octave' },
    sources: [], barriers: [], receivers: [], annotations,
  };
}

/// jsPDF writes page content as a deflated stream unless told otherwise; the
/// uncompressed form is what makes text and operators greppable.
function draw(annotations: Annotation[]): string {
  const doc = new jsPDF({ compress: false });
  drawAnnotations(doc, projectWith(annotations), frame);
  return doc.output();
}

test('a note prints its text', () => {
  const out = draw([{
    id: 'a', kind: 'text', latLng: MID, text: 'Substation under separate assessment',
  }]);
  assert.ok(out.includes('Substation under separate assessment'));
});

test('an empty note prints nothing at all — no stray halo, no marker', () => {
  const empty = draw([{ id: 'a', kind: 'text', latLng: MID, text: '' }]);
  const none = draw([]);
  assert.equal(empty.length, none.length);
});

test('a note is drawn nine times: eight buffer copies plus the black one', () => {
  // The white buffer is what keeps black text legible on aerial imagery. If a
  // refactor drops it the text still appears, so only the count catches it.
  const out = draw([{ id: 'a', kind: 'text', latLng: MID, text: 'Note' }]);
  const occurrences = out.split('(Note)').length - 1;
  assert.equal(occurrences, 9);
});

test('a multi-line note prints every line', () => {
  const out = draw([{ id: 'a', kind: 'text', latLng: MID, text: 'Line one\nLine two' }]);
  assert.ok(out.includes('Line one'));
  assert.ok(out.includes('Line two'));
});

test('a dimension prints its measured length', () => {
  // 0.002° of latitude ≈ 222 m.
  const out = draw([{
    id: 'd', kind: 'dimension', from: [-33.601, 138.7], to: [-33.599, 138.7],
  }]);
  assert.match(out, /\(22[0-9]\.\d m\)/);
});

test('an explicit dimension label replaces the measurement', () => {
  const out = draw([{
    id: 'd', kind: 'dimension', from: [-33.601, 138.7], to: [-33.599, 138.7], label: '6 m min.',
  }]);
  assert.ok(out.includes('6 m min.'));
  assert.ok(!/\(22\d\.\d m\)/.test(out), 'the measurement should not also be printed');
});

test('a leader draws a line and its target dot', () => {
  const withLeader = draw([{
    id: 'a', kind: 'text', latLng: MID, text: 'Note', leaderTo: [-33.605, 138.705],
  }]);
  const without = draw([{ id: 'a', kind: 'text', latLng: MID, text: 'Note' }]);
  assert.ok(withLeader.length > without.length, 'the leader should add operators');
  // `l` is lineto: a leader adds strokes the plain note has none of.
  const strokes = (s: string) => (s.match(/\bl\b/g) ?? []).length;
  assert.ok(strokes(withLeader) > strokes(without));
});

test('annotations land inside the map frame, not off the page', () => {
  const doc = new jsPDF({ compress: false });
  drawAnnotations(doc, projectWith([
    { id: 'a', kind: 'text', latLng: MID, text: 'Centre' },
  ]), frame);
  const out = doc.output();
  // Text placement operators are `x y Td`, in PDF POINTS from the bottom-left,
  // while the frame is in millimetres from the top-left. Every placement must
  // sit within the frame once converted (with slack for the halo offsets and
  // the centring shift).
  const coords = [...out.matchAll(/([\d.]+) ([\d.]+) Td/g)].map((m) => [+m[1], +m[2]]);
  assert.ok(coords.length > 0, 'expected text placement operators');
  const PT_TO_MM = 25.4 / 72;
  const pageH = PAGES['a4-landscape'].heightMm;
  for (const [xPt, yPt] of coords) {
    const x = xPt * PT_TO_MM;
    const y = pageH - yPt * PT_TO_MM;
    assert.ok(x > frame.x - 20 && x < frame.x + frame.w + 20, `x ${x.toFixed(1)}mm outside frame`);
    assert.ok(y > frame.y - 20 && y < frame.y + frame.h + 20, `y ${y.toFixed(1)}mm outside frame`);
  }
});

test('a note with a leader but no text still draws its leader', () => {
  // The empty-text guard used to skip the leader too, so the map showed a
  // pointer the exported figure did not.
  const out = draw([{
    id: 'a', kind: 'text', latLng: MID, text: '', leaderTo: [-33.605, 138.705],
  }]);
  assert.ok((out.match(/\bl\b/g) ?? []).length > 0, 'expected the leader stroke');
});

test('a dimension whose ends coincide degrades quietly', () => {
  const out = draw([{ id: 'd', kind: 'dimension', from: MID, to: MID }]);
  assert.ok(out.includes('0.0 m'));
  assert.ok(!out.includes('NaN'));
});

test('annotation text is set in the house font when it is available', async () => {
  const doc = new jsPDF({ compress: false });
  await useHouseFont(doc);
  drawAnnotations(doc, projectWith([
    { id: 'a', kind: 'text', latLng: MID, text: 'Housed' },
  ]), frame);
  const out = doc.output();
  assert.ok(out.includes('Arimo'));
  assert.ok(/FontFile2/.test(out), 'the face should be embedded, not just referenced');
});

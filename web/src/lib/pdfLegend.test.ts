// The PDF legend, against the contour lines actually plotted.
//
// A compliance figure whose legend asserts a 40 dB contour that is not on the
// drawing is worse than one with no legend at all, so the legend has to be
// built from what the drawing pass produced rather than from what was
// requested. The unit test for the tracing layer cannot catch that: it exercises
// the selector in isolation and never reaches the legend.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildPdf, DEFAULT_PDF_OPTIONS } from './pdfReport';
import type { GridResult } from './gridCore';
import type { CustomContourLine, Project } from './types';

const extent = { sw: [-33.61, 138.69] as [number, number], ne: [-33.59, 138.71] as [number, number] };

/// A cone peaking at 60 dB(A) at the centre and falling away, so 50 dB is
/// crossed and 80 dB is not.
function coneGrid(): GridResult {
  const cols = 41;
  const rows = 41;
  const dbA = new Float32Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      // 50 dB falls at 10 cells from the centre — well inside the grid, not on
      // its edge, so the ring is unambiguous.
      dbA[r * cols + c] = 60 - Math.hypot(c - 20, r - 20);
    }
  }
  return { cols, rows, dbA, bounds: { sw: extent.sw, ne: extent.ne } } as unknown as GridResult;
}

const project: Project = {
  schemaVersion: 1, name: 'Legend', description: '', createdAt: '', updatedAt: '', owner: 'x',
  scenario: { windSpeed: 10, windSpeedReferenceHeight: 10, period: 'night', bandSystem: 'octave' },
  sources: [], barriers: [], receivers: [],
};

function line(over: Partial<CustomContourLine>): CustomContourLine {
  return {
    id: 'l', label: 'L', levelDb: 50, color: '#dc2626',
    widthPx: 2.5, dashed: true, export: true, ...over,
  };
}

async function renderWith(
  customContours: CustomContourLine[], showContours: boolean, legend: boolean,
): Promise<string> {
  const doc = await buildPdf({
    project,
    results: null,
    grid: coneGrid(),
    extent,
    palette: 'viridis',
    dbDomain: { min: 25, max: 60 },
    contourStepDb: 5,
    customContours,
    showContours,
    // No DOM in node, so `composeBasemap` returns null and `buildPdf` falls
    // back to a grey rectangle — which is all this test needs behind it.
    tileUrl: () => 'about:blank',
    attribution: 'test',
    options: { ...DEFAULT_PDF_OPTIONS, titleBlock: false, legend },
  });
  return doc.output();
}

const render = (c: CustomContourLine[], showContours = false) => renderWith(c, showContours, true);
const renderNoLegend = (c: CustomContourLine[], showContours = false) => renderWith(c, showContours, false);

/// The document with its timestamps removed, so two renders of the same figure
/// compare equal. Text is not greppable here — with Arimo embedded, jsPDF
/// writes glyph indices rather than the characters — so the comparison IS the
/// assertion.
function stable(pdf: string): string {
  return pdf.replace(/\/(?:Creation|Mod)Date\s*\([^)]*\)/g, '').replace(/\/ID\s*\[[^\]]*\]/g, '');
}

test('the legend lists only the compliance lines that were actually drawn', async () => {
  const drawn = line({ id: 'drawn', label: 'Night limit', levelDb: 50 });
  // The grid peaks at 60 dB, so an 80 dB line exists nowhere on it.
  const absent = line({ id: 'absent', label: 'Day limit', levelDb: 80 });

  const withBoth = stable(await render([drawn, absent]));
  const withDrawnOnly = stable(await render([drawn]));
  assert.equal(
    withBoth, withDrawnOnly,
    'a line the grid never reaches must add nothing — not a legend row, not a swatch',
  );

  // …and the drawn one genuinely does contribute, so the equality above is not
  // just two identical empty legends.
  assert.notEqual(withDrawnOnly, stable(await render([])));
});

test('with nothing drawn there is no compliance legend at all', async () => {
  // Compared against the same figure with the legend switched OFF: if the
  // legend is correctly suppressed, the option makes no difference. (Comparing
  // against "no custom lines at all" would fail on a stray line-width operator
  // from the drawing pass, which is not a legend.)
  const absent = [line({ id: 'absent', label: 'Day limit', levelDb: 80 })];
  assert.equal(
    stable(await render(absent)), stable(await renderNoLegend(absent)),
    'an empty titled legend box is worse than no legend',
  );
});

test('the legend is still drawn for the stepped bands when it should be', async () => {
  const withLegend = stable(await render([], true));
  const withoutLegend = stable(await renderNoLegend([], true));
  assert.notEqual(withLegend, withoutLegend, 'the legend option should still do something');
});

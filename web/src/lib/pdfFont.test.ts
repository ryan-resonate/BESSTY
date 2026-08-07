// The embedded house typeface.
//
// Two things actually matter and neither is visible by reading the code: the
// generated base64 must be a TrueType file jsPDF can parse, and Arimo must
// really carry Arial's metrics — a substitute that reflows text is not a
// substitute.

import test from 'node:test';
import assert from 'node:assert/strict';

import { jsPDF } from 'jspdf';

import { PDF_FONT, useHouseFont } from './pdfFont';
import { ARIMO_BOLD_B64, ARIMO_REGULAR_B64 } from './pdfFont.generated';

function bytes(b64: string): Uint8Array {
  return Uint8Array.from(Buffer.from(b64, 'base64'));
}

test('the generated faces are TrueType, not a WOFF that slipped through', () => {
  for (const b64 of [ARIMO_REGULAR_B64, ARIMO_BOLD_B64]) {
    const b = bytes(b64);
    // sfnt version 1.0 — a WOFF would start with 'wOFF' (0x774f4646).
    assert.equal((b[0] << 24 | b[1] << 16 | b[2] << 8 | b[3]) >>> 0, 0x00010000);
    assert.ok(b.length > 15000, 'suspiciously small for a latin subset');
  }
});

test('the faces carry the tables a PDF embedder needs', () => {
  const b = bytes(ARIMO_REGULAR_B64);
  const numTables = (b[4] << 8) | b[5];
  const tags = new Set<string>();
  for (let i = 0; i < numTables; i++) {
    const p = 12 + i * 16;
    tags.add(String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]));
  }
  for (const required of ['head', 'hhea', 'hmtx', 'maxp', 'cmap', 'glyf', 'loca', 'name']) {
    assert.ok(tags.has(required), `missing ${required} table`);
  }
});

test('head.checkSumAdjustment matches the file as rebuilt', () => {
  // It covers the WHOLE file, so it is only valid once the tables sit at their
  // new offsets. Carrying the WOFF's value over leaves it stale — invisible to
  // jsPDF and browsers, but not to strict validators or font installers.
  for (const b64 of [ARIMO_REGULAR_B64, ARIMO_BOLD_B64]) {
    const b = Buffer.from(b64, 'base64');
    const numTables = b.readUInt16BE(4);
    let headOffset = -1;
    for (let i = 0; i < numTables; i++) {
      const p = 12 + i * 16;
      if (b.toString('latin1', p, p + 4) === 'head') headOffset = b.readUInt32BE(p + 8);
    }
    assert.ok(headOffset > 0, 'no head table');
    const stored = b.readUInt32BE(headOffset + 8);
    const copy = Buffer.from(b);
    copy.writeUInt32BE(0, headOffset + 8);
    let sum = 0;
    for (let i = 0; i + 3 < copy.length; i += 4) sum = (sum + copy.readUInt32BE(i)) >>> 0;
    assert.equal(stored, (0xb1b0afba - sum) >>> 0);
  }
});

test('jsPDF registers the font and reports it as available', async () => {
  const doc = new jsPDF();
  assert.equal(await useHouseFont(doc), true);
  const list = doc.getFontList();
  assert.ok(Object.keys(list).includes(PDF_FONT), `${PDF_FONT} not in ${Object.keys(list)}`);
  assert.ok(list[PDF_FONT].includes('normal'));
  assert.ok(list[PDF_FONT].includes('bold'));
});

test('Arimo carries Arial metrics — text must not reflow against the fallback', async () => {
  const doc = new jsPDF();
  await useHouseFont(doc);
  // Helvetica is jsPDF's built-in and shares Arial's advance widths for Latin;
  // if Arimo is genuinely metric-compatible then a measured string agrees with
  // it closely. A substitute that merely *looks* similar would not.
  for (const s of ['Substation under separate assessment', 'R12 — 41.3 dB(A)', '48.3 m']) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(9);
    const helv = doc.getTextWidth(s);
    doc.setFont(PDF_FONT, 'normal');
    doc.setFontSize(9);
    const arimo = doc.getTextWidth(s);
    const drift = Math.abs(arimo - helv) / helv;
    assert.ok(drift < 0.02, `"${s}": ${arimo.toFixed(3)} vs ${helv.toFixed(3)} (${(drift * 100).toFixed(1)}%)`);
  }
});

test('a document that uses the font actually embeds it', async () => {
  const doc = new jsPDF();
  await useHouseFont(doc);
  doc.setFontSize(9);
  doc.text('Lease boundary criterion', 10, 10);
  const out = doc.output();
  assert.ok(out.includes('Arimo'), 'the font resource should name the family');
  assert.ok(/FontFile2/.test(out), 'a TrueType font must be embedded as FontFile2');
});

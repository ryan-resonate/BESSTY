import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applySpectrumPaste, describePaste, parseSpectrumPaste,
} from './spectrumPaste';

const ok = (r: ReturnType<typeof parseSpectrumPaste>) => {
  assert.equal(r.ok, true, `expected a successful parse, got: ${r.ok ? '' : r.reason}`);
  return r as Extract<typeof r, { ok: true }>;
};

test('a horizontal Excel range parses as a row', () => {
  const r = ok(parseSpectrumPaste('88.1\t91.4\t93.0\t90.2'));
  assert.equal(r.orientation, 'row');
  assert.deepEqual(r.values, [88.1, 91.4, 93.0, 90.2]);
});

test('a vertical Excel range parses as a column', () => {
  const r = ok(parseSpectrumPaste('88.1\n91.4\n93.0\n90.2'));
  assert.equal(r.orientation, 'column');
  assert.deepEqual(r.values, [88.1, 91.4, 93.0, 90.2]);
});

test('Excel trailing newline and CRLF line endings are tolerated', () => {
  assert.deepEqual(ok(parseSpectrumPaste('88.1\r\n91.4\r\n')).values, [88.1, 91.4]);
  assert.deepEqual(ok(parseSpectrumPaste('88.1\n91.4\n\n')).values, [88.1, 91.4]);
});

test('a single value is reported as such so normal cell paste still works', () => {
  const r = ok(parseSpectrumPaste('88.1'));
  assert.equal(r.orientation, 'single');
  assert.deepEqual(r.values, [88.1]);
});

test('a genuine 2-D block is rejected', () => {
  const r = parseSpectrumPaste('88.1\t91.4\n93.0\t90.2');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /2 × 2 block/);
});

test('a non-numeric token rejects the whole paste — no partial writes', () => {
  const r = parseSpectrumPaste('88.1\t oops \t93.0');
  assert.equal(r.ok, false);
  assert.match((r as { reason: string }).reason, /"oops" isn't a number/);
});

test('blank cells are kept as null so later values keep their band', () => {
  // Dropping the blank would move 93.0 up into the 2nd band — a wrong level at
  // a wrong frequency that still looks plausible.
  const r = ok(parseSpectrumPaste('88.1\t\t93.0'));
  assert.deepEqual(r.values, [88.1, null, 93.0]);
});

test('an all-blank paste is refused rather than silently doing nothing', () => {
  assert.equal(parseSpectrumPaste('\t\t').ok, false);
  assert.equal(parseSpectrumPaste('').ok, false);
});

// ------------------------------------------------------------------- applying

const BANDS = 8;
const zeros = () => Array.from({ length: BANDS }, () => 0);

test('fill starts at the focused cell and leaves earlier bands alone', () => {
  const existing = zeros().map((_, i) => i + 1);       // 1..8
  const a = applySpectrumPaste(existing, 3, [50, 60], BANDS);
  assert.deepEqual(a.next, [1, 2, 3, 50, 60, 6, 7, 8]);
  assert.equal(a.written, 2);
  assert.equal(a.overflow, 0);
});

test('values past the last band are ignored and counted', () => {
  const a = applySpectrumPaste(zeros(), 6, [10, 20, 30, 40], BANDS);
  assert.deepEqual(a.next.slice(6), [10, 20]);
  assert.equal(a.written, 2);
  assert.equal(a.overflow, 2);
});

test('too few values fill only what was pasted', () => {
  const existing = zeros().map(() => 99);
  const a = applySpectrumPaste(existing, 0, [10, 20], BANDS);
  assert.deepEqual(a.next, [10, 20, 99, 99, 99, 99, 99, 99]);
  assert.equal(a.written, 2);
});

test('null values leave the existing band untouched', () => {
  const existing = zeros().map(() => 77);
  const a = applySpectrumPaste(existing, 0, [10, null, 30], BANDS);
  assert.deepEqual(a.next.slice(0, 3), [10, 77, 30]);
  assert.equal(a.written, 2);
  assert.equal(a.skipped, 1);
});

test('describePaste stays quiet when everything landed cleanly', () => {
  const clean = applySpectrumPaste(zeros(), 0, [1, 2, 3], BANDS);
  assert.equal(describePaste(clean, BANDS), null);

  const lossy = applySpectrumPaste(zeros(), 6, [1, 2, 3, 4], BANDS);
  assert.match(describePaste(lossy, BANDS) ?? '', /2 values past the last band ignored/);
});

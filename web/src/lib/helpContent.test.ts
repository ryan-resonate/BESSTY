import test from 'node:test';
import assert from 'node:assert/strict';

import { parseFrontMatter, parseMarkdown, toPlainText } from './helpContent';

test('front matter is split off and parsed', () => {
  const r = parseFrontMatter('---\ntitle: Sources\nsection: Building a model\n---\n\nBody text.');
  assert.equal(r.title, 'Sources');
  assert.equal(r.section, 'Building a model');
  assert.equal(r.body, 'Body text.');
});

test('a document without front matter still renders', () => {
  const r = parseFrontMatter('Just a body.');
  assert.equal(r.body, 'Just a body.');
  assert.equal(r.title, 'Untitled');
});

test('CRLF line endings are tolerated', () => {
  const r = parseFrontMatter('---\r\ntitle: X\r\n---\r\n\r\nBody.');
  assert.equal(r.title, 'X');
  assert.equal(r.body, 'Body.');
});

test('headings, paragraphs and lists parse', () => {
  const n = parseMarkdown('# Title\n\nA paragraph\nwrapped over lines.\n\n- one\n- two\n\n1. first\n2. second');
  assert.deepEqual(n.map((x) => x.t), ['h', 'p', 'ul', 'ol']);
  assert.equal((n[0] as { text: string }).text, 'Title');
  // A wrapped paragraph joins into one.
  assert.equal((n[1] as { text: string }).text, 'A paragraph wrapped over lines.');
  assert.deepEqual((n[2] as { items: string[] }).items, ['one', 'two']);
  assert.deepEqual((n[3] as { items: string[] }).items, ['first', 'second']);
});

test('tables parse into head + rows', () => {
  const n = parseMarkdown('| Key | Action |\n| --- | --- |\n| Esc | Cancel |\n| Del | Delete |');
  assert.equal(n.length, 1);
  const t = n[0] as { t: string; head: string[]; rows: string[][] };
  assert.equal(t.t, 'table');
  assert.deepEqual(t.head, ['Key', 'Action']);
  assert.deepEqual(t.rows, [['Esc', 'Cancel'], ['Del', 'Delete']]);
});

test('a pipe line that is not a table stays a paragraph', () => {
  // No separator row, so it is prose that happens to contain pipes.
  const n = parseMarkdown('| not a table');
  assert.equal(n[0].t, 'p');
});

test('the renderer supports no raw HTML, which is why it needs no sanitiser', () => {
  const n = parseMarkdown('<script>alert(1)</script>');
  assert.equal(n.length, 1);
  assert.equal(n[0].t, 'p');
  // It survives as literal TEXT — React escapes it on render, and no node type
  // can produce an element the renderer did not construct itself.
  assert.equal((n[0] as { text: string }).text, '<script>alert(1)</script>');
});

test('plain text strips markup for the search index', () => {
  const t = toPlainText('# Heading\n\n**bold** and `code` and [a link](http://x)');
  assert.match(t, /Heading/);
  assert.match(t, /bold/);
  assert.match(t, /a link/);
  assert.doesNotMatch(t, /\*\*/);
  assert.doesNotMatch(t, /http/);
});

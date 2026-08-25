// Share links: the token, and the sizing the publish dialog promises on.
//
// The token IS the credential. There is no second factor, no account, no
// revocable session — holding the string grants read access to everything in
// the snapshot. So the properties tested here are security properties: enough
// entropy that guessing is hopeless, uniform draw so one token says nothing
// about another, and a shape that cannot address a document path we did not
// mean.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_EXPIRY_DAYS,
  FIRESTORE_DOC_LIMIT,
  MAX_EXPIRY_DAYS,
  NO_RESULT,
  PAYLOAD_INLINE_LIMIT,
  TOKEN_LENGTH,
  clampExpiryDays,
  describeBytes,
  isShareToken,
  jsonBytes,
  mintShareToken,
  payloadHome,
  shareContoursOf,
  shareGridOf,
  shareIsLive,
  sizeOfState,
  type ShareState,
} from './share';
import type { GridResult } from './solver';

// ------------------------------------------------------------------ token

test('a token carries more than 190 bits of entropy', () => {
  // 62^32. Stated as the log so the assertion reads as the claim rather than
  // as an arbitrary number.
  const bits = TOKEN_LENGTH * Math.log2(62);
  assert.ok(bits > 190, `${bits.toFixed(1)} bits — the plan requires ≥190`);
});

test('every character is drawn uniformly — no biased tail folded back in', () => {
  // 256 % 62 is 8, so bytes 248..255 must be REJECTED. Folding them with a
  // plain modulo would make A–H about 3% likelier than the rest: not fatal on
  // its own, but it is free to get right and biased randomness in a credential
  // is exactly the kind of thing that compounds with a second mistake.
  //
  // Feed only the biased tail and require that nothing is produced from it.
  let calls = 0;
  const tailOnly = (n: number) => {
    calls++;
    // After a few rounds of pure tail, hand over one usable byte so the
    // generator can finish rather than spinning forever.
    if (calls > 3) return new Uint8Array(n).fill(0);       // 0 → 'A'
    return new Uint8Array(n).fill(250);                     // in the tail
  };
  const token = mintShareToken(tailOnly);
  assert.equal(token, 'A'.repeat(TOKEN_LENGTH));
  assert.ok(calls > 3, 'the biased bytes should have been rejected, not used');
});

test('a token is base62 of the stated length, and validates as one', () => {
  for (let i = 0; i < 50; i++) {
    const t = mintShareToken();
    assert.equal(t.length, TOKEN_LENGTH);
    assert.match(t, /^[A-Za-z0-9]{32}$/);
    assert.ok(isShareToken(t));
  }
});

test('tokens do not repeat', () => {
  // Not a randomness test — a collision here would mean the generator is
  // broken outright (a constant, or a mis-wired CSPRNG).
  const seen = new Set<string>();
  for (let i = 0; i < 500; i++) seen.add(mintShareToken());
  assert.equal(seen.size, 500);
});

test('anything that is not exactly a token is refused', () => {
  // The token becomes a Firestore document path. A value carrying a slash, a
  // wildcard or a traversal segment must never reach that lookup, and the
  // length check alone would not stop `../../users/abc` at the right length.
  for (const bad of [
    '', 'short', 'A'.repeat(31), 'A'.repeat(33),
    `${'A'.repeat(28)}/..x`,
    `${'A'.repeat(30)}..`,
    `${'A'.repeat(31)}-`,
    `${'A'.repeat(31)}_`,
    `${'A'.repeat(31)} `,
    null, undefined, 42, {}, ['A'.repeat(32)],
  ]) {
    assert.equal(isShareToken(bad), false, JSON.stringify(bad));
  }
});

// ----------------------------------------------------------------- expiry

test('expiry is clamped to something a person actually chose', () => {
  assert.equal(clampExpiryDays(90), 90);
  assert.equal(clampExpiryDays(0), 1);
  assert.equal(clampExpiryDays(-5), 1);
  assert.equal(clampExpiryDays(99999), MAX_EXPIRY_DAYS);
  assert.equal(clampExpiryDays(30.6), 31);
  // Non-finite input is not a choice, so it falls to the DEFAULT rather than
  // the maximum. The direction matters: this sets how long a public capability
  // URL stays valid, and "we could not read what you asked for" should never
  // resolve to "the longest possible".
  assert.equal(clampExpiryDays(NaN), DEFAULT_EXPIRY_DAYS);
  assert.equal(clampExpiryDays(Infinity), DEFAULT_EXPIRY_DAYS);
});

test('a share is live only while it is neither revoked nor expired', () => {
  const now = Date.parse('2026-08-25T00:00:00Z');
  const future = '2026-12-01T00:00:00Z';
  const past = '2026-01-01T00:00:00Z';
  assert.equal(shareIsLive({ revoked: false, expiresAt: future }, now), true);
  assert.equal(shareIsLive({ revoked: true, expiresAt: future }, now), false);
  assert.equal(shareIsLive({ revoked: false, expiresAt: past }, now), false);
  // A garbled expiry is not "no expiry".
  assert.equal(shareIsLive({ revoked: false, expiresAt: 'soon' }, now), false);
  assert.equal(shareIsLive({ revoked: false, expiresAt: '' }, now), false);
});

// ------------------------------------------------------------------- size

function gridOf(cells: number[]): GridResult {
  return {
    cols: 2, rows: cells.length / 2,
    bounds: { sw: [-33.7, 138.6], ne: [-33.5, 138.8] },
    dbA: new Float32Array(cells), computedMs: 1,
  };
}

test('a raster is rounded to a tenth, and a dead cell survives as a sentinel', () => {
  const g = shareGridOf(gridOf([30.123456, 41.98, NaN, -Infinity]));
  assert.deepEqual(g.dbA, [30.1, 42, NO_RESULT, NO_RESULT]);
  // JSON has no NaN; a null would change the array's type at the far end.
  assert.ok(Number.isFinite(NO_RESULT));
  assert.ok(JSON.stringify(g).includes(String(NO_RESULT)));
});

test('rounding a raster is what makes a share fit', () => {
  // Not cosmetic. Full float text is ~17 characters a cell; on a real grid that
  // is the difference between fitting in a Firestore document and not.
  const cells = Array.from({ length: 2000 }, (_, i) => 30 + Math.sin(i) * 5);
  const raw = jsonBytes(Array.from(cells));
  const rounded = jsonBytes(shareGridOf(gridOf(cells)).dbA);
  assert.ok(rounded < raw / 2, `${rounded} should be well under half of ${raw}`);
});

test('contour vertices are trimmed to a centimetre', () => {
  const sets = shareContoursOf([{
    threshold: 35,
    lines: [[[-27.123456789012, 152.987654321098]]],
  }]);
  assert.deepEqual(sets[0].lines[0][0], [-27.1234568, 152.9876543]);
  // An unnamed set gains no empty label — a consumer filtering on it would
  // otherwise not be able to tell a compliance line from a palette step.
  assert.equal('label' in sets[0], false);
});

test('a state is priced by its parts, so the dialog can name the expensive half', () => {
  const state: ShareState = {
    period: 'night',
    windSpeed: 10,
    receivers: [{ id: 'R1', levelDb: 38, assessedDb: 38, limitDb: 40, exceeds: false }],
    contours: shareContoursOf([{ threshold: 35, lines: [[[-27, 152], [-27.1, 152.1]]] }]),
    grid: shareGridOf(gridOf(Array.from({ length: 400 }, () => 35))),
  };
  const size = sizeOfState(state);
  assert.ok(size.gridBytes > size.contourBytes, 'the raster is the expensive half');
  assert.ok(size.bytes > size.gridBytes + size.contourBytes);
  // …and the total is the real encoded length, not an estimate.
  assert.equal(size.bytes, new TextEncoder().encode(JSON.stringify(state)).length);
});

test('the inline limit leaves real headroom under Firestore’s ceiling', () => {
  // The document also carries its own metadata, and Firestore counts field
  // names and encoding overhead toward the 1 MB cap — not just the JSON we can
  // measure. A share that publishes and then fails to save is the worst
  // outcome, so the margin is deliberate.
  assert.ok(PAYLOAD_INLINE_LIMIT < FIRESTORE_DOC_LIMIT * 0.85);
  assert.equal(payloadHome(PAYLOAD_INLINE_LIMIT), 'firestore');
  assert.equal(payloadHome(PAYLOAD_INLINE_LIMIT + 1), 'storage');
  assert.equal(payloadHome(0), 'firestore');
});

test('sizes read the way a person would say them', () => {
  assert.equal(describeBytes(512), '512 B');
  assert.equal(describeBytes(2048), '2 kB');
  assert.equal(describeBytes(3 * 1024 * 1024), '3.0 MB');
});

// The Esri base-layer tile climb.
//
// The bug these tests were written for: the climb's floor zoom was used as the
// loop's ENTRY condition, so a tile requested below the floor never made even
// one attempt at loading. The layer returned an empty canvas for every tile,
// and the satellite base map went completely blank at zoom 9 and below — no
// error, no failed request, just nothing. Reported as "it stops loading the
// map and then goes blank at a certain point".
//
// Hence the emphasis below on zooms BELOW the floor. Everything else here is
// the surrounding arithmetic that has to keep working while that is fixed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { BoundedCache, climbFloor, resolveTile } from './esriTiles';

/// A stand-in for a decoded tile image. `real` distinguishes genuine imagery
/// from Esri's grey placeholder.
interface FakeTile { z: number; x: number; y: number; real: boolean }

const isPlaceholder = (t: FakeTile) => !t.real;

/// A loader over an explicit set of zooms that hold real imagery. Records
/// every address it was asked for, so a test can assert on what was NOT
/// requested as well as what was.
function loaderFor(realZooms: number[], missing: string[] = []) {
  const asked: string[] = [];
  const load = async (z: number, x: number, y: number): Promise<FakeTile | null> => {
    asked.push(`${z}/${x}/${y}`);
    if (missing.includes(`${z}/${x}/${y}`)) return null;
    return { z, x, y, real: realZooms.includes(z) };
  };
  return { load, asked };
}

// ------------------------------------------------------------- the blanking

test('a tile BELOW the floor zoom still loads — the floor is not a minimum zoom', async () => {
  // The regression. With a floor of 10, a z=6 request must still fetch z=6.
  // The old code tested `z >= floorZoom` before the first attempt, so this
  // returned null and the tile was painted empty.
  const { load, asked } = loaderFor([6]);
  const plan = await resolveTile({ z: 6, x: 29, y: 39 }, 10, load, isPlaceholder);

  assert.notEqual(plan, null, 'a tile below the floor must still resolve');
  assert.equal(plan?.levelsUp, 0);
  assert.deepEqual(asked, ['6/29/39'], 'exactly one attempt, at the requested zoom');
});

test('every zoom from 0 up to the floor resolves', async () => {
  // Not just one sample: the whole range the user can reach by zooming out.
  for (let z = 0; z <= 10; z++) {
    const { load } = loaderFor([z]);
    const plan = await resolveTile({ z, x: 0, y: 0 }, 10, load, isPlaceholder);
    assert.notEqual(plan, null, `zoom ${z} must resolve`);
  }
});

test('below the floor, the climb does not run past the requested tile', async () => {
  // The floor still has to do its job in the other direction. A z=3 tile with
  // no imagery must not walk to z=2, z=1, z=0 hunting for a parent — there is
  // nothing useful up there, and each step is another request.
  const { load, asked } = loaderFor([]);
  const plan = await resolveTile({ z: 3, x: 4, y: 5 }, 10, load, isPlaceholder);

  assert.equal(plan, null);
  assert.deepEqual(asked, ['3/4/5'], 'one attempt, no climb below the request');
});

// ------------------------------------------------------------- the climb

test('a placeholder climbs to the nearest ancestor holding real imagery', async () => {
  // z=14 and z=13 are placeholders, z=12 is real: two levels up, so the source
  // is drawn at 4x and cropped to the quadrant the request lives in.
  const { load, asked } = loaderFor([12]);
  const plan = await resolveTile({ z: 14, x: 13, y: 9 }, 10, load, isPlaceholder);

  assert.equal(plan?.levelsUp, 2);
  assert.equal(plan?.img.z, 12);
  assert.deepEqual(asked, ['14/13/9', '13/6/4', '12/3/2']);
  // 13 = 0b1101 and 9 = 0b1001; the low two bits are the sub-tile index.
  assert.equal(plan?.srcSize, 64);
  assert.equal(plan?.srcX, 1 * 64);
  assert.equal(plan?.srcY, 1 * 64);
});

test('a tile that loads at native zoom is drawn whole, unscaled', async () => {
  const { load } = loaderFor([15]);
  const plan = await resolveTile({ z: 15, x: 7, y: 3 }, 10, load, isPlaceholder);

  assert.deepEqual(
    { levelsUp: plan?.levelsUp, srcX: plan?.srcX, srcY: plan?.srcY, srcSize: plan?.srcSize },
    { levelsUp: 0, srcX: 0, srcY: 0, srcSize: 256 },
  );
});

test('a failed load climbs the same way a placeholder does', async () => {
  // A 404 or a network error is no more useful than the grey card, so it must
  // not abandon the tile while an ancestor might still cover it.
  const { load } = loaderFor([13, 14], ['14/8/8']);
  const plan = await resolveTile({ z: 14, x: 8, y: 8 }, 10, load, isPlaceholder);

  assert.equal(plan?.levelsUp, 1);
  assert.equal(plan?.img.z, 13);
});

test('the climb stops at the floor and reports total failure', async () => {
  // Nothing anywhere: the caller paints an empty tile rather than Esri's card.
  const { load, asked } = loaderFor([]);
  const plan = await resolveTile({ z: 13, x: 100, y: 100 }, 10, load, isPlaceholder);

  assert.equal(plan, null);
  assert.deepEqual(asked.map((a) => a.split('/')[0]), ['13', '12', '11', '10']);
});

test('a placeholder AT the floor is reported as failure, not drawn upscaled', async () => {
  // The old code fell out of the loop holding the last image it fetched and
  // drew it regardless, so exhausting the climb stretched the grey "Map data
  // not yet available" card across the tile — the exact artefact the whole
  // layer exists to avoid.
  const { load } = loaderFor([]);
  assert.equal(await resolveTile({ z: 12, x: 1, y: 1 }, 10, load, isPlaceholder), null);
});

test('climbFloor never returns a floor above the tile being requested', () => {
  assert.equal(climbFloor(14, 10), 10);
  assert.equal(climbFloor(10, 10), 10);
  assert.equal(climbFloor(6, 10), 6, 'a z=6 request floors at 6, not 10');
  assert.equal(climbFloor(0, 10), 0);
});

// ------------------------------------------------------------------ cache

test('the cache evicts oldest-first once it is full', () => {
  const c = new BoundedCache<number>(3);
  c.set('a', 1); c.set('b', 2); c.set('c', 3);
  c.set('d', 4);

  assert.equal(c.size, 3, 'the limit is a hard bound, not a target');
  assert.equal(c.get('a'), undefined, 'the oldest entry went');
  assert.deepEqual([c.get('b'), c.get('c'), c.get('d')], [2, 3, 4]);
});

test('overwriting an existing key does not evict anything', () => {
  // Re-setting the hottest entry must not cost the oldest one its place —
  // the cache did not grow, so nothing needs to leave.
  const c = new BoundedCache<number>(2);
  c.set('a', 1); c.set('b', 2);
  c.set('b', 22);

  assert.equal(c.size, 2);
  assert.deepEqual([c.get('a'), c.get('b')], [1, 22]);
});

test('clearing releases everything', () => {
  // The layer clears on removal; without it, every decoded tile image stays
  // reachable for as long as the page lives.
  const c = new BoundedCache<number>(4);
  c.set('a', 1); c.set('b', 2);
  c.clear();

  assert.equal(c.size, 0);
  assert.equal(c.get('a'), undefined);
});

test('a cache of limit 1 holds only the newest entry', () => {
  // The degenerate bound, where an off-by-one in the eviction loop shows up.
  const c = new BoundedCache<number>(1);
  c.set('a', 1); c.set('b', 2);

  assert.equal(c.size, 1);
  assert.deepEqual([c.get('a'), c.get('b')], [undefined, 2]);
});

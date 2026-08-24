// The wind-direction correction, and the convention it hangs on.
//
// The failure mode this file exists to prevent is a silent 180° error:
// `windFromDeg` is METEOROLOGICAL (the direction the wind blows FROM), so a
// receiver is downwind when it lies OPPOSITE it. Get that backwards and every
// number still looks plausible — the penalty lands on exactly the wrong
// receivers, and the schedule curtails the wrong turbines.
//
// These figures are cross-checked against Resonate's standalone curtailment
// tool (`compute_direction_adjustments`), which is the reference the two are
// meant to agree with.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_DIRECTIVITY,
  adjustmentAtBand,
  angleBetweenDeg,
  bearingDeg,
  describeWindFrom,
  directivityAdjustmentDb,
  offDownwindDeg,
  sectorFor,
  sweepDirections,
  type DirectivityContext,
  type SectorDirectivity,
} from './directivity';

const ctx = (bearing: number, windFrom: number): DirectivityContext => ({
  bearingDeg: bearing,
  windFromDeg: windFrom,
  distanceM: 1000,
  sourceHeightM: 100,
  receiverHeightM: 1.5,
});

// -------------------------------------------------------------- bearings

test('bearings read clockwise from north', () => {
  const origin: [number, number] = [-27, 152];
  const north: [number, number] = [-26.99, 152];
  const east: [number, number] = [-27, 152.01];
  const south: [number, number] = [-27.01, 152];
  const west: [number, number] = [-27, 151.99];
  assert.ok(Math.abs(bearingDeg(origin, north) - 0) < 0.1, 'north');
  assert.ok(Math.abs(bearingDeg(origin, east) - 90) < 0.1, 'east');
  assert.ok(Math.abs(bearingDeg(origin, south) - 180) < 0.1, 'south');
  assert.ok(Math.abs(bearingDeg(origin, west) - 270) < 0.1, 'west');
});

test('angles wrap the short way round', () => {
  assert.equal(angleBetweenDeg(10, 350), 20);
  assert.equal(angleBetweenDeg(350, 10), 20);
  assert.equal(angleBetweenDeg(0, 180), 180);
  assert.equal(angleBetweenDeg(90, 90), 0);
  assert.equal(angleBetweenDeg(-10, 10), 20, 'negative bearings normalise');
});

// ------------------------------------------------------------ convention

test('downwind is OPPOSITE the direction the wind comes from', () => {
  // A northerly (wind FROM 0°) blows towards the south, so a receiver due
  // SOUTH of a turbine is the one downwind of it.
  assert.equal(offDownwindDeg(180, 0), 0, 'receiver to the south, wind from the north');
  assert.equal(offDownwindDeg(0, 0), 180, 'receiver to the north is dead upwind');
  // A westerly (wind FROM 270°) blows towards the east.
  assert.equal(offDownwindDeg(90, 270), 0);
  assert.equal(offDownwindDeg(270, 270), 180);
});

// --------------------------------------------------------------- sectors

test('the default rule is ±60° clear, −2 dB beyond', () => {
  // Matches the standalone tool: `0.0 if diff <= 60.0 else -2.0`.
  const windFrom = 0;              // northerly ⇒ downwind bearing is 180°
  const at = (bearing: number) => directivityAdjustmentDb(DEFAULT_DIRECTIVITY, ctx(bearing, windFrom));
  assert.equal(at(180), 0, 'dead downwind');
  assert.equal(at(120), 0, 'exactly 60° off — inside, as the reference uses <=');
  assert.equal(at(240), 0, 'the other 60° edge');
  assert.equal(at(119), -2, 'just outside');
  assert.equal(at(90), -2, 'crosswind');
  assert.equal(at(0), -2, 'dead upwind');
});

test('a bearing on the wrap-around still classifies correctly', () => {
  // Wind from the south (180°) blows north, so downwind is 0° — the bearing
  // where the wrap sits, and where an unwrapped subtraction would fail.
  const at = (bearing: number) => directivityAdjustmentDb(DEFAULT_DIRECTIVITY, ctx(bearing, 180));
  assert.equal(at(0), 0);
  assert.equal(at(350), 0, '10° off downwind across the wrap');
  assert.equal(at(50), 0);
  // 300° is 60° from downwind the short way round, so it is still INSIDE the
  // sector — an unwrapped |300 − 0| would read 300° and wrongly penalise it.
  assert.equal(offDownwindDeg(300, 180), 60);
  assert.equal(at(300), 0);
  assert.equal(at(290), -2, '70° off, across the wrap, is outside');
});

test('the model has no effect when switched off', () => {
  assert.equal(directivityAdjustmentDb({ kind: 'none' }, ctx(0, 0)), 0);
  assert.equal(directivityAdjustmentDb({ kind: 'none' }, ctx(90, 180)), 0);
});

// -------------------------------------------------------------- flexibility

test('a three-sector model separates sidewind from upwind', () => {
  // The shape Ryan expects to move to: −2 dB across the sides, and something
  // else again upwind. Nothing but the model literal changes.
  const threeWay: SectorDirectivity = {
    kind: 'sector',
    downwindHalfAngleDeg: 60,
    crosswindHalfAngleDeg: 120,
    crosswindDb: -2,
    upwindDb: -6,
  };
  const at = (bearing: number) => directivityAdjustmentDb(threeWay, ctx(bearing, 0));
  assert.equal(at(180), 0, 'downwind');
  assert.equal(at(90), -2, '90° off downwind is sidewind');
  assert.equal(at(0), -6, 'dead upwind gets its own value');
  assert.equal(sectorFor(threeWay, 0), 'downwind');
  assert.equal(sectorFor(threeWay, 60), 'downwind');
  assert.equal(sectorFor(threeWay, 61), 'crosswind');
  assert.equal(sectorFor(threeWay, 120), 'crosswind');
  assert.equal(sectorFor(threeWay, 121), 'upwind');
});

test('the current rule is the three-sector model with no upwind sector', () => {
  // Worth pinning: `crosswindHalfAngleDeg: 180` is exactly what makes the
  // default collapse to the two-way rule, so `upwindDb` is unreachable today.
  assert.equal(DEFAULT_DIRECTIVITY.crosswindHalfAngleDeg, 180);
  assert.equal(sectorFor(DEFAULT_DIRECTIVITY, 180), 'crosswind');
  const noUpwind = { ...DEFAULT_DIRECTIVITY, upwindDb: -99 };
  for (let b = 0; b < 360; b += 5) {
    assert.notEqual(
      directivityAdjustmentDb(noUpwind, ctx(b, 0)), -99,
      `bearing ${b} reached the upwind sector, which should be unreachable`,
    );
  }
});

test('a per-band adjustment is readable, for a model that varies with frequency', () => {
  // The ISO upwind treatment is expected to be frequency-dependent, so the
  // seam accepts an array as well as a scalar.
  const perBand = new Float64Array([0, -1, -2, -3]);
  assert.equal(adjustmentAtBand(perBand, 2), -2);
  assert.equal(adjustmentAtBand(-2, 2), -2, 'a scalar applies to every band');
  assert.equal(adjustmentAtBand(undefined, 2), 0);
  assert.equal(adjustmentAtBand(perBand, 99), 0, 'past the end is no adjustment, not NaN');
});

// ------------------------------------------------------------------ sweep

test('a sweep covers the compass once, without repeating north', () => {
  assert.equal(sweepDirections(10).length, 36);
  assert.deepEqual(sweepDirections(90), [0, 90, 180, 270]);
  assert.equal(sweepDirections(10)[0], 0);
  assert.ok(!sweepDirections(10).includes(360));
});

test('a swept direction is labelled by where the wind comes FROM', () => {
  assert.match(describeWindFrom(0), /^0° \(N\)$/);
  assert.match(describeWindFrom(90), /^90° \(E\)$/);
  assert.match(describeWindFrom(270), /^270° \(W\)$/);
  assert.match(describeWindFrom(225), /^225° \(SW\)$/);
});

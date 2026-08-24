// The wind correction reaching the optimiser, not just existing in isolation.
//
// `directivity.test.ts` pins the sector arithmetic. What this adds is the wiring
// question: does a receiver that is upwind of a turbine actually get credited
// in the cell model, and does that change the schedule? A correction computed
// perfectly and then dropped on the floor looks exactly like no correction.

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildCellModel, type TransferMatrix } from './curtailment';
import { DEFAULT_DIRECTIVITY } from './directivity';
import type { CatalogEntry, Project, Receiver, Source } from './types';

// Two turbines 1 km either side of a receiver, north and south of it, so one is
// downwind and the other upwind for any east–west wind.
const RX: [number, number] = [-27.0, 152.0];
const NORTH: [number, number] = [-26.991, 152.0];   // ~1 km north of the receiver
const SOUTH: [number, number] = [-27.009, 152.0];   // ~1 km south

function entry(): CatalogEntry {
  const bands = Array.from({ length: 10 }, () => 100);
  return {
    id: 'wtg', displayName: 'T', kind: 'wtg', origin: 'user',
    defaultMode: 'full',
    modes: [
      {
        name: 'full', bandSystem: 'octave', weighting: 'Z',
        frequencies: [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000],
        spectra: { '8': bands }, windSpeeds: [8],
        powerKw: { '8': 3000 },
      },
      {
        name: 'quiet', bandSystem: 'octave', weighting: 'Z',
        frequencies: [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000],
        spectra: { '8': bands.map((b) => b - 6) }, windSpeeds: [8],
        powerKw: { '8': 2400 },
      },
    ],
  } as unknown as CatalogEntry;
}

function turbine(id: string, latLng: [number, number]): Source {
  return {
    id, name: id, kind: 'wtg', latLng,
    modelId: 'wtg', catalogScope: 'local', hubHeight: 100,
  } as Source;
}

function receiver(): Receiver {
  return {
    id: 'R1', name: 'R1', latLng: RX, heightAboveGroundM: 1.5,
    limitDayDbA: 40, limitEveningDbA: 40, limitNightDbA: 40,
  } as Receiver;
}

function project(): Project {
  return {
    schemaVersion: 1, name: 'T', description: '', createdAt: '', updatedAt: '', owner: 'x',
    scenario: { windSpeed: 8, windSpeedReferenceHeight: 10, period: 'night', bandSystem: 'octave' },
    sources: [turbine('north', NORTH), turbine('south', SOUTH)],
    receivers: [receiver()],
    barriers: [],
    localCatalog: [entry()],
    settings: {
      ground: { defaultG: 0.5 },
      annexD: {
        barrierAbarCapDb: 3, useElevatedSourceForBarrier: true,
        applyConcaveCorrection: true, wtReceiverHeightMin: 4,
      },
      general: { defaultReceiverHeight: 1.5 },
      limitComparison: 'exact',
    } as Project['settings'],
  } as unknown as Project;
}

/// A flat −60 dB transfer in every band for both turbines, so the arithmetic is
/// easy to reason about and the only thing that varies is the wind correction.
function transfer(): TransferMatrix {
  const t = new Float64Array(10).fill(-60);
  const m: TransferMatrix = new Map();
  for (const id of ['north', 'south']) m.set(id, new Map([['R1', t]]));
  return m;
}

/// Energy the model says one turbine at its loudest puts into the receiver.
function fullPowerUse(p: Project, wind?: Parameters<typeof buildCellModel>[5]): Record<string, number> {
  const { cell } = buildCellModel(p, transfer(), 'night', 8, 0, wind);
  const out: Record<string, number> = {};
  cell.model.groups.forEach((g, i) => {
    // Option 0 is the first catalog mode — 'full'.
    out[cell.turbineIds[i]] = g.options[0].use[0];
  });
  return out;
}

test('with no wind direction, both turbines are treated identically', () => {
  // The default: every receiver downwind of everything, which is what
  // ISO 9613-2 says and what the rest of BESSTY reports.
  const use = fullPowerUse(project());
  assert.ok(Math.abs(use.north - use.south) < 1e-12,
    'identical geometry and no correction must give identical energy');
});

test('an upwind turbine is credited and a downwind one is not', () => {
  // Wind FROM the north (0°) blows south. The receiver is SOUTH of the north
  // turbine (downwind of it) and NORTH of the south turbine (upwind of it).
  const use = fullPowerUse(project(), {
    windDirectionDeg: 0,
    model: DEFAULT_DIRECTIVITY,
    onFixedSources: false,
  });
  const noWind = fullPowerUse(project());

  assert.ok(Math.abs(use.north - noWind.north) < 1e-12,
    'the downwind turbine gets no adjustment');
  // −2 dB is a factor of 10^(−0.2) in energy.
  const ratio = use.south / noWind.south;
  assert.ok(Math.abs(ratio - Math.pow(10, -0.2)) < 1e-9,
    `the upwind turbine should be credited −2 dB; energy ratio was ${ratio}`);
});

test('reversing the wind reverses which turbine is credited', () => {
  // The single most valuable assertion here: a 180° convention error passes
  // every test that only ever uses one wind direction.
  const fromNorth = fullPowerUse(project(), {
    windDirectionDeg: 0, model: DEFAULT_DIRECTIVITY, onFixedSources: false,
  });
  const fromSouth = fullPowerUse(project(), {
    windDirectionDeg: 180, model: DEFAULT_DIRECTIVITY, onFixedSources: false,
  });
  assert.ok(fromNorth.south < fromNorth.north, 'wind from the north credits the south turbine');
  assert.ok(fromSouth.north < fromSouth.south, 'wind from the south credits the north turbine');
  assert.ok(Math.abs(fromNorth.south - fromSouth.north) < 1e-12, 'and by the same amount');
});

test('a crosswind credits both turbines', () => {
  // Wind from the east: both turbines lie ~90° off the downwind line, so both
  // are outside the ±60° sector.
  const use = fullPowerUse(project(), {
    windDirectionDeg: 90, model: DEFAULT_DIRECTIVITY, onFixedSources: false,
  });
  const noWind = fullPowerUse(project());
  for (const id of ['north', 'south']) {
    const ratio = use[id] / noWind[id];
    assert.ok(Math.abs(ratio - Math.pow(10, -0.2)) < 1e-9, `${id} should be credited −2 dB`);
  }
});

test('the correction changes what the optimiser is allowed to do', () => {
  // The point of the whole feature: crediting the upwind turbine leaves more
  // headroom, so the receiver's available energy genuinely grows.
  const downwindOnly = buildCellModel(project(), transfer(), 'night', 8, 0).cell;
  const withWind = buildCellModel(project(), transfer(), 'night', 8, 0, {
    windDirectionDeg: 0, model: DEFAULT_DIRECTIVITY, onFixedSources: false,
  }).cell;

  // The cap itself is untouched — the correction is on the source side.
  assert.equal(downwindOnly.receivers[0].capDb, withWind.receivers[0].capDb);
  // …but the energy each turbine spends against it is lower.
  const spend = (c: typeof downwindOnly) =>
    c.model.groups.reduce((a, g) => a + g.options[0].use[0], 0);
  assert.ok(spend(withWind) < spend(downwindOnly),
    'crediting a turbine must reduce what it spends against the cap');
});

test('fixed sources are left alone unless asked for', () => {
  // Matching the standalone tool, which only ever holds turbine bearings. The
  // switch exists because the effect is arguably propagation rather than source
  // directivity, in which case it would apply to any source.
  const p = project();
  p.sources = [
    ...p.sources,
    {
      id: 'bess', name: 'BESS', kind: 'bess', latLng: SOUTH,
      modelId: 'wtg', catalogScope: 'local', elevationOffset: 0,
    } as Source,
  ];
  const t = transfer();
  t.set('bess', new Map([['R1', new Float64Array(10).fill(-60)]]));

  const off = buildCellModel(p, t, 'night', 8, 0, {
    windDirectionDeg: 0, model: DEFAULT_DIRECTIVITY, onFixedSources: false,
  }).cell;
  const on = buildCellModel(p, t, 'night', 8, 0, {
    windDirectionDeg: 0, model: DEFAULT_DIRECTIVITY, onFixedSources: true,
  }).cell;

  assert.ok(on.receivers[0].fixedEnergy < off.receivers[0].fixedEnergy,
    'the BESS is upwind, so switching this on must credit it');
  assert.ok(on.receivers[0].availableEnergy > off.receivers[0].availableEnergy,
    'and that leaves the turbines more room');
});

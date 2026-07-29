import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildScene, containerFootprint, groupReceiversByConcave, projectOrigin, sceneSettingsFor,
  wallFromBarrier, withConcave,
  type ResolvedSource, type SceneInput, type SceneWall,
} from './sceneBuilder';
import type { Barrier, Project } from './types';

const ORIGIN: [number, number] = [-27.0, 152.0];

/** DEM stub: elevation is a pure function of latitude so it's easy to predict. */
const rampDem = (metresPerDegLat = 0) => ({
  resolutionM: 20,
  elevation: (lat: number) => (lat - ORIGIN[0]) * metresPerDegLat,
}) as unknown as SceneInput['dem'];

const flatDem = rampDem(0);

const lw10 = () => Array.from({ length: 10 }, (_, i) => (i < 2 ? -100 : 95));

const baseSettings: SceneInput['settings'] = {
  standard: 'iso9613-2:2024',
  defaultG: 0.5,
  atmosphere: { temperatureC: 10, relativeHumidityPct: 70, pressureKpa: 101.325 },
  dzCapDb: null,
  c0Db: 0,
};

const src = (over: Partial<ResolvedSource> = {}): ResolvedSource => ({
  id: 's1', latLng: [-27.0, 152.0], heightAglM: 4, lw: lw10(), ...over,
});

const input = (over: Partial<SceneInput> = {}): SceneInput => ({
  origin: ORIGIN, sources: [src()], receivers: [], barriers: [],
  dem: flatDem, terrain: null, settings: baseSettings, ...over,
});

// ------------------------------------------------------------- source mapping

test('general source: z_abs = ground + height_agl, both datums emitted', () => {
  // 10 m/deg-lat ramp; source 0.001 deg north of origin → ground = 0.01 m.
  const scene = buildScene(input({
    dem: rampDem(1000),                       // 1000 m per degree
    sources: [src({ latLng: [ORIGIN[0] + 0.001, ORIGIN[1]], heightAglM: 4 })],
  }));
  assert.equal(scene.sources.length, 1);
  const s = scene.sources[0];
  assert.equal(s.kind.type, 'general');
  assert.ok(Math.abs(s.height_agl - 4) < 1e-9, 'height_agl is height above ground');
  assert.ok(Math.abs(s.position[2] - (1 + 4)) < 1e-6, `z_abs = ground(1) + 4, got ${s.position[2]}`);
  assert.deepEqual(s.lw, lw10());
});

test('wtg source maps to Annex D kind with rotor + concave flag', () => {
  const scene = buildScene(input({
    sources: [src({ wtg: { rotorDiameterM: 136, applyConcave: true }, heightAglM: 90 })],
  }));
  assert.deepEqual(scene.sources[0].kind, {
    type: 'wind_turbine', rotor_diameter_m: 136, apply_concave: true,
  });
  assert.equal(scene.sources[0].height_agl, 90);
});

test('non-finite source or receiver coordinates are dropped, not emitted as NaN', () => {
  const scene = buildScene(input({
    sources: [src(), src({ id: 'bad', latLng: [NaN, 152.0] })],
    receivers: [
      { id: 'r1', latLng: [-27.001, 152.0], heightAboveGroundM: 1.5 },
      { id: 'rbad', latLng: [-27.0, Infinity], heightAboveGroundM: 1.5 },
    ],
  }));
  assert.deepEqual(scene.sources.map((s) => s.id), ['s1']);
  assert.deepEqual(scene.receivers.map((r) => r.id), ['r1']);
  for (const v of [...scene.sources[0].position, ...scene.receivers[0].position]) {
    assert.ok(Number.isFinite(v));
  }
});

// --------------------------------------------------------------- wall mapping

const barrier = (over: Partial<Barrier> = {}): Barrier => ({
  id: 'b1', name: 'w', type: 'wall',
  polylineLatLng: [[-27.0, 152.0], [-27.0, 152.001]],
  topHeightsM: [4, 4], baseFromGroundM: 0, surfaceDensityKgM2: 20, absorptionCoeff: 0,
  ...over,
});

test('wall is densified to <=10 m spacing with per-vertex ground and crest', () => {
  // 0.001 deg lng at this latitude is ~99 m → needs >= 10 sub-segments.
  const wall = wallFromBarrier(barrier(), ORIGIN, flatDem) as SceneWall;
  assert.equal(wall.type, 'wall');
  assert.ok(wall.polyline.length >= 11, `expected >=11 vertices, got ${wall.polyline.length}`);
  assert.equal(wall.base_z.length, wall.polyline.length);
  assert.equal(wall.top_z!.length, wall.polyline.length);
  for (let i = 1; i < wall.polyline.length; i++) {
    const d = Math.hypot(
      wall.polyline[i][0] - wall.polyline[i - 1][0],
      wall.polyline[i][1] - wall.polyline[i - 1][1],
    );
    assert.ok(d <= 10 + 1e-6, `segment ${i} is ${d.toFixed(2)} m, want <= 10`);
  }
  // Flat ground → crest is a uniform 4 m above the base.
  for (let i = 0; i < wall.top_z!.length; i++) {
    assert.ok(Math.abs(wall.top_z![i] - wall.base_z[i] - 4) < 1e-9);
  }
  // top_z carries the crest, so height_agl must not double-count.
  assert.equal(wall.height_agl, 0);
});

test('wall crest follows terrain and interpolates per-vertex heights', () => {
  // Ramp along LATITUDE so a north-running wall climbs; ends 4 m and 8 m tall.
  const w = wallFromBarrier(
    barrier({ polylineLatLng: [[-27.0, 152.0], [-26.999, 152.0]], topHeightsM: [4, 8] }),
    ORIGIN,
    rampDem(1000),
  ) as SceneWall;
  const n = w.polyline.length;
  assert.ok(Math.abs(w.base_z[0] - 0) < 1e-6, 'first vertex on 0 m ground');
  assert.ok(w.base_z[n - 1] > w.base_z[0], 'ground rises along the wall');
  // Crest height above local ground goes 4 → 8 monotonically.
  const h = w.top_z!.map((t, i) => t - w.base_z[i]);
  assert.ok(Math.abs(h[0] - 4) < 1e-6, `start height ${h[0]}`);
  assert.ok(Math.abs(h[n - 1] - 8) < 1e-6, `end height ${h[n - 1]}`);
  for (let i = 1; i < n; i++) assert.ok(h[i] >= h[i - 1] - 1e-9, 'height increases monotonically');
});

test('a single barrier makes ONE wall obstacle (ends give the lateral edges)', () => {
  const scene = buildScene(input({ barriers: [barrier(), barrier({ id: 'b2' })] }));
  assert.equal(scene.obstacles.length, 2, 'one obstacle per drawn barrier, not per segment');
  assert.ok(scene.obstacles.every((o) => o.type === 'wall'));
});

test('degenerate barriers are skipped', () => {
  assert.equal(wallFromBarrier(barrier({ polylineLatLng: [[-27, 152]] }), ORIGIN, flatDem), null);
  assert.equal(
    wallFromBarrier(barrier({ polylineLatLng: [[-27, 152], [NaN, 152]] }), ORIGIN, flatDem),
    null,
  );
});

test('a multi-vertex polyline densifies without duplicated or missing joins', () => {
  // Three vertices with distinct heights: the join between edge 1 and edge 2
  // must appear exactly once, and the last vertex must carry its own height.
  const w = wallFromBarrier(
    barrier({
      polylineLatLng: [[-27.0, 152.0], [-27.0, 152.0005], [-26.9995, 152.0005]],
      topHeightsM: [3, 6, 9],
    }),
    ORIGIN,
    flatDem,
  ) as SceneWall;
  const heights = w.top_z!.map((t, i) => t - w.base_z[i]);
  assert.ok(Math.abs(heights[0] - 3) < 1e-9, 'first vertex height');
  assert.ok(Math.abs(heights[heights.length - 1] - 9) < 1e-9, 'last vertex height');
  // The corner (6 m) must be present exactly once, and heights must rise
  // monotonically 3 → 6 → 9 with no repeated vertex at the join.
  assert.ok(heights.some((h) => Math.abs(h - 6) < 1e-6), 'join height present');
  for (let i = 1; i < heights.length; i++) {
    assert.ok(heights[i] >= heights[i - 1] - 1e-9, 'monotone across the join');
  }
  for (let i = 1; i < w.polyline.length; i++) {
    const d = Math.hypot(w.polyline[i][0] - w.polyline[i - 1][0], w.polyline[i][1] - w.polyline[i - 1][1]);
    assert.ok(d > 1e-9, `no zero-length segment at ${i}`);
    assert.ok(d <= 10 + 1e-6, `segment ${i} within 10 m`);
  }
});

test('duplicated consecutive vertices are dropped rather than making a zero-length wall', () => {
  const w = wallFromBarrier(
    barrier({ polylineLatLng: [[-27.0, 152.0], [-27.0, 152.0], [-27.0, 152.001]], topHeightsM: [4, 4, 4] }),
    ORIGIN,
    flatDem,
  ) as SceneWall;
  for (let i = 1; i < w.polyline.length; i++) {
    const d = Math.hypot(w.polyline[i][0] - w.polyline[i - 1][0], w.polyline[i][1] - w.polyline[i - 1][1]);
    assert.ok(d > 1e-9, 'no zero-length segment survives');
  }
  // A polyline that is ENTIRELY duplicates has no geometry at all.
  assert.equal(
    wallFromBarrier(barrier({ polylineLatLng: [[-27, 152], [-27, 152]], topHeightsM: [4, 4] }), ORIGIN, flatDem),
    null,
  );
});

// ------------------------------------------------- Annex D.5 concave grouping

test('no turbines → a single receiver group (the common BESS case is free)', () => {
  const rxs = [{ id: 'r1' }, { id: 'r2' }];
  const groups = groupReceiversByConcave([src()], rxs, () => false);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].receivers.length, 2);
  assert.equal(groups[0].concaveBySourceId.size, 0);
});

test('receivers are split by their per-pair concave verdict, not the source', () => {
  // D.5 is a per source->receiver condition; r1 sits over a dip, r2 does not.
  const sources = [src({ id: 'w1', wtg: { rotorDiameterM: 136, applyConcave: false } })];
  const rxs = [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }];
  const groups = groupReceiversByConcave(sources, rxs, (_s, r) => (r as { id: string }).id === 'r1');
  assert.equal(groups.length, 2, 'disagreeing receivers cannot share a scene');
  const concaveGroup = groups.find((g) => g.concaveBySourceId.get('w1') === true)!;
  const flatGroup = groups.find((g) => g.concaveBySourceId.get('w1') === false)!;
  assert.deepEqual(concaveGroup.receivers.map((r) => (r as { id: string }).id), ['r1']);
  assert.deepEqual(flatGroup.receivers.map((r) => (r as { id: string }).id), ['r2', 'r3']);
  // Every receiver appears exactly once across the groups.
  assert.equal(groups.reduce((n, g) => n + g.receivers.length, 0), rxs.length);
});

test('withConcave stamps each group verdict onto its turbines only', () => {
  const sources = [
    src({ id: 'w1', wtg: { rotorDiameterM: 136, applyConcave: false } }),
    src({ id: 'b1' }),
  ];
  const stamped = withConcave(sources, new Map([['w1', true]]));
  assert.equal(stamped[0].wtg!.applyConcave, true);
  assert.equal(stamped[1].wtg, undefined, 'general sources untouched');
  assert.equal(sources[0].wtg!.applyConcave, false, 'input not mutated');
  // ...and it reaches the scene.
  const scene = buildScene(input({ sources: stamped }));
  assert.equal(scene.sources[0].kind.apply_concave, true);
});

// ----------------------------------------------------------------- containers

test('container footprint is a correctly oriented, centred rectangle', () => {
  // Bearing 0 → long axis north: 20 long (north-south) x 10 wide (east-west).
  const f = containerFootprint([0, 0], 20, 10, 0);
  assert.equal(f.length, 4);
  const eastings = f.map((p) => p[0]);
  const northings = f.map((p) => p[1]);
  assert.ok(Math.abs(Math.max(...eastings) - 5) < 1e-9, 'half-width east');
  assert.ok(Math.abs(Math.max(...northings) - 10) < 1e-9, 'half-length north');
  // Centroid stays on the source.
  assert.ok(Math.abs(eastings.reduce((a, b) => a + b, 0) / 4) < 1e-9);
  assert.ok(Math.abs(northings.reduce((a, b) => a + b, 0) / 4) < 1e-9);

  // Bearing 90 → long axis east: extents swap.
  const g = containerFootprint([0, 0], 20, 10, 90);
  assert.ok(Math.abs(Math.max(...g.map((p) => p[0])) - 10) < 1e-9, 'long axis now east');
  assert.ok(Math.abs(Math.max(...g.map((p) => p[1])) - 5) < 1e-9);

  // Rotation preserves side lengths (30° row).
  const r = containerFootprint([0, 0], 20, 10, 30);
  const side = (a: number, b: number) => Math.hypot(r[a][0] - r[b][0], r[a][1] - r[b][1]);
  assert.ok(Math.abs(side(0, 1) - 10) < 1e-9, 'width edge preserved under rotation');
  assert.ok(Math.abs(side(1, 2) - 20) < 1e-9, 'length edge preserved under rotation');
});

test('container is emitted and lifts the source to the roof + offset', () => {
  const withBox = src({ heightAglM: 1.5, container: { lengthM: 12, widthM: 3, heightM: 3, bearingDeg: 0 } });
  const scene = buildScene(input({ sources: [withBox], includeContainers: true, roofOffsetM: 0.3 }));
  const building = scene.obstacles.find((o) => o.type === 'building');
  assert.ok(building, 'container emitted as a building obstacle');
  assert.equal(scene.sources[0].height_agl, 3.3, 'clamped to container height + roof offset');
  assert.equal(scene.sources[0].position[2], 3.3, 'z_abs follows on flat ground');
});

test('a source already above the roof is NOT lowered', () => {
  const tall = src({ heightAglM: 9, container: { lengthM: 12, widthM: 3, heightM: 3, bearingDeg: 0 } });
  const scene = buildScene(input({ sources: [tall], includeContainers: true, roofOffsetM: 0.3 }));
  assert.equal(scene.sources[0].height_agl, 9);
});

test('containers are omitted (and no clamp applied) when the toggle is off', () => {
  const withBox = src({ heightAglM: 1.5, container: { lengthM: 12, widthM: 3, heightM: 3, bearingDeg: 0 } });
  const off = buildScene(input({ sources: [withBox], includeContainers: false }));
  assert.equal(off.obstacles.length, 0, 'no building obstacle');
  assert.equal(off.sources[0].height_agl, 1.5, 'height untouched');
  // The two toggles (receiver vs grid) must therefore produce different scenes.
  const on = buildScene(input({ sources: [withBox], includeContainers: true }));
  assert.notDeepEqual(off.obstacles, on.obstacles);
});

test('containers use the catalog footprint convention (widthM is the LONG axis)', () => {
  // BEESTY stores widthM = long axis, which at yaw 0 runs EAST along an
  // unrotated row; our bearing is clockwise-from-north, hence the +90 the
  // resolver applies. Verify the resulting box really is east-west at yaw 0.
  const f = containerFootprint([0, 0], 12, 3, 90);   // 12 m long axis at bearing 90
  const eastSpan = Math.max(...f.map((p) => p[0])) - Math.min(...f.map((p) => p[0]));
  const northSpan = Math.max(...f.map((p) => p[1])) - Math.min(...f.map((p) => p[1]));
  assert.ok(Math.abs(eastSpan - 12) < 1e-9, `long axis east: ${eastSpan}`);
  assert.ok(Math.abs(northSpan - 3) < 1e-9, `short axis north: ${northSpan}`);
});

test('a row of containers is emitted with a shared orientation', () => {
  // Three units on a 30° row: each gets its own box, all parallel, each centred
  // on its own unit.
  const units = [0, 1, 2].map((i) => src({
    id: `u${i}`,
    latLng: [ORIGIN[0] + i * 0.0001, ORIGIN[1] + i * 0.0001],
    heightAglM: 2,
    container: { lengthM: 12, widthM: 3, heightM: 3, bearingDeg: 30 },
  }));
  const scene = buildScene(input({ sources: units, includeContainers: true }));
  const boxes = scene.obstacles.filter((o) => o.type === 'building');
  assert.equal(boxes.length, 3, 'one box per unit');
  for (const b of boxes) {
    assert.equal(b.type === 'building' && b.footprint.length, 4);
    assert.equal(b.type === 'building' && b.height_agl, 3);
  }
  // All three must be parallel: the first edge vector has the same direction.
  const dir = (b: typeof boxes[number]) => {
    const f = (b as { footprint: Array<[number, number]> }).footprint;
    const [dx, dy] = [f[1][0] - f[0][0], f[1][1] - f[0][1]];
    return Math.atan2(dy, dx);
  };
  assert.ok(Math.abs(dir(boxes[0]) - dir(boxes[1])) < 1e-9);
  assert.ok(Math.abs(dir(boxes[1]) - dir(boxes[2])) < 1e-9);
});

// ------------------------------------------------------------------- settings

test('settings default to the 2024 edition and ISO reference atmosphere', () => {
  const s = sceneSettingsFor({ settings: undefined } as unknown as Project);
  assert.equal(s.standard, 'iso9613-2:2024');
  assert.deepEqual(s.atmosphere, { temperatureC: 10, relativeHumidityPct: 70, pressureKpa: 101.325 });
  assert.equal(s.defaultG, 0.5);
  assert.equal(s.dzCapDb, null, 'no cap override → standard ISO caps');
  assert.equal(s.c0Db, 0);
});

test('an OLD stored project (no standard, legacy topo knobs) still maps cleanly', () => {
  const legacy = {
    settings: {
      ground: { defaultG: 0.7 },
      atmosphere: { temperatureC: 15, relativeHumidityPct: 60, pressureKpa: 100 },
      barrierConvention: 'iso-eq16',                       // dead setting
      topography: { virtualBarrierMinHeightM: 2, pathSamples: 64 }, // dead knobs
      meteorology: { c0Db: 2 },
    },
  } as unknown as Project;
  const s = sceneSettingsFor(legacy);
  assert.equal(s.standard, 'iso9613-2:2024', 'absent standard → 2024, unchanged behaviour');
  assert.equal(s.defaultG, 0.7);
  assert.equal(s.c0Db, 2);
  assert.equal(s.atmosphere.temperatureC, 15);
});

test('the 1996 selector maps through, and a cap override is honoured', () => {
  const p = { settings: { standard: '1996', barrierDiffractionCapDb: 2 } } as unknown as Project;
  const s = sceneSettingsFor(p);
  assert.equal(s.standard, 'iso9613-2:1996');
  assert.equal(s.dzCapDb, 2);
  // A negative/garbage cap falls back to the standard caps.
  assert.equal(sceneSettingsFor({ settings: { barrierDiffractionCapDb: -1 } } as unknown as Project).dzCapDb, null);
});

test('project origin prefers the calculation area, then a receiver, then a source', () => {
  const area = { calculationArea: { centerLatLng: [1, 2] }, receivers: [], sources: [] } as unknown as Project;
  assert.deepEqual(projectOrigin(area), [1, 2]);
  const rx = { receivers: [{ latLng: [3, 4] }], sources: [{ latLng: [5, 6] }] } as unknown as Project;
  assert.deepEqual(projectOrigin(rx), [3, 4]);
  const only = { receivers: [], sources: [{ latLng: [5, 6] }] } as unknown as Project;
  assert.deepEqual(projectOrigin(only), [5, 6]);
});

// -------------------------------------------------------------- scene shape

test('scene carries the fields the engine requires and no extras', () => {
  const scene = buildScene(input({
    receivers: [{ id: 'r1', latLng: [-27.001, 152.0], heightAboveGroundM: 1.5 }],
    barriers: [barrier()],
  }));
  assert.equal(scene.schema_version, 1);
  assert.equal(scene.settings.ground_method, 'general');
  assert.equal(scene.settings.max_reflection_order, 1);
  assert.deepEqual(scene.ground, { default_g: 0.5, regions: [] });
  assert.deepEqual(scene.extended_sources, []);
  assert.equal(scene.terrain, null);
  // No DOmega anywhere — the web adds it after the solve.
  assert.ok(!JSON.stringify(scene).toLowerCase().includes('omega'));
});

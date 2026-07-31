// Integration: a Scene built by `sceneBuilder` must actually deserialize and
// solve in the Rust engine. The pure unit tests can only check the shape we
// THINK the engine wants; this closes the loop on the real schema.
//
// Requires a built wasm (`npm run build:wasm`).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import init, { solve_scene, WasmSession } from '../wasm/iso9613_wasm.js';
import { buildScene, type ResolvedSource, type SceneInput } from './sceneBuilder';
import { resolveContainer } from './catalogDims';
import type { Barrier } from './types';

const ORIGIN: [number, number] = [-27.0, 152.0];
const flatDem = { resolutionM: 20, elevation: () => 0 } as unknown as SceneInput['dem'];
const lw10 = () => Array.from({ length: 10 }, (_, i) => (i < 2 ? -100 : 95));

const src = (over: Partial<ResolvedSource> = {}): ResolvedSource => ({
  id: 's1', latLng: ORIGIN, heightAglM: 4, lw: lw10(), ...over,
});

const input = (over: Partial<SceneInput> = {}): SceneInput => ({
  origin: ORIGIN,
  sources: [src()],
  // ~200 m east of the origin.
  receivers: [{ id: 'r1', latLng: [ORIGIN[0], ORIGIN[1] + 0.002], heightAboveGroundM: 1.5 }],
  barriers: [],
  dem: flatDem,
  terrain: null,
  settings: {
    standard: 'iso9613-2:2024',
    defaultG: 0.5,
    atmosphere: { temperatureC: 10, relativeHumidityPct: 70, pressureKpa: 101.325 },
    dzCapDb: null,
    c0Db: 0,
  },
  ...over,
});

const solve = (i: SceneInput) => JSON.parse(solve_scene(JSON.stringify(buildScene(i))));

// The test runner bundles into a temp dir, so `import.meta.url` can't locate the
// wasm; it passes an absolute path instead (see `scripts/run-tests.mjs`).
const wasmPath = process.env.BEESTY_WASM_PATH
  ?? new URL('../wasm/iso9613_wasm_bg.wasm', import.meta.url).pathname;
await init({ module_or_path: readFileSync(wasmPath) });

test('a built scene deserializes and solves in the engine', () => {
  const r = solve(input());
  assert.equal(r.per_receiver.length, 1);
  assert.equal(r.per_receiver[0].receiver_id, 'r1');
  const total = r.per_receiver[0].total_dba;
  assert.ok(Number.isFinite(total) && total > 20 && total < 90, `plausible level, got ${total}`);
  assert.equal(r.per_receiver[0].per_source.length, 1, 'per-source breakdown survives');
  assert.equal(r.per_receiver[0].per_source[0].bands.length, 10);
});

test('every source kind and obstacle the builder emits is accepted', () => {
  const barrier: Barrier = {
    id: 'b1', name: 'w', type: 'wall',
    polylineLatLng: [[ORIGIN[0] - 0.0005, ORIGIN[1] + 0.001], [ORIGIN[0] + 0.0005, ORIGIN[1] + 0.001]],
    topHeightsM: [5, 5], baseFromGroundM: 0, surfaceDensityKgM2: 20, absorptionCoeff: 0,
  };
  const r = solve(input({
    sources: [
      src(),
      src({ id: 'wtg1', heightAglM: 90, wtg: { rotorDiameterM: 136, applyConcave: false } }),
      src({ id: 'box1', heightAglM: 2, container: { lengthM: 12, widthM: 3, heightM: 3, bearingDeg: 30 } }),
    ],
    barriers: [barrier],
    includeContainers: true,
  }));
  assert.equal(r.per_receiver[0].per_source.length, 3, 'general + wtg + containered source all solved');
  for (const s of r.per_receiver[0].per_source) {
    assert.ok(s.bands.every((b: number) => Number.isFinite(b)), `finite bands for ${s.source_id}`);
  }
});

test('a wall built by the builder actually screens', () => {
  const wallBetween: Barrier = {
    id: 'b1', name: 'w', type: 'wall',
    polylineLatLng: [[ORIGIN[0] - 0.001, ORIGIN[1] + 0.001], [ORIGIN[0] + 0.001, ORIGIN[1] + 0.001]],
    topHeightsM: [8, 8], baseFromGroundM: 0, surfaceDensityKgM2: 20, absorptionCoeff: 0,
  };
  const open = solve(input()).per_receiver[0].total_dba;
  const screened = solve(input({ barriers: [wallBetween] })).per_receiver[0].total_dba;
  assert.ok(screened < open - 3, `8 m wall screens: ${open.toFixed(2)} → ${screened.toFixed(2)} dBA`);
});

test('a container screens a NEIGHBOURING source behind it', () => {
  // A container never screens its OWN source — the roof clamp puts that source
  // above the roof by construction, so its ray grazes over the box. What the
  // feature buys is mutual screening within a row, so test that: unit B sits
  // behind unit A's box, on the far side from the receiver.
  const box = { lengthM: 40, widthM: 6, heightM: 6, bearingDeg: 0 };
  const behind = src({ id: 'B', latLng: [ORIGIN[0], ORIGIN[1] - 0.0002], heightAglM: 1.5 }); // ~20 m west
  const scene = (containers: boolean) => solve(input({
    sources: [src({ id: 'A', heightAglM: 2, container: box }), behind],
    includeContainers: containers,
    roofOffsetM: 0.3,
  }));
  const bandsOf = (r: ReturnType<typeof scene>, id: string) =>
    r.per_receiver[0].per_source.find((s: { source_id: string }) => s.source_id === id)!.bands;
  const off = bandsOf(scene(false), 'B');
  const on = bandsOf(scene(true), 'B');
  // B is untouched by the roof clamp (no container of its own), so any change is
  // screening by A's box. Compare the 1 kHz band.
  assert.ok(on[6] < off[6] - 1,
    `A's container must screen B: ${off[6].toFixed(2)} → ${on[6].toFixed(2)} dB @1kHz`);
});

test('enabling a container lifts a low source (net effect is not a silent no-op)', () => {
  const box = { lengthM: 30, widthM: 6, heightM: 6, bearingDeg: 0 };
  const onScene = buildScene(input({
    sources: [src({ heightAglM: 1.0, container: box })], includeContainers: true, roofOffsetM: 0.3,
  }));
  const offScene = buildScene(input({ sources: [src({ heightAglM: 1.0, container: box })] }));
  assert.equal(onScene.sources[0].height_agl, 6.3);
  assert.equal(offScene.sources[0].height_agl, 1.0);
  assert.equal(onScene.obstacles.length, 1);
  assert.equal(offScene.obstacles.length, 0);
});

// END-TO-END on the path the app actually takes: catalog entry → resolveContainer
// → buildScene → engine. The earlier container tests all hand-build a
// `ResolvedSource.container`, which is precisely why the feature could ship as a
// silent no-op — nothing exercised the resolver, and the resolver was the part
// that never fired. This one starts from a BARE catalog entry, as shipped.
test('a stock BESS row changes its answer when containers are switched on', () => {
  const entry = {
    id: 'mp', displayName: 'Stock unit', kind: 'bess',
    defaultMode: 'nominal', modes: [], origin: 'seed',
  } as unknown as Parameters<typeof resolveContainer>[1];

  // Six units in an east-west line, receiver 200 m further east, so the front
  // units stand between the back ones and the receiver.
  const units = Array.from({ length: 6 }, (_, i) => {
    const source = {
      id: `u${i}`, name: `U${i}`, kind: 'bess', modelId: 'mp', catalogScope: 'global',
      latLng: [ORIGIN[0], ORIGIN[1] + i * 0.00007],
    } as unknown as Parameters<typeof resolveContainer>[0];
    const container = resolveContainer(source, entry);
    assert.ok(container, `unit ${i}: a stock catalog entry must resolve a container`);
    return src({
      id: `u${i}`,
      latLng: [ORIGIN[0], ORIGIN[1] + i * 0.00007],
      heightAglM: 1.5,          // catalog default emission height
      container,
    });
  });

  // Receiver ~60 m east. Distance matters: every unit's acoustic centre is
  // clamped to roof + 0.3 m, so a source only falls below a NEIGHBOUR's roofline
  // once the ray descends steeply enough to get there. Across a 40 m row of
  // 2.6 m boxes that needs a close receiver — at 200 m the ray grazes the roofs
  // (screening ≈ 0.00 dB) and at 1 km it clears them entirely. Mutual screening
  // in a flat, uniform row is a near-field effect, not a far-field one.
  const scene = (containers: boolean) => buildScene(input({
    sources: units,
    receivers: [{ id: 'r1', latLng: [ORIGIN[0], ORIGIN[1] + 0.0006], heightAboveGroundM: 1.5 }],
    includeContainers: containers,
    roofOffsetM: 0.3,
  }));
  const off = scene(false);
  const on = scene(true);

  // The two things enabling the setting must do, neither of which happened before.
  assert.equal(off.obstacles.length, 0, 'off: no boxes');
  assert.equal(on.obstacles.length, 6, 'on: one box per unit');
  assert.equal(off.sources[0].height_agl, 1.5, 'off: bare catalog height');
  assert.equal(on.sources[0].height_agl, 2.9, 'on: clamped to roof (2.6) + 0.3');

  const lvl = (s: ReturnType<typeof scene>) =>
    JSON.parse(solve_scene(JSON.stringify(s))).per_receiver[0].total_dba as number;
  const a = lvl(off);
  const b = lvl(on);
  assert.ok(b < a - 1,
    `containers must screen a stock row at 60 m: ${a.toFixed(2)} → ${b.toFixed(2)} dBA`);
});

test('the session path accepts builder scenes and swaps receivers', () => {
  const session = new WasmSession(JSON.stringify(buildScene(input())));
  session.set_receivers(JSON.stringify([
    { id: 'c1', position: [100, 0, 1.5], height_agl: 1.5 },
    { id: 'c2', position: [400, 0, 1.5], height_agl: 1.5 },
  ]));
  const tile = JSON.parse(session.solve());
  assert.equal(tile.per_receiver.length, 2);
  assert.ok(tile.per_receiver[0].total_dba > tile.per_receiver[1].total_dba);
  session.free();
});

test('the 1996 edition selector reaches the engine and changes the result', () => {
  const y2024 = solve(input()).per_receiver[0].total_dba;
  const y1996 = solve(input({
    settings: { ...input().settings, standard: 'iso9613-2:1996' },
  })).per_receiver[0].total_dba;
  assert.ok(Number.isFinite(y1996));
  assert.notEqual(y1996, y2024, 'the two editions must not be identical for this geometry');
});

// ------------------------------------------------------------ I18 reflections

test('a wall listed as BOTH obstacle and reflector screens AND reflects', () => {
  // The engine keeps `obstacles` and `reflectors` separate so a reflected ray
  // isn't re-diffracted by the surface it bounced off — so the same wall
  // belongs in both lists. This looks like duplication; it is the contract.
  // Wall runs north-south, well to the SIDE of the source→receiver path, so it
  // reflects without screening.
  const beside: Barrier = {
    id: 'b1', name: 'w', type: 'wall',
    polylineLatLng: [[ORIGIN[0] + 0.0006, ORIGIN[1]], [ORIGIN[0] + 0.0006, ORIGIN[1] + 0.002]],
    topHeightsM: [8, 8], baseFromGroundM: 0, surfaceDensityKgM2: 20, absorptionCoeff: 0,
  };
  const scene = (refl: boolean) => buildScene(input({
    barriers: [beside], includeReflections: refl, maxReflectionOrder: 1,
  }));

  const off = scene(false);
  const on = scene(true);
  assert.equal(off.reflectors.length, 0, 'off: nothing reflects');
  assert.ok(on.reflectors.length > 0, 'on: facades emitted');
  assert.equal(on.obstacles.length, off.obstacles.length,
    'the wall still screens either way — reflectors are ADDITIONAL, not a swap');

  const lvl = (s: ReturnType<typeof scene>) =>
    JSON.parse(solve_scene(JSON.stringify(s))).per_receiver[0].total_dba as number;
  const a = lvl(off);
  const b = lvl(on);
  assert.ok(b > a, `a reflecting wall must ADD energy: ${a.toFixed(2)} → ${b.toFixed(2)} dBA`);
});

test('a fully absorptive wall contributes no reflection', () => {
  const beside = (alpha: number): Barrier => ({
    id: 'b1', name: 'w', type: 'wall',
    polylineLatLng: [[ORIGIN[0] + 0.0006, ORIGIN[1]], [ORIGIN[0] + 0.0006, ORIGIN[1] + 0.002]],
    topHeightsM: [8, 8], baseFromGroundM: 0, surfaceDensityKgM2: 20, absorptionCoeff: alpha,
  });
  const scene = (alpha: number) => buildScene(input({
    barriers: [beside(alpha)], includeReflections: true, maxReflectionOrder: 1,
  }));
  // alpha = 1 gives 10*lg(1-alpha) = -infinity, so the facade is culled entirely.
  assert.equal(scene(1).reflectors.length, 0);
  assert.ok(scene(0).reflectors.length > 0);
});

test('reflections stay off unless asked for, so existing projects are unchanged', () => {
  const s = buildScene(input({ barriers: [] }));
  assert.deepEqual(s.reflectors, []);
  assert.equal(s.settings.max_reflection_order, 1);
});

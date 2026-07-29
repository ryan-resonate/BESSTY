// Contract smoke-test for the Scene-JSON wasm surface.
//   node validation/smoke_wasm.mjs
// Verifies: one-shot solve, Session receiver swapping, barrier screening,
// and that every error path THROWS a catchable JS error rather than trapping.
import { readFileSync } from 'node:fs';
import init, {
  solve_scene, WasmSession, a_weighted_total, octave_centres, octave_a_weighting,
} from '../web/src/wasm/iso9613_wasm.js';

await init({ module_or_path: readFileSync(new URL('../web/src/wasm/iso9613_wasm_bg.wasm', import.meta.url)) });

let failures = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'ok  ' : 'FAIL'} ${msg}`); if (!cond) failures++; };

const lw = Array(10).fill(-100);
for (let i = 2; i < 10; i++) lw[i] = 95;

const scene = {
  schema_version: 1,
  standard: 'iso9613-2:2024',
  atmosphere: { temperature_c: 10, relative_humidity_pct: 70, pressure_kpa: 101.325 },
  ground: { default_g: 0.5, regions: [] },
  terrain: null,
  sources: [{ id: 's1', kind: { type: 'general' }, position: [0, 0, 4], height_agl: 4, lw }],
  extended_sources: [],
  receivers: [{ id: 'r1', position: [200, 0, 1.5], height_agl: 1.5 }],
  obstacles: [], reflectors: [], cylinders: [], amisc: {},
  settings: { c0_db: 0, ground_method: 'general', max_reflection_order: 1 },
};

// --- one-shot ---
const open = JSON.parse(solve_scene(JSON.stringify(scene)));
const openTotal = open.per_receiver[0].total_dba;
ok(Number.isFinite(openTotal) && openTotal > 20 && openTotal < 90, `one-shot solve → ${openTotal.toFixed(2)} dBA`);
ok(open.per_receiver[0].per_source.length === 1, 'per-source breakdown present');
ok(open.per_receiver[0].per_source[0].bands.length === 10, 'octave bands returned');

// --- session: swap receivers without rebuilding the scene (the grid path) ---
const s = new WasmSession(JSON.stringify(scene));
s.set_receivers(JSON.stringify([
  { id: 'c1', position: [100, 0, 1.5], height_agl: 1.5 },
  { id: 'c2', position: [400, 0, 1.5], height_agl: 1.5 },
]));
const tile = JSON.parse(s.solve());
ok(s.n_receivers() === 2, 'session receiver swap (n=2)');
ok(tile.per_receiver[0].total_dba > tile.per_receiver[1].total_dba, 'nearer cell louder than farther cell');

// --- barrier screening ---
const walled = structuredClone(scene);
walled.obstacles = [{ type: 'wall', polyline: [[100, -40], [100, 40]], base_z: [0, 0], height_agl: 6, top_z: null }];
const wallTotal = JSON.parse(solve_scene(JSON.stringify(walled))).per_receiver[0].total_dba;
ok(wallTotal < openTotal - 3, `6 m wall screens: ${openTotal.toFixed(2)} → ${wallTotal.toFixed(2)} dBA`);

// --- error paths must throw a real Error, never TRAP ---
// A wasm trap (`RuntimeError: unreachable`, i.e. a Rust panic) is also catchable,
// so "it threw" alone proves nothing: reject RuntimeError explicitly.
const throwsCleanly = (fn) => {
  try { fn(); return false; } catch (e) { return !(e instanceof WebAssembly.RuntimeError); }
};
ok(throwsCleanly(() => solve_scene('{not json')), 'malformed JSON throws (not a trap)');
ok(throwsCleanly(() => solve_scene(JSON.stringify({ ...scene, ground: { default_g: 5, regions: [] } }))), 'invalid scene (G=5) throws (not a trap)');
ok(throwsCleanly(() => new WasmSession('{not json')), 'Session bad JSON throws (not a trap)');
ok(throwsCleanly(() => a_weighted_total(new Float64Array(7))), 'a_weighted_total bad band count throws (not a trap)');

// --- session mutators are transactional: a rejected set_receivers must leave
// the session solving exactly as before (the core claims rollback) ---
const before = JSON.parse(s.solve()).per_receiver.map((x) => x.total_dba);
ok(throwsCleanly(() => s.set_receivers(JSON.stringify([{ id: 'bad', position: [0, 0, null], height_agl: 1.5 }]))),
  'set_receivers rejects a malformed batch (not a trap)');
const after = JSON.parse(s.solve()).per_receiver.map((x) => x.total_dba);
ok(s.n_receivers() === 2 && JSON.stringify(before) === JSON.stringify(after),
  'session unchanged and still solvable after a rejected set_receivers');

// ...and the stateless path still works afterwards (no poisoning)
ok(Number.isFinite(JSON.parse(solve_scene(JSON.stringify(scene))).per_receiver[0].total_dba), 'instance usable after errors');

// --- helpers ---
ok(octave_centres().length === 10 && octave_a_weighting().length === 10, 'octave helper arrays');
ok(Math.abs(a_weighted_total(new Float64Array(open.per_receiver[0].per_source[0].bands)) - openTotal) < 1e-9,
  'a_weighted_total matches core total');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nall smoke checks passed');
process.exit(failures ? 1 : 0);

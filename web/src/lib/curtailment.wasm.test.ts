// The assumption the curtailment optimiser is built on, checked against the
// engine rather than asserted.
//
// The claim: the per-band transfer `T = Lp − Lw` between a turbine and a
// receiver depends only on geometry, ground, atmosphere and barriers — never on
// the source's sound power. If that holds, one solve yields a matrix from which
// every candidate schedule can be evaluated by arithmetic, and the optimum is
// exactly reachable. If it does not hold anywhere — a level-dependent term, a
// clamp, a cap that bites at some powers and not others — then every number the
// optimiser produces is quietly wrong.
//
// So this drives the app's own `buildScene` → `solve_scene` path twice over the
// same geometry with very different sound powers, and requires the transfer to
// come back identical. The plan's tolerance is 0.01 dB.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import init, { solve_scene } from '../wasm/iso9613_wasm.js';
import { buildScene, type ResolvedSource, type SceneInput, type SceneResults } from './sceneBuilder';
import type { Barrier } from './types';

const wasmPath = process.env.BEESTY_WASM_PATH
  ?? new URL('../wasm/iso9613_wasm_bg.wasm', import.meta.url).pathname;
await init({ module_or_path: readFileSync(wasmPath) });

const ORIGIN: [number, number] = [-27.0, 152.0];
const R = 6371008.8;

function at(e: number, n: number): [number, number] {
  return [
    ORIGIN[0] + (n / R) * (180 / Math.PI),
    ORIGIN[1] + (e / (R * Math.cos((ORIGIN[0] * Math.PI) / 180))) * (180 / Math.PI),
  ];
}

const flatDem = { resolutionM: 20, elevation: () => 0 } as unknown as SceneInput['dem'];

const settings: SceneInput['settings'] = {
  standard: 'iso9613-2:2024',
  defaultG: 0.5,
  atmosphere: { temperatureC: 10, relativeHumidityPct: 70, pressureKpa: 101.325 },
  dzCapDb: null,
  c0Db: 0,
};

/// A screening wall, so the transfer under test includes barrier attenuation —
/// the term most likely to behave non-linearly if any of them did.
function wall(id: string, a: [number, number], b: [number, number], heightM: number): Barrier {
  return {
    id, name: id, type: 'wall',
    polylineLatLng: [a, b],
    topHeightsM: [heightM, heightM],
    baseFromGroundM: 0,
    surfaceDensityKgM2: 20,
    absorptionCoeff: 0,
  };
}

function turbine(id: string, e: number, n: number, lw: number[]): ResolvedSource {
  return {
    id, latLng: at(e, n), heightAglM: 100, lw,
    wtg: { rotorDiameterM: 120, applyConcave: false },
  };
}

/// Per-source per-band Lp at each receiver for one set of sound powers.
function solveWith(lwBySource: Record<string, number[]>): Map<string, Map<string, number[]>> {
  const sources = [
    turbine('t1', -400, 0, lwBySource.t1),
    turbine('t2', 350, 250, lwBySource.t2),
  ];
  const scene = buildScene({
    origin: ORIGIN,
    sources,
    receivers: [
      { id: 'r1', latLng: at(0, 900), heightAboveGroundM: 1.5 },
      { id: 'r2', latLng: at(1200, -300), heightAboveGroundM: 4 },
    ],
    barriers: [wall('w1', at(-200, 400), at(200, 400), 8)],
    dem: flatDem,
    terrain: null,
    settings,
    includeReflections: false,
  });
  const out = JSON.parse(solve_scene(JSON.stringify(scene))) as SceneResults;
  const bySource = new Map<string, Map<string, number[]>>();
  for (const rr of out.per_receiver) {
    for (const s of rr.per_source) {
      let m = bySource.get(s.source_id);
      if (!m) { m = new Map(); bySource.set(s.source_id, m); }
      m.set(rr.receiver_id, s.bands);
    }
  }
  return bySource;
}

/// Real power in EVERY band. A probe spectrum with dead bands cannot measure a
/// transfer there, and a reconstruction that skips those bands while the direct
/// solve still counts them disagrees for reasons that have nothing to do with
/// linearity — which is exactly the false alarm the first draft of this test
/// produced.
const FLAT_95 = Array.from({ length: 10 }, () => 95);
/// A deliberately awkward second spectrum: different in every band, a different
/// SHAPE rather than a constant offset, and 30+ dB away in places.
const SHAPED = [70, 85, 78, 104, 91, 99.5, 72, 88, 101, 66];

test('the transfer Lp − Lw does not depend on the sound power', async () => {
  const a = solveWith({ t1: FLAT_95, t2: FLAT_95 });
  const b = solveWith({ t1: SHAPED, t2: [...SHAPED].reverse() });
  const lwA: Record<string, number[]> = { t1: FLAT_95, t2: FLAT_95 };
  const lwB: Record<string, number[]> = { t1: SHAPED, t2: [...SHAPED].reverse() };

  let compared = 0;
  let withBarrier = 0;
  for (const src of ['t1', 't2']) {
    for (const rx of ['r1', 'r2']) {
      const bandsA = a.get(src)?.get(rx);
      const bandsB = b.get(src)?.get(rx);
      assert.ok(bandsA && bandsB, `${src}→${rx} missing from a solve`);
      for (let i = 0; i < 10; i++) {
        if (!Number.isFinite(bandsA[i]) || !Number.isFinite(bandsB[i])) continue;
        const tA = bandsA[i] - lwA[src][i];
        const tB = bandsB[i] - lwB[src][i];
        assert.ok(
          Math.abs(tA - tB) < 0.01,
          `${src}→${rx} band ${i}: transfer moved with the source power — `
          + `${tA.toFixed(4)} vs ${tB.toFixed(4)} dB`,
        );
        compared++;
        // t1 sits behind the wall from r1, so those pairs exercise diffraction.
        if (src === 't1' && rx === 'r1' && tA < -60) withBarrier++;
      }
    }
  }
  assert.ok(compared >= 24, `only ${compared} band comparisons were made`);
  assert.ok(withBarrier > 0, 'no screened path was exercised — the barrier is not biting');
});

test('a receiver total rebuilt from the transfer matches a direct solve', async () => {
  // The reconstruction the optimiser actually performs: take T from one solve,
  // apply a DIFFERENT spectrum arithmetically, and compare against solving that
  // spectrum for real. This is the step that replaces thousands of solves.
  const base = solveWith({ t1: FLAT_95, t2: FLAT_95 });
  const target = { t1: SHAPED, t2: [...SHAPED].reverse() };
  const direct = solveWith(target);

  for (const rx of ['r1', 'r2']) {
    let rebuilt = 0;
    let actual = 0;
    for (const src of ['t1', 't2']) {
      const baseBands = base.get(src)!.get(rx)!;
      const directBands = direct.get(src)!.get(rx)!;
      for (let i = 0; i < 10; i++) {
        // Both sides must cover the SAME bands, or the comparison measures the
        // difference in coverage rather than the difference in method.
        if (!Number.isFinite(baseBands[i]) || !Number.isFinite(directBands[i])) continue;
        const t = baseBands[i] - FLAT_95[i];
        rebuilt += Math.pow(10, (target[src as 't1' | 't2'][i] + t) / 10);
        actual += Math.pow(10, directBands[i] / 10);
      }
    }
    const rebuiltDb = 10 * Math.log10(rebuilt);
    const actualDb = 10 * Math.log10(actual);
    assert.ok(
      Math.abs(rebuiltDb - actualDb) < 0.01,
      `${rx}: rebuilt ${rebuiltDb.toFixed(4)} dB vs solved ${actualDb.toFixed(4)} dB`,
    );
  }
});

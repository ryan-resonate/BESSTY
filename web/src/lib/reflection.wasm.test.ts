// V-items — first-principles validation of the direct path, barrier screening
// and specular reflection, driven through the app's OWN wiring
// (`buildScene` → `solve_scene`) rather than the engine in isolation. A bug in
// how BESSTY describes a scene is exactly as wrong as a bug in the physics, and
// the ISO/TR conformance suite in the Rust crate cannot see it.
//
// Ryan has no external reference case for reflections, so nothing here is
// checked against another tool. Everything is checked against a quantity that
// can be derived by hand from the geometry, using one of three devices:
//
//   1. **Cancellation.** Compare two scenes differing in ONE respect. Aatm,
//      Agr and Adiv are identical in both and drop out of the difference, so
//      what remains is the term under test — no need to reimplement ISO
//      9613-1 absorption in a test to get an exact answer.
//   2. **The (1 − α) energy identity.** For fixed geometry the reflected
//      energy scales exactly with (1 − α), so
//      `(E(α) − E_direct) / (E(0) − E_direct) = 1 − α`
//      holds regardless of what the reflected path's level actually is. This
//      pins the absorption implementation without knowing the path.
//   3. **Image-source equivalence.** A specular reflection in a vertical plane
//      is the field of a mirrored source, so the reflected contribution is
//      bounded by solving a real source at the mirror position.
//
// Where a case can only be bounded rather than solved, it says so.

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

/// Lat/lng `e` metres east and `n` metres north of the origin.
function at(e: number, n: number): [number, number] {
  return [
    ORIGIN[0] + (n / R) * (180 / Math.PI),
    ORIGIN[1] + (e / (R * Math.cos((ORIGIN[0] * Math.PI) / 180))) * (180 / Math.PI),
  ];
}

/// Octave band centres the engine uses, so tests can name a band.
const BANDS = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];
const bandIndex = (hz: number) => {
  const i = BANDS.indexOf(hz);
  if (i < 0) throw new Error(`no such band: ${hz}`);
  return i;
};

/// Flat ground at elevation 0 — the DEM is only consulted for absolute z here.
const flatDem = { resolutionM: 20, elevation: () => 0 } as unknown as SceneInput['dem'];

/// 95 dB in every band from 63 Hz up; the two lowest are pushed far down so
/// they can't contribute to an A-weighted or energy comparison.
const lwFlat = () => Array.from({ length: 10 }, (_, i) => (i < 2 ? -100 : 95));

/// G = 0 (hard ground) throughout. With G = 0 the ISO 9613-2 General method's
/// ground terms lose their geometry dependence — As and Ar are −1.5 dB each —
/// so Agr is a CONSTANT and cancels cleanly out of every difference below.
const hardGround: SceneInput['settings'] = {
  standard: 'iso9613-2:2024',
  defaultG: 0,
  atmosphere: { temperatureC: 10, relativeHumidityPct: 70, pressureKpa: 101.325 },
  dzCapDb: null,
  c0Db: 0,
};

interface Case {
  sources: ResolvedSource[];
  receiver: [number, number];
  rxHeight?: number;
  barriers?: Barrier[];
  reflections?: boolean;
  order?: number;
  settings?: SceneInput['settings'];
}

/// Solve one case and return the receiver's per-band Lp, energy-summed over
/// every source.
function solve(c: Case): number[] {
  const scene = buildScene({
    origin: ORIGIN,
    sources: c.sources,
    receivers: [{ id: 'r1', latLng: c.receiver, heightAboveGroundM: c.rxHeight ?? 1.5 }],
    barriers: c.barriers ?? [],
    dem: flatDem,
    terrain: null,
    settings: c.settings ?? hardGround,
    includeReflections: c.reflections ?? false,
    maxReflectionOrder: c.order ?? 3,
  });
  const out = JSON.parse(solve_scene(JSON.stringify(scene))) as SceneResults;
  const rr = out.per_receiver.find((r) => r.receiver_id === 'r1');
  assert.ok(rr, 'receiver missing from results');
  const n = 10;
  const summed = new Array<number>(n).fill(0);
  for (const src of rr.per_source) {
    for (let i = 0; i < n; i++) {
      const v = src.bands[i];
      if (typeof v === 'number' && Number.isFinite(v)) summed[i] += Math.pow(10, v / 10);
    }
  }
  return summed.map((e) => (e > 0 ? 10 * Math.log10(e) : -Infinity));
}

/// A straight wall of constant height between two plan points (metres).
function wall(
  id: string,
  a: [number, number],
  b: [number, number],
  heightM: number,
  alpha: number,
): Barrier {
  return {
    id, name: id, type: 'wall',
    polylineLatLng: [at(a[0], a[1]), at(b[0], b[1])],
    topHeightsM: [heightM, heightM],
    baseFromGroundM: 0,
    surfaceDensityKgM2: 20,
    absorptionCoeff: alpha,
  };
}

const energy = (db: number) => Math.pow(10, db / 10);

// ===================================================================
// V-R1 — direct path
// ===================================================================
//
// One omni source over hard ground, no obstacles. Everything in ISO 9613-2 §7
// is known here:
//
//   Lp = Lw − Adiv − Aatm − Agr,     Adiv = 20·log10(d) + 11
//
// With G = 0 the ground terms are As = Ar = −1.5 dB, and the middle-region term
// Am is zero while dp ≤ 30(hs + hr) — so Agr = −3 dB exactly, independent of
// distance. Source and receiver sit at 20 m, making that regime hold out to
// 1200 m. At 63 Hz atmospheric absorption is ~0.1 dB/km, so Aatm over these
// distances is a few hundredths of a decibel and is bounded rather than
// modelled.

test('V-R1: the direct path obeys 20·log10(d) + 11 over hard ground', () => {
  const src = (): ResolvedSource[] => [
    { id: 's1', latLng: at(0, 0), heightAglM: 20, lw: lwFlat() },
  ];
  const near = solve({ sources: src(), receiver: at(300, 0), rxHeight: 20 });
  const far = solve({ sources: src(), receiver: at(600, 0), rxHeight: 20 });
  const b63 = bandIndex(63);

  // Doubling the distance costs exactly 20·log10(2) = 6.0206 dB of divergence,
  // plus the extra 300 m of air absorption (≤ 0.05 dB at 63 Hz).
  const drop = near[b63] - far[b63];
  assert.ok(
    drop >= 6.0206 && drop <= 6.0206 + 0.06,
    `expected a 6.02 dB doubling loss at 63 Hz, got ${drop.toFixed(4)}`,
  );

  // Absolute level, from the standard alone: 95 − (20·log10(300) + 11) + 3.
  const predicted = 95 - (20 * Math.log10(300) + 11) + 3;
  assert.ok(
    Math.abs(near[b63] - predicted) < 0.1,
    `expected ${predicted.toFixed(3)} dB at 300 m / 63 Hz, got ${near[b63].toFixed(3)}`,
  );

  // Sound power is linear in the result: +10 dB of Lw is +10 dB at the
  // receiver, exactly. Catches any accidental non-linearity in the chain.
  const louder = solve({
    sources: [{ id: 's1', latLng: at(0, 0), heightAglM: 20, lw: lwFlat().map((v) => v + 10) }],
    receiver: at(300, 0), rxHeight: 20,
  });
  assert.ok(
    Math.abs((louder[b63] - near[b63]) - 10) < 1e-6,
    `+10 dB Lw must give +10 dB Lp, got ${(louder[b63] - near[b63]).toFixed(6)}`,
  );
});

// ===================================================================
// V-B1 — barrier insertion loss (§7.4)
// ===================================================================
//
// Ryan's report was that barrier attenuation looks lower than expected, so this
// checks Dz against the standard's own formula rather than against a feeling.
//
// Comparing two barrier HEIGHTS with the source and receiver fixed cancels
// Adiv, Aatm and Agr exactly, leaving
//
//   Lp(h1) − Lp(h2) = Dz(δ2) − Dz(δ1)
//
// with δ the path difference over the top edge and
//
//   Dz = 10·log10(3 + (C2/λ)·C3·δ·Kmet),  C2 = 20, C3 = 1 (single edge)
//   Kmet = exp(−(1/2000)·√(dss·dsr·d / (2δ)))   for δ > 0
//
// Both sides are computed here from geometry, independently of the engine.

/// Path difference (m) over a thin screen perpendicular to the source→receiver
/// line, and the leg lengths Kmet needs. Everything in the vertical plane.
function screenGeometry(
  srcX: number, srcZ: number, wallX: number, wallTopZ: number, rxX: number, rxZ: number,
) {
  const dss = Math.hypot(wallX - srcX, wallTopZ - srcZ);
  const dsr = Math.hypot(rxX - wallX, rxZ - wallTopZ);
  const d = Math.hypot(rxX - srcX, rxZ - srcZ);
  return { dss, dsr, d, delta: dss + dsr - d };
}

/// Dz for a single edge, computed here from the standard rather than from the
/// engine. The two editions differ in BOTH the bracket and Kmet, so each is
/// written out in full — getting this wrong is precisely the kind of mistake
/// the test exists to catch.
///
///   2024 (Eq 18/21): Dz = 10·lg[1 + (2 + X)·Kmet]
///                    Kmet = exp[−(1/2000)·√(max(dss,dsr)·min(dss,dsr)·d / 2(z − zmin))]
///   1996 (Eq 14/18): Dz = 10·lg[3 + X·Kmet]
///                    Kmet = exp[−(1/2000)·√(dss·dsr·d / 2z)]
///
/// with X = (C2/λ)·C3·z, C2 = 20, C3 = 1 for a single edge, and
/// zmin = −2λ/(C2·C3).
function dzFor(
  freqHz: number,
  g: ReturnType<typeof screenGeometry>,
  edition: '1996' | '2024',
): number {
  const lambda = 343.2 / freqHz;         // ISO reference speed of sound
  const C2 = 20; const C3 = 1;           // single edge ⇒ e = 0 ⇒ C3 = 1
  const zMin = (-2 * lambda) / (C2 * C3);
  if (g.delta <= zMin) return 0;
  const x = (C2 / lambda) * C3 * g.delta;
  if (edition === '1996') {
    const kmet = g.delta > 0
      ? Math.exp(-(1 / 2000) * Math.sqrt((g.dss * g.dsr * g.d) / (2 * g.delta)))
      : 1;
    return 10 * Math.log10(3 + x * kmet);
  }
  const hi = Math.max(g.dss, g.dsr);
  const lo = Math.min(g.dss, g.dsr);
  const kmet = Math.exp(-(1 / 2000) * Math.sqrt((hi * lo * g.d) / (2 * (g.delta - zMin))));
  return 10 * Math.log10(1 + (2 + x) * kmet);
}

test('V-B1: barrier Dz matches the §7.4 formula as the screen grows', () => {
  const SRC_X = 0; const SRC_Z = 2; const WALL_X = 30; const RX_X = 200; const RX_Z = 2;
  const sources = (): ResolvedSource[] => [
    { id: 's1', latLng: at(SRC_X, 0), heightAglM: SRC_Z, lw: lwFlat() },
  ];
  const solveWithWallHeight = (h: number, settings?: SceneInput['settings']) => solve({
    sources: sources(),
    receiver: at(RX_X, 0),
    rxHeight: RX_Z,
    // Wall crosses the path, long enough that the over-the-top route wins.
    barriers: [wall('b', [WALL_X, -400], [WALL_X, 400], h, 0)],
    settings,
  });

  const H1 = 5; const H2 = 9;

  // Both editions, because the bracket and Kmet differ between them and a
  // selector that quietly picked the wrong one would otherwise go unnoticed.
  for (const edition of ['1996', '2024'] as const) {
    const settings: SceneInput['settings'] = {
      ...hardGround, standard: `iso9613-2:${edition}` as const,
    };
    const lo = solveWithWallHeight(H1, settings);
    const hi = solveWithWallHeight(H2, settings);

    for (const hz of [125, 500, 1000]) {
      const i = bandIndex(hz);
      const g1 = screenGeometry(SRC_X, SRC_Z, WALL_X, H1, RX_X, RX_Z);
      const g2 = screenGeometry(SRC_X, SRC_Z, WALL_X, H2, RX_X, RX_Z);
      const predicted = dzFor(hz, g2, edition) - dzFor(hz, g1, edition);
      const measured = lo[i] - hi[i];
      assert.ok(
        Math.abs(measured - predicted) < 0.15,
        `${edition} @ ${hz} Hz: raising the screen ${H1}→${H2} m should add `
        + `${predicted.toFixed(3)} dB of Dz, measured ${measured.toFixed(3)}`,
      );
    }

    // Taller screen ⇒ quieter, in every band above the useless bottom two.
    for (let i = 2; i < 10; i++) {
      assert.ok(hi[i] < lo[i], `${edition} band ${BANDS[i]} Hz: a taller screen must attenuate more`);
    }
  }
});

test('V-B1b: the Dz cap setting clamps screening, and explains a "weak" barrier', () => {
  // A per-band cap is a project setting, and it is the most likely explanation
  // for a barrier that seems to under-perform its geometry. Pin the behaviour
  // so the cap can never silently stop applying.
  const sources = (): ResolvedSource[] => [
    { id: 's1', latLng: at(0, 0), heightAglM: 2, lw: lwFlat() },
  ];
  const geometry = {
    sources: sources(),
    receiver: at(200, 0) as [number, number],
    rxHeight: 2,
    barriers: [wall('b', [30, -400], [30, 400], 12, 0)],
  };
  const open = solve({ sources: sources(), receiver: at(200, 0), rxHeight: 2 });
  const uncapped = solve(geometry);
  const capped = solve({ ...geometry, settings: { ...hardGround, dzCapDb: 2 } });

  const i = bandIndex(1000);
  const ilUncapped = open[i] - uncapped[i];
  const ilCapped = open[i] - capped[i];
  assert.ok(ilUncapped > 10, `a 12 m screen at 1 kHz should screen well (got ${ilUncapped.toFixed(1)} dB)`);
  assert.ok(
    ilCapped < ilUncapped - 5,
    `a 2 dB Dz cap must visibly reduce screening: ${ilCapped.toFixed(1)} vs ${ilUncapped.toFixed(1)} dB`,
  );
});

// ===================================================================
// V-R2 — a reflector beside the source, receiver on the SAME side
// ===================================================================
//
// Ryan's first case. The wall runs parallel to the source→receiver line and
// off to one side, so it screens nothing and only adds a specular path. The
// receiver must get LOUDER, and by an amount governed by the mirrored source.

const R2_WALL_N = 25;          // wall 25 m north of the source→receiver line
/// 20 m tall. Height matters: ISO 9613-2 Eq 26/27 gates a reflection on the
/// facade being large enough to be specular at that wavelength, and a short
/// wall silently drops the low bands (pinned separately below).
const R2_WALL_H = 20;
const r2Sources = (): ResolvedSource[] => [
  { id: 's1', latLng: at(0, 0), heightAglM: 4, lw: lwFlat() },
];
const r2Case = (alpha: number, on: boolean): Case => ({
  sources: r2Sources(),
  receiver: at(200, 0),
  rxHeight: 4,
  barriers: [wall('b', [-60, R2_WALL_N], [260, R2_WALL_N], R2_WALL_H, alpha)],
  reflections: on,
  order: 1,
});

/// Bands from 250 Hz up, where the 20 m facade above comfortably passes the
/// Fresnel gate.
const R2_BANDS = [250, 500, 1000, 2000, 4000, 8000];

test('V-R2: a wall beside the path adds energy, and never removes any', () => {
  const off = solve(r2Case(0, false));
  const on = solve(r2Case(0, true));
  for (const hz of R2_BANDS) {
    const i = bandIndex(hz);
    assert.ok(
      on[i] > off[i],
      `band ${hz} Hz: a perfectly reflecting wall must raise the level `
      + `(${off[i].toFixed(2)} → ${on[i].toFixed(2)})`,
    );
    // A specular addition cannot exceed +3 dB at first order: the reflected
    // path is longer than the direct one, so its energy is strictly smaller.
    assert.ok(
      on[i] - off[i] < 3.0,
      `band ${hz} Hz: a single reflection added ${(on[i] - off[i]).toFixed(2)} dB, `
      + 'which exceeds the +3 dB an equal-strength image could give',
    );
  }
});

test('V-R2c: the Fresnel size gate silences bands a facade is too small to reflect', () => {
  // ISO 9613-2 Eq 26/27: a reflection only counts where
  //     1/λ > (2/leff²)·(dso·dor/(dso+dor)),  leff = min(a·cos αa, h·cos αh).
  // For the geometry here the reflection point sits mid-wall with
  // dso = dor ≈ 103 m, and leff is set by the wall HEIGHT. An 8 m wall
  // therefore reflects only above roughly 550 Hz.
  //
  // This is the answer to "why is my wall not reflecting?" — it is not a bug,
  // and it means a short acoustic barrier reflects far less low-frequency
  // energy than its length suggests.
  const short = (on: boolean): Case => ({
    sources: r2Sources(),
    receiver: at(200, 0),
    rxHeight: 4,
    barriers: [wall('b', [-60, R2_WALL_N], [260, R2_WALL_N], 8, 0)],
    reflections: on,
    order: 1,
  });
  const off = solve(short(false));
  const on = solve(short(true));

  // Below the gate: bit-identical to no reflection at all.
  for (const hz of [63, 125, 250]) {
    const i = bandIndex(hz);
    assert.ok(
      Math.abs(on[i] - off[i]) < 1e-9,
      `band ${hz} Hz should fail the Fresnel gate on an 8 m wall, but changed by `
      + `${(on[i] - off[i]).toFixed(6)} dB`,
    );
  }
  // Above it: a real contribution.
  for (const hz of [1000, 2000]) {
    const i = bandIndex(hz);
    assert.ok(on[i] > off[i], `band ${hz} Hz should pass the Fresnel gate on an 8 m wall`);
  }
  // Taller wall ⇒ the gate opens at lower frequencies. Same geometry
  // otherwise, so this isolates the size term.
  const tall = solve(r2Case(0, true));
  const tallOff = solve(r2Case(0, false));
  const i500 = bandIndex(500);
  assert.ok(
    tall[i500] > tallOff[i500] && Math.abs(on[i500] - off[i500]) < 1e-9,
    'raising the wall from 8 m to 20 m must let 500 Hz through the gate',
  );
});

test('V-R2: reflected energy scales exactly with (1 − α)', () => {
  // The identity under test:
  //     E(α) − E_direct = (1 − α) · (E(0) − E_direct)
  // It holds whatever the reflected path happens to be, so it isolates the
  // absorption implementation from every other term.
  const direct = solve(r2Case(0, false));
  const full = solve(r2Case(0, true));
  const i = bandIndex(500);
  const reflectedAt0 = energy(full[i]) - energy(direct[i]);
  assert.ok(reflectedAt0 > 0, 'no reflected energy to scale');

  for (const alpha of [0.25, 0.5, 0.75]) {
    const got = solve(r2Case(alpha, true));
    const reflected = energy(got[i]) - energy(direct[i]);
    const ratio = reflected / reflectedAt0;
    assert.ok(
      Math.abs(ratio - (1 - alpha)) < 0.01,
      `α=${alpha}: reflected energy should be ${(1 - alpha).toFixed(2)}× the α=0 case, got ${ratio.toFixed(4)}`,
    );
  }
});

test('V-R2: α = 1 is indistinguishable from switching reflections off', () => {
  // 10·log10(1 − α) → −∞, so a fully absorptive surface must contribute
  // nothing at all — not merely "a bit less".
  const off = solve(r2Case(0, false));
  const fully = solve(r2Case(1, true));
  for (let i = 2; i < 10; i++) {   // every band: absorption is not frequency-gated
    assert.ok(
      Math.abs(off[i] - fully[i]) < 1e-9,
      `band ${BANDS[i]} Hz: α=1 gave ${fully[i].toFixed(6)}, direct-only is ${off[i].toFixed(6)}`,
    );
  }
});

/// Reflected contribution (dB) at `hz` for a given wall height, by energy
/// subtraction of the reflections-off case.
function reflectedContribution(hz: number, wallHeightM: number): number {
  const c = (on: boolean): Case => ({
    sources: r2Sources(),
    receiver: at(200, 0),
    rxHeight: 4,
    barriers: [wall('b', [-60, R2_WALL_N], [260, R2_WALL_N], wallHeightM, 0)],
    reflections: on,
    order: 1,
  });
  const i = bandIndex(hz);
  const direct = solve(c(false));
  const total = solve(c(true));
  const delta = energy(total[i]) - energy(direct[i]);
  return delta > 0 ? 10 * Math.log10(delta) : -Infinity;
}

test('KNOWN LIMITATION: a reflected path is screened by the wall it reflects off', () => {
  // ------------------------------------------------------------------
  // This test asserts a DEFECT, deliberately, so it is visible and cannot
  // regress silently. It should be INVERTED once the engine is fixed.
  // ------------------------------------------------------------------
  //
  // A specular reflection is the field of the source mirrored in the facade.
  // The wall here is 25 m to the side of a 200 m path, so the image sits 50 m
  // off and its path is 206.2 m against the direct 200 m — worth about 0.3 dB.
  // The reflected contribution should therefore land within a decibel or so of
  // the mirrored source solved on its own.
  //
  // It does not. BESSTY lists a barrier in BOTH the `obstacles` and
  // `reflectors` arrays — intentionally, because the engine is documented as
  // keeping the two apart so a reflected ray is not re-diffracted by the
  // surface it bounced off. Measurement says otherwise: the image-source path
  // runs from the image, through the facade at exactly the reflection point, to
  // the receiver, and the engine screens it against that same wall. The loss
  // therefore GROWS with the wall's height and saturates at the 20 dB
  // single-edge Dz cap, while being almost independent of how far the wall is
  // from the path — the signature of screening, not of a longer path.
  //
  // Consequence: reflected contributions off barriers are under-estimated, by
  // up to 20 dB for a tall wall. Reflections are off by default and documented
  // as provisional, so no default result is affected. The fix belongs in the
  // engine (exclude a reflector's own surface from the screening test for the
  // path that reflected off it), which is outside this plan's scope.
  const image = solve({
    sources: [{ id: 'img', latLng: at(0, 2 * R2_WALL_N), heightAglM: 4, lw: lwFlat() }],
    receiver: at(200, 0),
    rxHeight: 4,
  })[bandIndex(500)];

  const r20 = reflectedContribution(500, 20);
  // The defect: far below the mirrored source, not within a decibel of it.
  assert.ok(
    image - r20 > 10,
    'if the reflected contribution is now close to the mirrored source, the engine '
    + `has been fixed — invert this test. image=${image.toFixed(2)} reflected=${r20.toFixed(2)}`,
  );

  // Signature 1: the loss grows with wall height and saturates at the Dz cap.
  const r10 = reflectedContribution(500, 10);
  const r40 = reflectedContribution(500, 40);
  const r80 = reflectedContribution(500, 80);
  assert.ok(r10 > r20 && r20 > r40, `taller wall ⇒ more self-screening (${r10.toFixed(2)}, ${r20.toFixed(2)}, ${r40.toFixed(2)})`);
  assert.ok(Math.abs(r40 - r80) < 0.1, 'the self-screening saturates at the 20 dB single-edge cap');
  assert.ok(
    Math.abs((image - r40) - 20) < 1.0,
    `saturated loss should equal the 20 dB Dz cap, got ${(image - r40).toFixed(2)} dB`,
  );

  // Signature 2: moving the wall further from the path barely changes the
  // reflected level, which no genuine image-source geometry would do.
  const farWall = (n: number): number => {
    const c = (on: boolean): Case => ({
      sources: r2Sources(),
      receiver: at(200, 0),
      rxHeight: 4,
      barriers: [wall('b', [-60, n], [260, n], 20, 0)],
      reflections: on,
      order: 1,
    });
    const i = bandIndex(500);
    const d = energy(solve(c(true))[i]) - energy(solve(c(false))[i]);
    return d > 0 ? 10 * Math.log10(d) : -Infinity;
  };
  assert.ok(
    Math.abs(farWall(25) - farWall(100)) < 1.0,
    'reflected level is nearly independent of wall offset — screening, not path length',
  );
});

// ===================================================================
// V-R3a — parallel walls, multi-order reflection
// ===================================================================
//
// A corridor of two parallel reflectors with the source between them and the
// receiver down the axis. Each extra order adds another pair of images, so
// energy must increase monotonically with the requested order and saturate as
// the images get further away.

/// 25 m walls so the Fresnel gate (V-R2c) is open at the test band rather than
/// silently removing the very paths under test.
const r3aCase = (order: number, alpha: number, on: boolean): Case => ({
  sources: [{ id: 's1', latLng: at(0, 0), heightAglM: 3, lw: lwFlat() }],
  receiver: at(300, 0),
  rxHeight: 3,
  barriers: [
    wall('w-north', [-40, 20], [340, 20], 25, alpha),
    wall('w-south', [-40, -20], [340, -20], 25, alpha),
  ],
  reflections: on,
  order,
});

test('V-R3a: each reflection order adds energy, and none removes any', () => {
  const off = solve(r3aCase(1, 0, false));
  const o1 = solve(r3aCase(1, 0, true));
  const o2 = solve(r3aCase(2, 0, true));
  const o3 = solve(r3aCase(3, 0, true));
  const i = bandIndex(500);

  assert.ok(o1[i] > off[i], 'first order must add energy');
  assert.ok(o2[i] >= o1[i] - 1e-9, `order 2 (${o2[i].toFixed(3)}) must not be below order 1 (${o1[i].toFixed(3)})`);
  assert.ok(o3[i] >= o2[i] - 1e-9, `order 3 (${o3[i].toFixed(3)}) must not be below order 2 (${o2[i].toFixed(3)})`);
  // Higher-order images are further away, so the increments must shrink.
  const add1 = energy(o1[i]) - energy(off[i]);
  const add2 = energy(o2[i]) - energy(o1[i]);
  assert.ok(add2 < add1, 'the second-order increment must be smaller than the first-order one');
});

test('V-R3a: absorption scales the whole image ladder', () => {
  const off = solve(r3aCase(3, 0, false));
  const hard = solve(r3aCase(3, 0, true));
  const soft = solve(r3aCase(3, 0.5, true));
  const i = bandIndex(500);
  const eHard = energy(hard[i]) - energy(off[i]);
  const eSoft = energy(soft[i]) - energy(off[i]);
  // Every path loses at least (1−α) once and higher orders lose more, so the
  // total reflected energy must land strictly between (1−α)^order and (1−α).
  const ratio = eSoft / eHard;
  assert.ok(
    ratio < 0.5 + 1e-6 && ratio > Math.pow(0.5, 3) - 1e-6,
    `α=0.5 over orders 1..3 should scale reflected energy into [0.125, 0.5], got ${ratio.toFixed(4)}`,
  );
});

// ===================================================================
// V-R3b — a source enclosed by reflective walls
// ===================================================================
//
// Ryan's second case: a source ringed by four walls, receiver outside. There is
// no closed form once diffraction and reflection mix, so what is asserted is
// the structure that must hold regardless:
//
//   - α = 1 must equal the barrier-only (reflections-off) level exactly;
//   - the level must fall monotonically as α rises;
//   - the reflected energy must obey the (1 − α) identity at first order.

const enclosure = (alpha: number, on: boolean, order = 1): Case => ({
  sources: [{ id: 's1', latLng: at(0, 0), heightAglM: 2, lw: lwFlat() }],
  receiver: at(150, 0),
  rxHeight: 1.5,
  barriers: [
    wall('n', [-15, 15], [15, 15], 6, alpha),
    wall('e', [15, 15], [15, -15], 6, alpha),
    wall('s', [15, -15], [-15, -15], 6, alpha),
    wall('w', [-15, -15], [-15, 15], 6, alpha),
  ],
  reflections: on,
  order,
});

test('V-R3b: an enclosure with α = 1 equals the screened level exactly', () => {
  const screenedOnly = solve(enclosure(0, false));
  const fullyAbsorptive = solve(enclosure(1, true));
  for (let i = 2; i < 10; i++) {
    assert.ok(
      Math.abs(screenedOnly[i] - fullyAbsorptive[i]) < 1e-9,
      `band ${BANDS[i]} Hz: fully absorptive walls must leave only the screened `
      + `path (${screenedOnly[i].toFixed(6)} vs ${fullyAbsorptive[i].toFixed(6)})`,
    );
  }
});

test('V-R3b: outside level falls monotonically as the walls get more absorptive', () => {
  const i = bandIndex(500);
  const levels = [0, 0.25, 0.5, 0.75, 1].map((a) => solve(enclosure(a, true))[i]);
  for (let k = 1; k < levels.length; k++) {
    assert.ok(
      levels[k] <= levels[k - 1] + 1e-9,
      `more absorption must not raise the outside level: ${levels.map((v) => v.toFixed(3)).join(' → ')}`,
    );
  }
  // And the swing between a hard and a dead enclosure must be real, not noise.
  assert.ok(
    levels[0] - levels[4] > 0.05,
    `expected a measurable hard-vs-absorptive difference, got ${(levels[0] - levels[4]).toFixed(4)} dB`,
  );
});

test('V-R3b: reflected energy escaping the enclosure scales with (1 − α)', () => {
  const direct = solve(enclosure(0, false));
  const hard = solve(enclosure(0, true));
  const i = bandIndex(500);
  const base = energy(hard[i]) - energy(direct[i]);
  assert.ok(base > 0, 'no reflected energy escaped the enclosure to scale');
  for (const alpha of [0.25, 0.5, 0.75]) {
    const got = solve(enclosure(alpha, true));
    const ratio = (energy(got[i]) - energy(direct[i])) / base;
    assert.ok(
      Math.abs(ratio - (1 - alpha)) < 0.01,
      `α=${alpha}: escaping reflected energy should scale by ${(1 - alpha).toFixed(2)}, got ${ratio.toFixed(4)}`,
    );
  }
});

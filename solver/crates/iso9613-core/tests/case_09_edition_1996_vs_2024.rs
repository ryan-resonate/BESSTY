//! Validation case 09 — ISO 9613-2:1996 vs :2024 edition deltas.
//!
//! Proves the `EditionSpec` switch produces the edition-correct values on the
//! two terms that genuinely differ (per `docs/iso9613-2-1996-vs-2024-
//! differences.md`): the ground combination (Sum vs Kgeo, §6) and the barrier
//! `Dz` bracket + `Kmet` form (§8.1–8.2). Expected values are independently
//! computed (scratchpad `oracle.py`, a fresh implementation of both editions —
//! NOT ported from the Rust).

use approx::assert_relative_eq;
use iso9613_core::iso9613::atmosphere::Atmosphere;
use iso9613_core::iso9613::barrier::{diffraction, path, BarrierVariant, WallBarrier};
use iso9613_core::iso9613::ground::{self, GroundCombination, GroundMethod};
use iso9613_core::standards::{GeneralEval, Iso1996, Iso2024, StandardModel};
use iso9613_core::{BandSpectrum, BandSystem, Vec3};

const OCTAVE: BandSystem = BandSystem::Octave;

#[test]
fn barrier_dz_per_band_matches_both_editions() {
    // Case-03 geometry: S(0,0,5) R(100,0,1.5), single wall x=50 top 8 → Δz=0.449.
    let s = Vec3::new(0.0, 0.0, 5.0);
    let r = Vec3::new(100.0, 0.0, 1.5);
    let walls = [WallBarrier { a_e: 50.0, a_n: -1000.0, b_e: 50.0, b_n: 1000.0, base_z_a: 0.0, base_z_b: 0.0, height_agl: 8.0 }];
    let candidates = path::project_walls(s, r, &walls);
    let s_in = path::DiffractionEdge { x: 0.0, z: s.z };
    let r_in = path::DiffractionEdge { x: 100.0, z: r.z };
    let active = path::upper_hull_select(s_in, r_in, &candidates);
    let lengths = path::path_lengths(s_in, r_in, &active);

    // Independently computed (oracle.py): 1996 `10lg[3+X·Kmet]` vs 2024
    // `10lg[1+(2+X)·Kmet]` — 1996 slightly higher, converging up the spectrum.
    let dz96 = [5.217, 5.610, 6.312, 7.431, 9.069, 11.186, 13.670, 16.391, 19.249, 22.181];
    let dz24 = [5.009, 5.383, 6.091, 7.245, 8.935, 11.101, 13.621, 16.365, 19.235, 22.174];

    for (i, &f) in OCTAVE.centres().iter().enumerate() {
        let lambda = 340.0 / f;
        let d96 = diffraction::dz_uncapped(&lengths, lambda, BarrierVariant::V1996);
        let d24 = diffraction::dz_uncapped(&lengths, lambda, BarrierVariant::V2024);
        assert_relative_eq!(d96, dz96[i], epsilon = 0.01);
        assert_relative_eq!(d24, dz24[i], epsilon = 0.01);
        assert!(d96 >= d24 - 1e-9, "1996 Dz should be ≥ 2024 at {f} Hz: {d96} vs {d24}");
    }
}

#[test]
fn ground_agr_per_band_matches_both_editions() {
    // Tall source, short range so Kgeo << 1 (= 0.4607): the Sum-vs-Kgeo delta
    // is visible. S(0,0,30) R(25,0,10), hS=30 hR=10 dp=25, G=1 (porous).
    let s = Vec3::new(0.0, 0.0, 30.0);
    let r = Vec3::new(25.0, 0.0, 10.0);
    let sum = ground::agr_spectrum(s, r, 30.0, 10.0, 1.0, 1.0, 1.0, OCTAVE, GroundCombination::Sum);
    let kgeo = ground::agr_spectrum(s, r, 30.0, 10.0, 1.0, 1.0, 1.0, OCTAVE, GroundCombination::KgeoWrap);

    // Independently computed (oracle.py).
    let agr96 = [-3.000, -3.000, -3.000, 0.059, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    let agr24 = [-1.639, -1.639, -1.639, 0.027, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0];
    for i in 0..OCTAVE.n_bands() {
        assert_relative_eq!(sum.bands[i], agr96[i], epsilon = 0.01);
        assert_relative_eq!(kgeo.bands[i], agr24[i], epsilon = 0.01);
    }
    // The low bands must differ materially (the Kgeo compression toward 0).
    assert!((sum.bands[2] - kgeo.bands[2]).abs() > 1.0, "63 Hz Agr should differ by >1 dB");
}

#[test]
fn edition_switch_is_observable_end_to_end() {
    // Same barrier scene through both evaluators: the 1996 total is a touch
    // lower (more barrier attenuation from the `3+` bracket).
    let s = Vec3::new(0.0, 0.0, 5.0);
    let r = Vec3::new(100.0, 0.0, 1.5);
    let walls = [WallBarrier { a_e: 50.0, a_n: -1000.0, b_e: 50.0, b_n: 1000.0, base_z_a: 0.0, base_z_b: 0.0, height_agl: 8.0 }];
    let lw = BandSpectrum::from_iter(OCTAVE, std::iter::repeat_n(100.0, 10));
    let mk = || GeneralEval {
        lw: &lw, source: s, receiver: r, h_s: 5.0, h_r: 1.5,
        g_source: 0.5, g_middle: 0.5, g_receiver: 0.5,
        barriers: &walls, lateral: &[], terrain_edges: &[], footprints: &[], dz_cap: None,
        atm: Atmosphere::iso_reference(), ground_method: GroundMethod::General, hm_override: None,
    };
    let t96 = Iso1996.evaluate_general(&mk()).a_weighted_total();
    let t24 = Iso2024.evaluate_general(&mk()).a_weighted_total();
    assert!(t96 < t24, "1996 total should be ≤ 2024: {t96} vs {t24}");
    assert!((t24 - t96) < 0.5, "edition delta small here: {}", t24 - t96);
}

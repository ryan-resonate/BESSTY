//! Validation case 03 — see `validation/case-03-single-barrier.md`.
//!
//! Source (0,0,5), receiver (100,0,1.5), single thin wall at x=50 with top
//! at z=8, infinite y-extent, G=0.5. Expected LAT(DW) = 41.17 dB(A).

use approx::assert_relative_eq;
use iso9613_core::iso9613::atmosphere::Atmosphere;
use iso9613_core::iso9613::barrier::WallBarrier;
use iso9613_core::iso9613::{barrier, evaluate_with_barriers};
use iso9613_core::{BandSpectrum, BandSystem, Vec3};

const TOL_PER_BAND_DB: f64 = 1.0;
const TOL_OVERALL_DBA: f64 = 0.5;

fn case_03_setup() -> (Vec3, Vec3, Vec<WallBarrier>) {
    let s = Vec3::new(0.0, 0.0, 5.0);
    let r = Vec3::new(100.0, 0.0, 1.5);
    // Wall perpendicular to the SR line at x=50, extending well beyond the
    // line in y so the projection algorithm sees a single intersection.
    let walls = vec![WallBarrier {
        a_e: 50.0, a_n: -1000.0,
        b_e: 50.0, b_n: 1000.0,
        base_z_a: 0.0, base_z_b: 0.0, height_agl: 8.0,
    }];
    (s, r, walls)
}

fn flat_100_db_octave() -> BandSpectrum {
    BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat_n(100.0, 10))
}

#[test]
fn case_03_dz_per_band_matches_validation() {
    use barrier::{diffraction, path, BarrierVariant};
    let (s, r, walls) = case_03_setup();
    let candidates = path::project_walls(s, r, &walls);
    let s_in_plane = path::DiffractionEdge { x: 0.0, z: s.z };
    let r_in_plane = path::DiffractionEdge { x: 100.0, z: r.z };
    let active = path::upper_hull_select(s_in_plane, r_in_plane, &candidates);
    assert_eq!(active.len(), 1);
    let lengths = path::path_lengths(s_in_plane, r_in_plane, &active);

    let centres = BandSystem::Octave.centres();
    // Expected (uncapped) Dz per band, independently computed (scratchpad
    // oracle.py, a fresh 2024 implementation) for Δz = 0.449 m, single edge:
    // Dz = 10·lg[1 + (2 + 20·Δz/λ)·Kmet_2024] (Eq 18, corrected bracket + zmin).
    let expected_dz_uncapped = [
        5.01, 5.38, 6.09, 7.25, 8.93, 11.10, 13.62, 16.36, 19.24, 22.17,
    ];
    for (i, &f) in centres.iter().enumerate() {
        let lambda = 340.0 / f;
        let dz = diffraction::dz_uncapped(&lengths, lambda, BarrierVariant::V2024);
        assert_relative_eq!(dz, expected_dz_uncapped[i], epsilon = 0.1);
    }

    // Single-edge cap = 20 dB → 8 kHz (22.17 uncapped) clamps to 20.
    let dz_8k = diffraction::dz_uncapped(&lengths, 340.0 / 8000.0, BarrierVariant::V2024);
    let dz_8k_capped = diffraction::cap(dz_8k, lengths.e_total, None);
    assert_relative_eq!(dz_8k_capped, 20.0, epsilon = 1e-9);
}

#[test]
fn case_03_a_weighted_total() {
    let (s, r, walls) = case_03_setup();
    let lw = flat_100_db_octave();
    let lp = evaluate_with_barriers(&lw, s, r, s.z, r.z, 0.5, &walls, &[], None, Atmosphere::iso_reference());
    let total = lp.a_weighted_total();
    // 40.93 dB(A) — independently computed (scratchpad oracle.py) with the
    // corrected 2024 barrier formula + literal-ISO Agr combination.
    assert_relative_eq!(total, 40.93, epsilon = TOL_OVERALL_DBA);
}

#[test]
fn case_03_per_band_lp() {
    let (s, r, walls) = case_03_setup();
    let lw = flat_100_db_octave();
    let lp = evaluate_with_barriers(&lw, s, r, s.z, r.z, 0.5, &walls, &[], None, Atmosphere::iso_reference());
    // Per-band Lp, independently computed (scratchpad oracle.py) with the
    // corrected 2024 barrier chain.
    let expected = [
        46.98, 46.60, 45.88, 41.71, 39.96, 37.70, 36.22, 33.16, 27.95, 18.65,
    ];
    for (i, exp) in expected.iter().enumerate() {
        assert_relative_eq!(lp.bands[i], *exp, epsilon = TOL_PER_BAND_DB);
    }
}

#[test]
fn case_03_no_barrier_baseline_is_louder() {
    use iso9613_core::iso9613::evaluate_with_ground;
    let (s, r, walls) = case_03_setup();
    let lw = flat_100_db_octave();
    let lp_with = evaluate_with_barriers(&lw, s, r, s.z, r.z, 0.5, &walls, &[], None, Atmosphere::iso_reference());
    let lp_without = evaluate_with_ground(&lw, s, r, s.z, r.z, 0.5, Atmosphere::iso_reference());
    // Barrier should reduce the level substantially (≈ 14 dB(A) per validation).
    let drop = lp_without.a_weighted_total() - lp_with.a_weighted_total();
    assert!(drop > 10.0 && drop < 18.0, "drop = {} dB(A)", drop);
}

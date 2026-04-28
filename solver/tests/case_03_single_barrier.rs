//! Validation case 03 — see `validation/case-03-single-barrier.md`.
//!
//! Source (0,0,5), receiver (100,0,1.5), single thin wall at x=50 with top
//! at z=8, infinite y-extent, G=0.5. Expected LAT(DW) = 41.17 dB(A).

use approx::assert_relative_eq;
use beesty_solver::iso9613::{barrier, evaluate_with_barriers};
use beesty_solver::iso9613::barrier::WallBarrier;
use beesty_solver::{BandSpectrum, BandSystem, Vec3};

const TOL_PER_BAND_DB: f64 = 1.0;
const TOL_OVERALL_DBA: f64 = 0.5;

fn case_03_setup() -> (Vec3<f64>, Vec3<f64>, Vec<WallBarrier<f64>>) {
    let s = Vec3::new(0.0, 0.0, 5.0);
    let r = Vec3::new(100.0, 0.0, 1.5);
    // Wall perpendicular to the SR line at x=50, extending well beyond the
    // line in y so the projection algorithm sees a single intersection.
    let walls = vec![WallBarrier {
        a_e: 50.0, a_n: -1000.0,
        b_e: 50.0, b_n: 1000.0,
        top_z: 8.0,
    }];
    (s, r, walls)
}

fn flat_100_db_octave() -> BandSpectrum<f64> {
    BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat(100.0).take(10))
}

#[test]
fn case_03_dz_per_band_matches_validation() {
    use barrier::{diffraction, path};
    let (s, r, walls) = case_03_setup();
    let candidates = path::project_walls(s, r, &walls);
    let s_in_plane = path::DiffractionEdge { x: 0.0, z: s.z };
    let r_in_plane = path::DiffractionEdge { x: 100.0, z: r.z };
    let active = path::upper_hull_select(s_in_plane, r_in_plane, &candidates);
    assert_eq!(active.len(), 1);
    let lengths = path::path_lengths(s_in_plane, r_in_plane, &active);

    let centres = BandSystem::Octave.centres();
    // Expected (uncapped) Dz from validation/case-03-single-barrier.md.
    // Two new low octaves (16, 31.5 Hz) prepended — Dz computed from λ=21.25
    // and λ=10.79 m respectively. The reference values for 63 Hz upward are
    // unchanged. We compute the new low-band values inline here.
    let expected_dz_uncapped = [
        // 16 Hz: λ ≈ 21.25 m. C2·Δz/λ = 20·0.449/21.25 = 0.423.
        // Inner = 1 + (3 + 0.423)·Kmet ≈ 1 + 3.42·0.85 ≈ 3.91 → 5.92 dB
        5.92, 6.42,
        6.80, 7.78, 9.29, 11.32, 13.74, 16.43, 19.27, 22.19,
    ];
    for (i, &f) in centres.iter().enumerate() {
        let lambda = 340.0 / f;
        let dz = diffraction::dz_uncapped(&lengths, lambda);
        assert_relative_eq!(dz, expected_dz_uncapped[i], epsilon = 1.0);
    }

    // Single-edge cap = 20 dB → 8 kHz (22.19) clamps to 20.
    let dz_8k = diffraction::dz_uncapped(&lengths, 340.0 / 8000.0);
    let dz_8k_capped = diffraction::cap(dz_8k, lengths.e_total, None);
    assert_relative_eq!(dz_8k_capped, 20.0, epsilon = 1e-9);
}

#[test]
fn case_03_a_weighted_total() {
    let (s, r, walls) = case_03_setup();
    let lw = flat_100_db_octave();
    let lp = evaluate_with_barriers(&lw, s, r, 0.5, &walls, None);
    let total = lp.a_weighted_total();
    assert_relative_eq!(total, 41.17, epsilon = TOL_OVERALL_DBA);
}

#[test]
fn case_03_per_band_lp() {
    let (s, r, walls) = case_03_setup();
    let lw = flat_100_db_octave();
    let lp = evaluate_with_barriers(&lw, s, r, 0.5, &walls, None);
    // Loose check on the new low bands; tighter on the existing reference
    // bands (which we don't expect to change).
    let expected = [
        46.0, 45.6,                                                           // 16, 31.5 Hz approx
        45.18, 41.34, 41.52, 38.13, 36.10, 33.09, 27.94, 18.79,
    ];
    for (i, exp) in expected.iter().enumerate() {
        let tol = if i < 2 { 2.0 } else { TOL_PER_BAND_DB };
        assert_relative_eq!(lp.bands[i], *exp, epsilon = tol);
    }
}

#[test]
fn case_03_no_barrier_baseline_is_louder() {
    use beesty_solver::iso9613::evaluate_with_ground;
    let (s, r, walls) = case_03_setup();
    let lw = flat_100_db_octave();
    let lp_with = evaluate_with_barriers(&lw, s, r, 0.5, &walls, None);
    let lp_without = evaluate_with_ground(&lw, s, r, 0.5);
    // Barrier should reduce the level substantially (≈ 14 dB(A) per validation).
    let drop = lp_without.a_weighted_total() - lp_with.a_weighted_total();
    assert!(drop > 10.0 && drop < 18.0, "drop = {} dB(A)", drop);
}

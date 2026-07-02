//! Validation case 07 — barrier on elevated terrain (z-datum regression).
//!
//! See `validation/case-07-barrier-on-elevated-terrain.md`. Locks finding A1:
//! the solver must compute barrier diffraction in a consistent absolute datum
//! while still reading ground heights as height-above-ground. Lifting case 03
//! onto a plateau of any elevation must reproduce case 03 exactly, because a
//! constant added to every z leaves the diffraction geometry unchanged.
//!
//! Before the z-datum split, passing HAG source/receiver z together with an
//! absolute barrier top blew Δz up by ~the plateau elevation and pinned Dz at
//! its cap. This test would have failed badly at elevation 100 m / 500 m.

use approx::assert_relative_eq;
use beesty_solver::iso9613::atmosphere::Atmosphere;
use beesty_solver::iso9613::barrier::{BarrierConvention, WallBarrier};
use beesty_solver::iso9613::evaluate_with_barriers;
use beesty_solver::{BandSpectrum, BandSystem, Vec3};

fn flat_100_db_octave() -> BandSpectrum<f64> {
    BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat(100.0).take(10))
}

/// Case 03 geometry lifted onto a plateau at `ground_elev` m AMSL. Source HAG
/// 5 m, receiver HAG 1.5 m, ridge crest 8 m above the plateau; `dp = 100 m`.
fn lat_on_plateau(ground_elev: f64) -> f64 {
    let s = Vec3::new(0.0, 0.0, ground_elev + 5.0); // absolute geometry z
    let r = Vec3::new(100.0, 0.0, ground_elev + 1.5);
    let h_s = 5.0; // height above local ground
    let h_r = 1.5;
    let walls = vec![WallBarrier {
        a_e: 50.0, a_n: -1000.0,
        b_e: 50.0, b_n: 1000.0,
        // Ground under the barrier sits on the same plateau; top follows it.
        base_z_a: ground_elev, base_z_b: ground_elev, height_agl: 8.0,
    }];
    let lw = flat_100_db_octave();
    let lp = evaluate_with_barriers(
        &lw, s, r, h_s, h_r, 0.5, &walls, &[], None,
        Atmosphere::iso_reference(), BarrierConvention::IsoEq16,
    );
    lp.a_weighted_total()
}

#[test]
fn barrier_result_is_invariant_to_plateau_elevation() {
    let at0 = lat_on_plateau(0.0);
    let at100 = lat_on_plateau(100.0);
    let at500 = lat_on_plateau(500.0);

    // All three must equal case 03 (41.17 dB(A)) and each other.
    assert_relative_eq!(at0, 41.17, epsilon = 0.5);
    assert_relative_eq!(at100, at0, epsilon = 1e-6);
    assert_relative_eq!(at500, at0, epsilon = 1e-6);
}

#[test]
fn divergence_includes_source_receiver_ground_elevation_difference() {
    // A2: source on a 250 m ridge, receiver in a 50 m valley, 500 m apart.
    // The true slant distance must include the 200 m elevation difference
    // (plus the small HAG terms), not just the HAG difference.
    use beesty_solver::iso9613::divergence;
    let hub_hagl = 5.0;
    let rx_hagl = 1.5;
    let s = Vec3::new(0.0, 0.0, 250.0 + hub_hagl);
    let r = Vec3::new(500.0, 0.0, 50.0 + rx_hagl);
    let adiv = divergence::adiv(s, r);

    // d = sqrt(500² + ((50+1.5) − (250+5))²) = sqrt(500² + 203.5²) = 539.78 m
    let d_true = (500.0f64.powi(2) + (203.5f64).powi(2)).sqrt();
    let expected = 20.0 * d_true.log10() + 11.0;
    assert_relative_eq!(adiv, expected, epsilon = 1e-9);

    // And it must differ from the (wrong) HAG-only distance by ~0.67 dB.
    let d_hag = (500.0f64.powi(2) + (rx_hagl - hub_hagl).powi(2)).sqrt();
    let adiv_hag = 20.0 * d_hag.log10() + 11.0;
    assert!((adiv - adiv_hag).abs() > 0.5, "elevation diff should shift Adiv by >0.5 dB");
}

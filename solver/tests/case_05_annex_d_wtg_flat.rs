//! Validation case 05 — see `validation/case-05-annex-d-wtg-flat.md`.
//!
//! WTG hub at (0,0,100), rotor diameter 120 m. Receiver displayed at 1.5 m
//! but Annex D forces calc height to 4.0 m. dp = 500 m, G_user = 0.5 (caps
//! at 0.5 anyway). No barriers, no concave correction. Test spectrum
//! [95,100,103,105,103,100,95,89]. Expected LAT(DW) = 41.33 dB(A).

use approx::assert_relative_eq;
use beesty_solver::iso9613::annex_d::{evaluate_wtg, WtgRules};
use beesty_solver::iso9613::atmosphere::Atmosphere;
use beesty_solver::iso9613::barrier::BarrierConvention;
use beesty_solver::{BandSpectrum, BandSystem, Vec3};

fn case_05_setup() -> (Vec3<f64>, Vec3<f64>, BandSpectrum<f64>) {
    let hub = Vec3::new(0.0, 0.0, 100.0);
    // Receiver as-displayed (1.5 m); Annex D internally clamps to 4 m.
    let r = Vec3::new(500.0, 0.0, 1.5);
    // 10 bands now (16, 31.5, 63, 125, 250, 500, 1k, 2k, 4k, 8k). Two new
    // low bands prepended with low values — they contribute nothing to the
    // A-weighted total.
    let lw_vals = [80.0, 88.0, 95.0, 100.0, 103.0, 105.0, 103.0, 100.0, 95.0, 89.0];
    let lw = BandSpectrum::from_iter(BandSystem::Octave, lw_vals.iter().copied());
    (hub, r, lw)
}

#[test]
fn case_05_a_weighted_total() {
    let (hub, r, lw) = case_05_setup();
    let lp = evaluate_wtg(
        &lw,
        hub,
        r,
        0.5,                  // G_user (Annex D caps at 0.5; this is already 0.5)
        &[],                  // no barriers
        WtgRules::default(),
        false,                // apply_concave = false (flat ground)
        120.0,                // rotor diameter
        Atmosphere::iso_reference(),
        BarrierConvention::IsoEq16,
    );
    assert_relative_eq!(lp.a_weighted_total(), 41.33, epsilon = 0.5);
}

#[test]
fn case_05_g_above_0_5_silently_capped() {
    // User passes G = 1.0 (porous), Annex D caps at 0.5 → result identical
    // to the G = 0.5 case.
    let (hub, r, lw) = case_05_setup();
    let lp_a = evaluate_wtg(
        &lw, hub, r, 0.5, &[], WtgRules::default(), false, 120.0,
        Atmosphere::iso_reference(), BarrierConvention::IsoEq16,
    );
    let lp_b = evaluate_wtg(
        &lw, hub, r, 1.0, &[], WtgRules::default(), false, 120.0,
        Atmosphere::iso_reference(), BarrierConvention::IsoEq16,
    );
    assert_relative_eq!(lp_a.a_weighted_total(), lp_b.a_weighted_total(), epsilon = 1e-9);
}

#[test]
fn case_05_receiver_below_4m_is_clamped() {
    // Receiver at 1.5 m vs receiver at 4.0 m — should give the same answer
    // because Annex D enforces 4 m for the ground calc regardless.
    let (hub, _, lw) = case_05_setup();
    let r_low = Vec3::new(500.0, 0.0, 1.5);
    let r_at4 = Vec3::new(500.0, 0.0, 4.0);
    let lp_low = evaluate_wtg(
        &lw, hub, r_low, 0.5, &[], WtgRules::default(), false, 120.0,
        Atmosphere::iso_reference(), BarrierConvention::IsoEq16,
    );
    let lp_at4 = evaluate_wtg(
        &lw, hub, r_at4, 0.5, &[], WtgRules::default(), false, 120.0,
        Atmosphere::iso_reference(), BarrierConvention::IsoEq16,
    );
    // Adiv differs slightly because actual receiver height enters d, but Agr
    // and Aatm are dominated. Allow up to ~0.3 dB(A) difference.
    let diff = (lp_low.a_weighted_total() - lp_at4.a_weighted_total()).abs();
    assert!(diff < 0.5, "diff = {} dB(A)", diff);
}

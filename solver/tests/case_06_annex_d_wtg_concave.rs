//! Validation case 06 — see `validation/case-06-annex-d-wtg-concave.md`.
//!
//! Same WTG / receiver as case 05 but with a concave ground profile triggering
//! the Annex D.5 −3 dB correction. Expected LAT(DW) = 44.33 dB(A) (= case 05
//! + 3 dB across all bands).

use approx::assert_relative_eq;
use beesty_solver::iso9613::annex_d::{evaluate_wtg, WtgRules};
use beesty_solver::{BandSpectrum, BandSystem, Vec3};

#[test]
fn case_06_concave_correction_applied() {
    let hub = Vec3::new(0.0, 0.0, 100.0);
    let r = Vec3::new(500.0, 0.0, 1.5);
    let lw_vals = [80.0, 88.0, 95.0, 100.0, 103.0, 105.0, 103.0, 100.0, 95.0, 89.0];
    let lw = BandSpectrum::from_iter(BandSystem::Octave, lw_vals.iter().copied());

    let lp_concave = evaluate_wtg(
        &lw, hub, r, 0.5, &[], WtgRules::default(), true, 120.0,
    );
    assert_relative_eq!(lp_concave.a_weighted_total(), 44.33, epsilon = 0.5);
}

#[test]
fn case_06_vs_case_05_offset_is_3db() {
    // The −3 dB ΔAgr across every band should result in exactly +3 dB(A)
    // total compared with the flat-ground case (Lp = LW − A; subtracting
    // 3 dB from Agr adds 3 dB to Lp uniformly across bands).
    let hub = Vec3::new(0.0, 0.0, 100.0);
    let r = Vec3::new(500.0, 0.0, 1.5);
    let lw_vals = [80.0, 88.0, 95.0, 100.0, 103.0, 105.0, 103.0, 100.0, 95.0, 89.0];
    let lw = BandSpectrum::from_iter(BandSystem::Octave, lw_vals.iter().copied());

    let lp_flat = evaluate_wtg(&lw, hub, r, 0.5, &[], WtgRules::default(), false, 120.0);
    let lp_concave = evaluate_wtg(&lw, hub, r, 0.5, &[], WtgRules::default(), true, 120.0);
    let delta = lp_concave.a_weighted_total() - lp_flat.a_weighted_total();
    assert_relative_eq!(delta, 3.0, epsilon = 0.05);
}

#[test]
fn case_06_concave_disabled_in_rules_skips_correction() {
    let hub = Vec3::new(0.0, 0.0, 100.0);
    let r = Vec3::new(500.0, 0.0, 1.5);
    let lw_vals = [80.0, 88.0, 95.0, 100.0, 103.0, 105.0, 103.0, 100.0, 95.0, 89.0];
    let lw = BandSpectrum::from_iter(BandSystem::Octave, lw_vals.iter().copied());

    let mut rules = WtgRules::default();
    rules.apply_concave_correction = false;

    // Even with apply_concave = true at the call site, the project setting
    // disables the correction.
    let lp_disabled = evaluate_wtg(&lw, hub, r, 0.5, &[], rules, true, 120.0);
    let lp_flat = evaluate_wtg(&lw, hub, r, 0.5, &[], WtgRules::default(), false, 120.0);
    assert_relative_eq!(
        lp_disabled.a_weighted_total(),
        lp_flat.a_weighted_total(),
        epsilon = 1e-9,
    );
}

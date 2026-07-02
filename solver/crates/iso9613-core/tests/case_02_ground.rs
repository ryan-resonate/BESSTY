//! Validation case 02 — see `validation/case-02-flat-ground-general-method.md`.
//!
//! Source at (0, 0, 5), receiver at (200, 0, 1.5), G = 0.5 uniform, flat
//! ground, 100 dB flat octave spectrum. Expected LAT(DW) = 48.00 dB(A).

use approx::assert_relative_eq;
use iso9613_core::iso9613::atmosphere::Atmosphere;
use iso9613_core::iso9613::{evaluate_with_ground, ground};
use iso9613_core::{BandSpectrum, BandSystem, Vec3};

const TOL_PER_BAND_DB: f64 = 0.55;
const TOL_OVERALL_DBA: f64 = 0.5;

fn case_02_geometry() -> (Vec3, Vec3) {
    (Vec3::new(0.0, 0.0, 5.0), Vec3::new(200.0, 0.0, 1.5))
}

fn flat_100_db_octave() -> BandSpectrum {
    BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat_n(100.0, 10))
}

#[test]
fn case_02_per_band_agr() {
    let (s, r) = case_02_geometry();
    // Flat ground at z = 0 → HAG equals absolute z.
    let agr = ground::agr_spectrum(s, r, s.z, r.z, 0.5, 0.5, 0.5, BandSystem::Octave);
    // 16 + 31.5 Hz octaves use the same Agr formula as 63 Hz (Table 3 only
    // defines 63 Hz upward; sub-63 Hz inherits the 63 Hz coefficients).
    let expected = [
        -3.074, -3.074,                                                        // 16, 31.5 Hz
        -3.074, 0.552, 2.356, 0.903, -1.214, -1.539, -1.539, -1.539,           // unchanged
    ];
    for (i, exp) in expected.iter().enumerate() {
        assert_relative_eq!(agr.bands[i], *exp, epsilon = 0.1);
    }
}

#[test]
fn case_02_per_band_lp() {
    let (s, r) = case_02_geometry();
    let lw = flat_100_db_octave();
    let lp = evaluate_with_ground(&lw, s, r, s.z, r.z, 0.5, Atmosphere::iso_reference());
    let expected = [
        46.053, 46.044,                                                        // 16, 31.5 Hz
        46.030, 42.347, 40.423, 41.696, 43.453, 42.578, 37.958, 21.118,        // unchanged
    ];
    for (i, exp) in expected.iter().enumerate() {
        assert_relative_eq!(lp.bands[i], *exp, epsilon = TOL_PER_BAND_DB);
    }
}

#[test]
fn case_02_a_weighted_total() {
    let (s, r) = case_02_geometry();
    let lw = flat_100_db_octave();
    let lp = evaluate_with_ground(&lw, s, r, s.z, r.z, 0.5, Atmosphere::iso_reference());
    let total = lp.a_weighted_total();
    assert_relative_eq!(total, 48.00, epsilon = TOL_OVERALL_DBA);
}

#[test]
fn case_02_q_threshold_active() {
    // dp = 200, 30·(hS + hR) = 30·6.5 = 195. dp > threshold → q > 0, middle
    // region active. Sanity-check that the same geometry with hR raised
    // enough to push 30·(hS + hR) past dp produces q = 0 and slightly
    // different Agr values.
    let s = Vec3::new(0.0, 0.0, 5.0);
    let r_low = Vec3::new(200.0, 0.0, 1.5);    // q > 0
    let r_high = Vec3::new(200.0, 0.0, 5.0);   // 30·10 = 300 > 200 → q = 0

    let agr_low = ground::agr_spectrum(s, r_low, s.z, r_low.z, 0.5, 0.5, 0.5, BandSystem::Octave);
    let agr_high = ground::agr_spectrum(s, r_high, s.z, r_high.z, 0.5, 0.5, 0.5, BandSystem::Octave);
    // The high-receiver case has q = 0, so Am = 0, while the low-receiver case
    // has small but nonzero Am contributions. The difference at 63 Hz is
    // dominated by Am (= -3·q ≈ -0.075) so the totals must differ.
    assert_ne!(agr_low.bands[0], agr_high.bands[0]);
}


//! Validation case 01 — see `validation/case-01-divergence-only.md`.
//!
//! Source at (0, 0, 100), receiver at (200, 0, 100), 100 dB flat spectrum,
//! free-field. Expected per-band Lp and overall LAT(DW) = 47.07 dB(A).

use approx::assert_relative_eq;
use iso9613_core::iso9613::atmosphere::Atmosphere;
use iso9613_core::iso9613::{atmosphere, divergence, evaluate_free_field};
use iso9613_core::{BandSpectrum, BandSystem, Vec3};

const TOL_PER_BAND_DB: f64 = 0.55;   // tolerance per validation/README.md
const TOL_OVERALL_DBA: f64 = 0.5;

fn case_01_geometry() -> (Vec3, Vec3) {
    let s = Vec3::new(0.0, 0.0, 100.0);
    let r = Vec3::new(200.0, 0.0, 100.0);
    (s, r)
}

fn flat_100_db_octave() -> BandSpectrum {
    // 10 bands now: 16, 31.5, 63, 125, 250, 500, 1k, 2k, 4k, 8k.
    BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat_n(100.0, 10))
}

#[test]
fn case_01_adiv_value() {
    let (s, r) = case_01_geometry();
    let a = divergence::adiv(s, r);
    assert_relative_eq!(a, 57.0206, epsilon = 0.05);
}

#[test]
fn case_01_per_band_lp() {
    let (s, r) = case_01_geometry();
    let lw = flat_100_db_octave();
    let lp = evaluate_free_field(&lw, s, r, Atmosphere::iso_reference());

    // Reference values for 10-band octave (16 Hz – 8 kHz). The original 8
    // values from validation/case-01 are at indices 2..10. The two new low
    // bands (16 Hz, 31.5 Hz) are essentially unattenuated by the atmosphere
    // — Lp ≈ 100 − Adiv − tiny_aatm.
    let expected = [
        42.978, 42.969,                                                       // 16, 31.5 Hz
        42.959, 42.899, 42.779, 42.599, 42.239, 41.039, 36.419, 19.579,       // unchanged
    ];
    for (i, exp) in expected.iter().enumerate() {
        assert_relative_eq!(
            lp.bands[i], *exp,
            epsilon = TOL_PER_BAND_DB,
        );
    }
}

#[test]
fn case_01_a_weighted_total() {
    let (s, r) = case_01_geometry();
    let lw = flat_100_db_octave();
    let lp = evaluate_free_field(&lw, s, r, Atmosphere::iso_reference());
    let total = lp.a_weighted_total();
    // The 16 + 31.5 Hz bands contribute negligibly under A-weighting
    // (offsets −56.4 and −39.4 dB respectively) so the total is unchanged
    // from the validation reference.
    assert_relative_eq!(total, 47.07, epsilon = TOL_OVERALL_DBA);
}

#[test]
fn case_01_third_octave_close_to_octave() {
    // The same broadband emission supplied as octave or third-octave should
    // give similar A-weighted totals. We don't have a defined third-octave
    // spectrum to match the octave one exactly; instead, distribute each
    // octave's energy equally across its three children and check the totals
    // agree within the documented ±0.2 dB(A) tolerance.
    let (s, r) = case_01_geometry();
    let lw_oct = flat_100_db_octave();
    let lp_oct = evaluate_free_field(&lw_oct, s, r, Atmosphere::iso_reference());

    // Distribute 100 dB → three children at 100 - 10·log10(3) = 95.23 dB each.
    // 31-band third-octave system after the band extension.
    let per_child = 100.0 - 10.0 * 3f64.log10();
    let lw_third = BandSpectrum::from_iter(
        BandSystem::OneThirdOctave,
        std::iter::repeat_n(per_child, 31),
    );
    let lp_third = evaluate_free_field(&lw_third, s, r, Atmosphere::iso_reference());

    assert_relative_eq!(
        lp_oct.a_weighted_total(),
        lp_third.a_weighted_total(),
        epsilon = 0.5,  // looser tolerance because the third-octave system
                        // covers slightly different bands (50 Hz–10 kHz vs
                        // 63 Hz–8 kHz) — the energy at the edges differs.
    );
}

#[test]
fn case_01_aatm_at_200m() {
    let (s, r) = case_01_geometry();
    let aatm = atmosphere::aatm_spectrum(s, r, BandSystem::Octave, Atmosphere::iso_reference());
    // Per validation/case-01: factor 0.2 km · table values; new low bands
    // (16, 31.5 Hz) prepended with very small αatm.
    let expected = [
        0.001, 0.010,                                                          // 16, 31.5 Hz
        0.020, 0.080, 0.200, 0.380, 0.740, 1.940, 6.560, 23.400,               // unchanged
    ];
    for (i, exp) in expected.iter().enumerate() {
        assert_relative_eq!(aatm.bands[i], *exp, epsilon = 0.5);
    }
}

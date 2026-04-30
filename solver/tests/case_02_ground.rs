//! Validation case 02 — see `validation/case-02-flat-ground-general-method.md`.
//!
//! Source at (0, 0, 5), receiver at (200, 0, 1.5), G = 0.5 uniform, flat
//! ground, 100 dB flat octave spectrum. Expected LAT(DW) = 48.00 dB(A).

use approx::assert_relative_eq;
use beesty_solver::iso9613::atmosphere::Atmosphere;
use beesty_solver::iso9613::{evaluate_with_ground, ground};
use beesty_solver::{BandSpectrum, BandSystem, Dual, Vec3};

const TOL_PER_BAND_DB: f64 = 0.55;
const TOL_OVERALL_DBA: f64 = 0.5;

fn case_02_geometry() -> (Vec3<f64>, Vec3<f64>) {
    (Vec3::new(0.0, 0.0, 5.0), Vec3::new(200.0, 0.0, 1.5))
}

fn flat_100_db_octave() -> BandSpectrum<f64> {
    BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat(100.0).take(10))
}

#[test]
fn case_02_per_band_agr() {
    let (s, r) = case_02_geometry();
    let agr = ground::agr_spectrum(s, r, 0.5, 0.5, 0.5, BandSystem::Octave);
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
    let lp = evaluate_with_ground(&lw, s, r, 0.5, Atmosphere::iso_reference());
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
    let lp = evaluate_with_ground(&lw, s, r, 0.5, Atmosphere::iso_reference());
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

    let agr_low = ground::agr_spectrum(s, r_low, 0.5, 0.5, 0.5, BandSystem::Octave);
    let agr_high = ground::agr_spectrum(s, r_high, 0.5, 0.5, 0.5, BandSystem::Octave);
    // The high-receiver case has q = 0, so Am = 0, while the low-receiver case
    // has small but nonzero Am contributions. The difference at 63 Hz is
    // dominated by Am (= -3·q ≈ -0.075) so the totals must differ.
    assert_ne!(agr_low.bands[0], agr_high.bands[0]);
}

#[test]
fn case_02_ad_gradient_w_r_t_source_height_finite_difference() {
    // Differentiate the A-weighted total w.r.t. source height (z) using AD,
    // and compare against a central finite difference at the same point.
    let lw_vals: [f64; 10] = [100.0; 10];

    // AD: source.z is the variable; everything else is constant.
    let s = Vec3::new(
        Dual::<1>::constant(0.0),
        Dual::<1>::constant(0.0),
        Dual::<1>::variable(5.0, 0),
    );
    let r = Vec3::new(
        Dual::<1>::constant(200.0),
        Dual::<1>::constant(0.0),
        Dual::<1>::constant(1.5),
    );
    let lw = BandSpectrum::from_iter(
        BandSystem::Octave,
        lw_vals.iter().map(|&v| Dual::<1>::constant(v)),
    );
    let lp_dual = evaluate_with_ground(&lw, s, r, Dual::<1>::constant(0.5), Atmosphere::iso_reference());

    // Compute A-weighted total and its derivative via the dual numbers'
    // chain rule. We mirror the f64 a_weighted_total math.
    let a_w = BandSystem::Octave.a_weighting();
    let ln10 = std::f64::consts::LN_10;
    // d(10·log10(sum))/d(input) = (10/ln10) · (d(sum)/d(input)) / sum
    // sum = Σ 10^(0.1·(Lp + A)) = Σ exp(0.1·ln10·(Lp + A))
    // d(sum)/d(z) = Σ 0.1·ln10 · exp(...) · d(Lp)/d(z)
    //             = 0.1·ln10 · Σ 10^(0.1·(Lp + A)) · d(Lp)/d(z)
    let mut sum_v = 0.0;
    let mut sum_dz = 0.0;
    for (i, &a) in a_w.iter().enumerate() {
        let val = 10f64.powf(0.1 * (lp_dual.bands[i].v + a));
        sum_v += val;
        sum_dz += val * lp_dual.bands[i].d[0];
    }
    let d_total_dz_ad = (10.0 / ln10) * 0.1 * ln10 * sum_dz / sum_v;
    // simplifies to:  sum_dz / sum_v
    assert_relative_eq!(d_total_dz_ad, sum_dz / sum_v, epsilon = 1e-12);

    // Finite difference (central, h = 1e-3 m).
    let h = 1e-3_f64;
    let lw_f = BandSpectrum::from_iter(BandSystem::Octave, lw_vals.iter().copied());
    let lp_plus = evaluate_with_ground(
        &lw_f,
        Vec3::new(0.0, 0.0, 5.0 + h),
        Vec3::new(200.0, 0.0, 1.5),
        0.5,
        Atmosphere::iso_reference(),
    );
    let lp_minus = evaluate_with_ground(
        &lw_f,
        Vec3::new(0.0, 0.0, 5.0 - h),
        Vec3::new(200.0, 0.0, 1.5),
        0.5,
        Atmosphere::iso_reference(),
    );
    let fd = (lp_plus.a_weighted_total() - lp_minus.a_weighted_total()) / (2.0 * h);

    // Tolerance is loose because finite difference at h = 1 mm has its own
    // truncation error — typical relative error is ~1e-5.
    assert_relative_eq!(d_total_dz_ad, fd, epsilon = 1e-3);
}

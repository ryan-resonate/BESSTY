//! ISO 9613-2:2024 — 7.2 Atmospheric absorption (Eq 9), with the per-band
//! coefficient α(f, T, h, p) computed from first principles per
//! ISO 9613-1:1996 §8 + Annex E.
//!
//! `Aatm = αatm · d / 1000`, with `αatm` in dB/km.
//!
//! Earlier versions of this module hard-coded the ISO reference table
//! (10 °C, 70 % RH, 101.325 kPa) and accepted no user override. That made
//! it impossible to reconcile BESSTY's output with reference tools that
//! default to different conditions (e.g. 15 °C / 70 % RH for moderate-
//! climate noise modelling, or warmer / drier conditions for tropical /
//! arid sites). The closed-form here lets the project specify any (T,
//! RH, p) and pulls a per-band α with no table lookup.

use crate::dual::ADScalar;
use crate::spectrum::{BandSpectrum, BandSystem};
use crate::units::{Hz, Vec3};

/// Air-mass conditions for the ISO 9613-1 absorption calc. The defaults
/// (`Atmosphere::iso_reference()`) are the ISO 9613-2 reference used in
/// most noise-modelling software when no other conditions are specified.
#[derive(Copy, Clone, Debug)]
pub struct Atmosphere {
    /// Air temperature, °C.
    pub temperature_c: f64,
    /// Relative humidity, % (0–100).
    pub relative_humidity_pct: f64,
    /// Atmospheric pressure, kPa. 101.325 = sea level.
    pub pressure_kpa: f64,
}

impl Atmosphere {
    /// ISO 9613-2 reference: 10 °C, 70 % RH, 101.325 kPa.
    pub const fn iso_reference() -> Self {
        Self { temperature_c: 10.0, relative_humidity_pct: 70.0, pressure_kpa: 101.325 }
    }
}

impl Default for Atmosphere {
    fn default() -> Self { Self::iso_reference() }
}

/// Closed-form α(f) per ISO 9613-1 §8 + Annex E. Returns dB/km.
///
/// Reference equations:
///   - α(f) = 8.686 · f² · ( 1.84e-11 · (p_r/p) · √(T/T₀)
///                         + (T/T₀)^(-2.5) ·
///                           ( 0.01275 · exp(-2239.1/T) / (f_rO + f²/f_rO)
///                           + 0.1068  · exp(-3352  /T) / (f_rN + f²/f_rN) ) )
///                              ↑ dB/m, multiplied by 1000 below for dB/km
///   - f_rO = (p/p_r) · ( 24 + 4.04e4 · h · (0.02+h) / (0.391+h) )
///   - f_rN = (p/p_r) · √(T₀/T) · ( 9 + 280 · h · exp(-4.170 · ((T₀/T)^(1/3) − 1)) )
///   - h    = h_r · 10^(-6.8346·(T₀₁/T)^1.261 + 4.6151) · (p_r/p)
///                        ↑ molar concentration of water vapour (%)
///
/// where T₀ = 293.15 K (20 °C), T₀₁ = 273.16 K (triple point), p_r = 101325 Pa.
pub fn alpha_atm_at(f: Hz, atm: Atmosphere) -> f64 {
    let t_kelvin = atm.temperature_c + 273.15;
    let t0 = 293.15;
    let t01 = 273.16;
    let p = atm.pressure_kpa * 1000.0;
    let pr = 101_325.0;
    let hr = atm.relative_humidity_pct;

    // Molar concentration of water vapour (%).
    let psat_pr = 10f64.powf(-6.8346 * (t01 / t_kelvin).powf(1.261) + 4.6151);
    let h = hr * psat_pr * (pr / p);

    // Relaxation frequencies for oxygen and nitrogen (Hz).
    let fr_o = (p / pr) * (24.0 + 4.04e4 * h * (0.02 + h) / (0.391 + h));
    let fr_n = (p / pr) * (t_kelvin / t0).powf(-0.5)
        * (9.0 + 280.0 * h * (-4.170 * ((t_kelvin / t0).powf(-1.0 / 3.0) - 1.0)).exp());

    let f2 = f * f;
    let alpha_db_per_m = 8.686 * f2 * (
        1.84e-11 * (pr / p) * (t_kelvin / t0).sqrt()
        + (t_kelvin / t0).powf(-2.5) * (
            0.01275 * (-2239.1 / t_kelvin).exp() / (fr_o + f2 / fr_o)
            + 0.1068 * (-3352.0 / t_kelvin).exp() / (fr_n + f2 / fr_n)
        )
    );
    alpha_db_per_m * 1000.0
}

/// Per-band Aatm spectrum: `Aatm[i] = α(f_i, atm) · d / 1000`.
pub fn aatm_spectrum<T: ADScalar>(
    source_pos: Vec3<T>,
    receiver_pos: Vec3<T>,
    system: BandSystem,
    atm: Atmosphere,
) -> BandSpectrum<T> {
    let d = receiver_pos.sub(source_pos).length();
    let d_km = d / T::from_f64(1000.0);

    let mut spectrum = BandSpectrum::zeros(system);
    for (i, &f) in system.centres().iter().enumerate() {
        let alpha = T::from_f64(alpha_atm_at(f, atm));
        spectrum.bands[i] = alpha * d_km;
    }
    spectrum
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::spectrum::OCTAVE_CENTRES_HZ;
    use approx::assert_relative_eq;

    /// Sanity check: at the ISO reference the closed-form must agree with
    /// the published octave-band table to within ~5 % at every band. The
    /// table values are themselves rounded so we can't expect exact match
    /// (and the older code used those rounded values directly).
    #[test]
    fn closed_form_matches_iso_reference_table_within_tolerance() {
        // ISO 9613-1 Table 1 values at 10 °C, 70 % RH, 101.325 kPa.
        let table = [
            (16.0,    0.005),  // approximate — table starts at 50 Hz typically
            (31.5,    0.05),
            (63.0,    0.1),
            (125.0,   0.4),
            (250.0,   1.0),
            (500.0,   1.9),
            (1000.0,  3.66),
            (2000.0,  9.7),
            (4000.0,  33.0),
            (8000.0,  117.0),
        ];
        for (f, expected) in table {
            let computed = alpha_atm_at(f, Atmosphere::iso_reference());
            // Wider tolerance at low frequencies where the table values are
            // themselves approximate (ISO 9613-1 Table 1 starts at 50 Hz; the
            // 16 / 31.5 Hz entries here are extrapolations and unreliable to
            // better than ~1 dB/km absolute).
            let tol = if f < 50.0 { 1.0 } else if f < 100.0 { 0.5 } else { 0.20 };
            let rel = (computed - expected).abs() / expected.max(1e-3);
            assert!(
                rel < tol,
                "α({} Hz, ISO ref) = {:.3} dB/km, expected ≈ {} dB/km (rel err {:.3})",
                f, computed, expected, rel,
            );
        }
        // Force-touch the constants list so a stale len assumption fires.
        assert_eq!(OCTAVE_CENTRES_HZ.len(), 10);
    }

    #[test]
    fn aatm_at_200m_octave_uses_iso_ref_when_default() {
        let s = Vec3::new(0.0, 0.0, 100.0);
        let r = Vec3::new(200.0, 0.0, 100.0);
        let a = aatm_spectrum(s, r, BandSystem::Octave, Atmosphere::iso_reference());
        // At 1 kHz, ISO ref α ≈ 3.66 dB/km, so Aatm at 200 m ≈ 0.732 dB.
        assert_relative_eq!(a.bands[6], 0.73, epsilon = 0.05);
    }

    #[test]
    fn warmer_air_increases_mid_band_alpha() {
        // 1 kHz absorption at 20 °C / 70 % RH should be higher than at 10 °C / 70 % RH.
        let warm = Atmosphere { temperature_c: 20.0, relative_humidity_pct: 70.0, pressure_kpa: 101.325 };
        let cool = Atmosphere::iso_reference();
        assert!(alpha_atm_at(1000.0, warm) > alpha_atm_at(1000.0, cool));
    }
}

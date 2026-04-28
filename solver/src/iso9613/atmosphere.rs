//! ISO 9613-2:2024 — 7.2 Atmospheric absorption (Eq 9).
//!
//! `Aatm = αatm · d / 1000`, with `αatm` in dB/km computed per ISO 9613-1:1993.
//!
//! For v0.1 we use a fixed lookup table at the ISO reference conditions
//! (10 °C, 70 % RH, 101.325 kPa). A future version will compute αatm directly
//! from ISO 9613-1 Eqs 2–6 so that user-specified atmospheres are supported.

use crate::dual::ADScalar;
use crate::spectrum::{BandSpectrum, BandSystem, OCTAVE_CENTRES_HZ};
use crate::units::{Hz, Vec3};

/// Atmospheric absorption coefficient αatm (dB/km) per octave band at the
/// ISO reference conditions (10 °C, 70 % RH).
///
/// Now 10 octave bands (16 Hz – 8 kHz) — the 16 / 31.5 Hz values are tiny
/// (sub-audible content barely attenuated by the atmosphere). To be
/// replaced with on-the-fly ISO 9613-1 computation once the user can
/// override atmospheric conditions.
const OCTAVE_ALPHA_ATM_DB_PER_KM: [f64; 10] = [
    0.005, // 16 Hz
    0.05,  // 31.5 Hz
    0.1,   // 63 Hz
    0.4,   // 125 Hz
    1.0,   // 250 Hz
    1.9,   // 500 Hz
    3.7,   // 1 kHz
    9.7,   // 2 kHz
    32.8,  // 4 kHz
    117.0, // 8 kHz
];

/// Returns αatm (dB/km) for any frequency by log-linear interpolation between
/// adjacent octave-band values. Good enough for a first cut; ISO 9613-1
/// computes α directly from physics — that supersedes this once implemented.
fn alpha_atm_at(f: Hz) -> f64 {
    let n = OCTAVE_CENTRES_HZ.len();
    if f <= OCTAVE_CENTRES_HZ[0]     { return OCTAVE_ALPHA_ATM_DB_PER_KM[0]; }
    if f >= OCTAVE_CENTRES_HZ[n - 1] { return OCTAVE_ALPHA_ATM_DB_PER_KM[n - 1]; }

    for i in 0..n - 1 {
        let f0 = OCTAVE_CENTRES_HZ[i];
        let f1 = OCTAVE_CENTRES_HZ[i + 1];
        if f >= f0 && f <= f1 {
            let log_f = f.ln();
            let log_f0 = f0.ln();
            let log_f1 = f1.ln();
            let log_a0 = OCTAVE_ALPHA_ATM_DB_PER_KM[i].ln();
            let log_a1 = OCTAVE_ALPHA_ATM_DB_PER_KM[i + 1].ln();
            let t = (log_f - log_f0) / (log_f1 - log_f0);
            return (log_a0 + t * (log_a1 - log_a0)).exp();
        }
    }
    OCTAVE_ALPHA_ATM_DB_PER_KM[n - 1]
}

/// Per-band Aatm spectrum: `Aatm[i] = α(f_i) · d / 1000`.
pub fn aatm_spectrum<T: ADScalar>(
    source_pos: Vec3<T>,
    receiver_pos: Vec3<T>,
    system: BandSystem,
) -> BandSpectrum<T> {
    let d = receiver_pos.sub(source_pos).length();
    let d_km = d / T::from_f64(1000.0);

    let mut spectrum = BandSpectrum::zeros(system);
    for (i, &f) in system.centres().iter().enumerate() {
        let alpha = T::from_f64(alpha_atm_at(f));
        spectrum.bands[i] = alpha * d_km;
    }
    spectrum
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn alpha_at_octave_centres_returns_table_values() {
        for (i, &f) in OCTAVE_CENTRES_HZ.iter().enumerate() {
            assert_relative_eq!(alpha_atm_at(f), OCTAVE_ALPHA_ATM_DB_PER_KM[i], epsilon = 1e-9);
        }
    }

    #[test]
    fn third_octave_at_octave_centres_matches_octave() {
        // 1000 Hz is at index 20 in the new 31-band third-octave system.
        // It maps to octave index 6 (1 kHz) in the 10-band octave system.
        let f_third = crate::spectrum::ONE_THIRD_OCTAVE_CENTRES_HZ[20];
        assert_eq!(f_third, 1000.0);
        assert_relative_eq!(alpha_atm_at(f_third), OCTAVE_ALPHA_ATM_DB_PER_KM[6], epsilon = 1e-9);
    }

    #[test]
    fn aatm_at_200m_octave_matches_case_01() {
        let s = Vec3::new(0.0, 0.0, 100.0);
        let r = Vec3::new(200.0, 0.0, 100.0);
        let a = aatm_spectrum(s, r, BandSystem::Octave);
        // d = 200 m, factor 0.2 km. New 10-band layout starts at 16 Hz.
        for (i, &alpha) in OCTAVE_ALPHA_ATM_DB_PER_KM.iter().enumerate() {
            assert_relative_eq!(a.bands[i], alpha * 0.2, epsilon = 1e-9);
        }
    }
}

//! ISO 9613-2 — 7.1 Geometric divergence (1996 Eq 7 ≡ 2024 Eq 8; identical
//! in both editions).
//!
//! `Adiv = 20 · log10(d / d0) + 11`,  where `d0 = 1 m` and `d` is the 3D
//! source-to-receiver distance in metres.
//!
//! Frequency-independent: returns the same scalar value applied to every
//! band of the active spectrum.

use crate::spectrum::{BandSpectrum, BandSystem};
use crate::units::Vec3;

/// Returns `Adiv` as a scalar (dB). Frequency-independent.
pub fn adiv(source_pos: Vec3, receiver_pos: Vec3) -> f64 {
    let d = receiver_pos.sub(source_pos).length();
    20.0 * d.log10() + 11.0
}

/// Convenience: spread the scalar Adiv across every band of the spectrum.
pub fn adiv_spectrum(source_pos: Vec3, receiver_pos: Vec3, system: BandSystem) -> BandSpectrum {
    let a = adiv(source_pos, receiver_pos);
    BandSpectrum::from_iter(system, std::iter::repeat_n(a, system.n_bands()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn adiv_at_200m_matches_validation_case_01() {
        let s = Vec3::new(0.0, 0.0, 100.0);
        let r = Vec3::new(200.0, 0.0, 100.0);
        let a = adiv(s, r);
        // 20·log10(200) + 11 = 46.0206 + 11 = 57.0206
        assert_relative_eq!(a, 57.0206, epsilon = 1e-3);
    }
}

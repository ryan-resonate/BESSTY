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
///
/// The distance is floored at 1 mm so a receiver coincident with (an
/// extended-source sub-point of) the source yields a finite, large `Adiv`
/// instead of `20·log10(0) = −∞` poisoning every band to `+∞`. A coincident
/// *point* source/receiver is separately rejected by `Scene::validate`.
pub fn adiv(source_pos: Vec3, receiver_pos: Vec3) -> f64 {
    let d = receiver_pos.sub(source_pos).length().max(1e-3);
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

    #[test]
    fn adiv_is_finite_at_zero_distance() {
        // A receiver coincident with a (sub-)source must not blow up to −∞.
        let p = Vec3::new(10.0, 20.0, 3.0);
        let a = adiv(p, p);
        assert!(a.is_finite(), "Adiv must stay finite at d = 0, got {a}");
        // Floored at d0 = 1 mm ⇒ 20·log10(1e-3) + 11 = −49.
        assert_relative_eq!(a, -49.0, epsilon = 1e-6);
    }
}

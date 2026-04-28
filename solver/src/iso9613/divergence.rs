//! ISO 9613-2:2024 — 7.1 Geometric divergence (Eq 8).
//!
//! `Adiv = 20 · log10(d / d0) + 11`,  where `d0 = 1 m` and `d` is the 3D
//! source-to-receiver distance in metres.
//!
//! Frequency-independent: returns the same scalar value applied to every
//! band of the active spectrum.

use crate::dual::ADScalar;
use crate::spectrum::{BandSpectrum, BandSystem};
use crate::units::Vec3;

/// Returns `Adiv` as a scalar (dB). Frequency-independent.
pub fn adiv<T: ADScalar>(source_pos: Vec3<T>, receiver_pos: Vec3<T>) -> T {
    let d = receiver_pos.sub(source_pos).length();
    T::from_f64(20.0) * d.log10() + T::from_f64(11.0)
}

/// Convenience: spread the scalar Adiv across every band of the spectrum.
pub fn adiv_spectrum<T: ADScalar>(
    source_pos: Vec3<T>,
    receiver_pos: Vec3<T>,
    system: BandSystem,
) -> BandSpectrum<T> {
    let a = adiv(source_pos, receiver_pos);
    BandSpectrum::from_iter(system, std::iter::repeat(a).take(system.n_bands()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::dual::Dual;
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
    fn adiv_gradient_w_r_t_source_position() {
        // Place source as Dual<3> tracking (e, n, z); receiver is constant.
        let s = Vec3::new(
            Dual::<3>::variable(0.0, 0),
            Dual::<3>::variable(0.0, 1),
            Dual::<3>::variable(100.0, 2),
        );
        let r = Vec3::new(
            Dual::<3>::constant(200.0),
            Dual::<3>::constant(0.0),
            Dual::<3>::constant(100.0),
        );
        let a = adiv(s, r);

        // d = 200, dAdiv/dd = 20 / (200 · ln(10)) = 0.04343
        // Gradient w.r.t. source.e: -dAdiv/dd · (rx.e - src.e) / d = -0.04343 · 1 = -0.04343
        // (Negative because increasing source.e moves it away from receiver, decreasing d? wait, rx is east of src; moving src east shortens d.)
        // Actually d² = (rx.e - src.e)² + ... so dd/d(src.e) = -(rx.e - src.e)/d = -200/200 = -1.
        // dAdiv/d(src.e) = (20 / (d · ln10)) · dd/d(src.e) = 0.04343 · -1 = -0.04343
        assert_relative_eq!(a.d[0], -0.04343, epsilon = 1e-4);
        // src.n direction is perpendicular at this geometry: dd/d(src.n) = 0
        assert_relative_eq!(a.d[1], 0.0, epsilon = 1e-9);
        // src.z: rx.z - src.z = 0, so dd/d(src.z) = 0 at this geometry
        assert_relative_eq!(a.d[2], 0.0, epsilon = 1e-9);
    }
}

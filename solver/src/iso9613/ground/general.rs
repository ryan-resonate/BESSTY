//! ISO 9613-2:2024 — 7.3.1 Ground attenuation, General method.
//!
//! Per Table 3:
//!   - Three regions: source (extending 30·hS toward receiver, capped at dp),
//!     receiver (extending 30·hR back from receiver, capped at dp), and a
//!     middle region between them (empty if dp ≤ 30·(hS + hR)).
//!   - Per region, a component attenuation AS / AR / Am.
//!   - Total `Agr_inner = AS + AR + Am`, then Eq 11 applies the Kgeo
//!     correction (Eq 13) so that ground influence vanishes for very small
//!     `dp` relative to `hS` or `hR`.
//!
//! v0.2 takes flat ground at z = 0; future versions consume a DEM and
//! compute hS, hR, and per-region G from local terrain.

use crate::dual::ADScalar;
use crate::spectrum::{BandSpectrum, BandSystem};
use crate::units::Vec3;

use super::functions::{a_prime, b_prime, c_prime, d_prime};

/// `Agr` per band per ISO 9613-2:2024 Eqs 10–13.
///
/// `g_source`, `g_middle`, `g_receiver` are the ground factors for the three
/// regions (0.0 = hard, 1.0 = porous, mixed in between). v0.2 typically
/// passes the same value for all three; future versions split by terrain
/// classification along the path.
///
/// Source and receiver heights `hS`, `hR` are taken from the z components of
/// the position vectors (flat ground at z = 0 is assumed for v0.2).
pub fn agr_spectrum<T: ADScalar>(
    source_pos: Vec3<T>,
    receiver_pos: Vec3<T>,
    g_source: T,
    g_middle: T,
    g_receiver: T,
    system: BandSystem,
) -> BandSpectrum<T> {
    let h_s = source_pos.z;
    let h_r = receiver_pos.z;
    let delta = receiver_pos.sub(source_pos);
    let dp = delta.length_horizontal();

    // q factor (Table 3 footnote b): zero when source/receiver regions cover
    // the whole path, otherwise the fraction of dp not covered by either.
    // Hard switch on the primal value; the orchestrator's tripwire monitors
    // proximity to the boundary `dp = 30·(hS + hR)`.
    let threshold_v = 30.0 * (h_s.to_f64() + h_r.to_f64());
    let q = if dp.to_f64() <= threshold_v {
        T::zero()
    } else {
        T::one() - T::from_f64(30.0) * (h_s + h_r) / dp
    };

    // Kgeo (Eq 13).
    let dp_sq = dp * dp;
    let h_diff = h_s - h_r;
    let h_sum = h_s + h_r;
    let kgeo = (dp_sq + h_diff * h_diff) / (dp_sq + h_sum * h_sum);

    let mut spectrum = BandSpectrum::zeros(system);
    let ln10 = T::from_f64(std::f64::consts::LN_10);

    for band_idx in 0..system.n_bands() {
        let octave = system.parent_octave(band_idx);
        let a_s = a_side_per_octave(g_source, h_s, dp, octave);
        let a_r = a_side_per_octave(g_receiver, h_r, dp, octave);
        let a_m = a_middle_per_octave(g_middle, q, octave);

        let agr_inner = a_s + a_r + a_m;

        // Eq 11: Agr = -10·log10(1 + (10^(-Agr_inner/10) - 1) · Kgeo).
        // 10^x is computed as exp(x · ln 10) — avoids needing a powf trait.
        let exponent = (-agr_inner / T::from_f64(10.0)) * ln10;
        let ten_to_neg = exponent.exp();
        let arg = T::one() + (ten_to_neg - T::one()) * kgeo;
        spectrum.bands[band_idx] = -T::from_f64(10.0) * arg.log10();
    }

    spectrum
}

/// AS or AR per Table 3. Octave indexing in the *new* 10-band layout:
///   0 = 16 Hz, 1 = 31.5 Hz, 2 = 63 Hz, ..., 9 = 8 kHz.
///
/// ISO 9613-2 Table 3 only defines coefficients from 63 Hz upward. For the
/// new sub-63 Hz octaves (16 and 31.5 Hz) we apply the 63 Hz formula —
/// matches the standard's spirit of treating low frequencies as little
/// affected by ground type.
fn a_side_per_octave<T: ADScalar>(g: T, h: T, dp: T, octave: usize) -> T {
    let neg_1_5 = T::from_f64(-1.5);
    match octave {
        0 | 1 | 2 => neg_1_5,                              // 16, 31.5, 63 Hz
        3 => neg_1_5 + g * a_prime(h, dp),                 // 125 Hz
        4 => neg_1_5 + g * b_prime(h, dp),                 // 250 Hz
        5 => neg_1_5 + g * c_prime(h, dp),                 // 500 Hz
        6 => neg_1_5 + g * d_prime(h, dp),                 // 1 kHz
        7 | 8 | 9 => neg_1_5 * (T::one() - g),             // 2k, 4k, 8k
        _ => unreachable!("octave index out of range: {}", octave),
    }
}

/// Am per Table 3.
fn a_middle_per_octave<T: ADScalar>(g_m: T, q: T, octave: usize) -> T {
    let neg_3 = T::from_f64(-3.0);
    match octave {
        0 | 1 | 2 => neg_3 * q,                            // 16, 31.5, 63 Hz
        _ => neg_3 * q * (T::one() - g_m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    // Hand-calculated reference per validation/case-02-flat-ground-general-method.md.
    // Source at (0, 0, 5), receiver at (200, 0, 1.5), G = 0.5 uniform.
    fn case_02_geometry() -> (Vec3<f64>, Vec3<f64>) {
        (Vec3::new(0.0, 0.0, 5.0), Vec3::new(200.0, 0.0, 1.5))
    }

    #[test]
    fn agr_spectrum_matches_case_02() {
        let (s, r) = case_02_geometry();
        let agr = agr_spectrum(s, r, 0.5, 0.5, 0.5, BandSystem::Octave);
        // 10-band layout: 16, 31.5, 63, 125, 250, 500, 1k, 2k, 4k, 8k.
        // The new 16/31.5 Hz octaves use the 63 Hz formula → −3.074.
        let expected = [
            -3.074, -3.074,                                                    // 16, 31.5
            -3.074, 0.552, 2.356, 0.903, -1.214, -1.539, -1.539, -1.539,
        ];
        for (i, exp) in expected.iter().enumerate() {
            assert_relative_eq!(agr.bands[i], *exp, epsilon = 0.05);
        }
    }

    #[test]
    fn third_octave_inherits_octave_agr() {
        // Each third-octave band should produce the same Agr as its parent
        // octave (the Table-3 shape functions are octave-defined).
        let (s, r) = case_02_geometry();
        let agr_oct = agr_spectrum(s, r, 0.5, 0.5, 0.5, BandSystem::Octave);
        let agr_3rd = agr_spectrum(s, r, 0.5, 0.5, 0.5, BandSystem::OneThirdOctave);

        for (third_idx, &third_value) in agr_3rd.bands.iter().enumerate() {
            let parent = BandSystem::OneThirdOctave.parent_octave(third_idx);
            assert_relative_eq!(third_value, agr_oct.bands[parent], epsilon = 1e-9);
        }
    }
}

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
//! EDITION NOTE: the Kgeo wrap (Eqs 11–13) is 2024-only; the 1996 edition
//! uses the plain sum `Agr = AS + AR + Am` (its Eq 9). The `combination`
//! argument (from the active `EditionSpec`) selects between them.

use crate::spectrum::{BandSpectrum, BandSystem};
use crate::units::Vec3;

use super::functions::{a_prime, b_prime, c_prime, d_prime};
use super::GroundCombination;

/// `Agr` per band per ISO 9613-2:2024 Eqs 10–13.
///
/// `g_source`, `g_middle`, `g_receiver` are the ground factors for the three
/// regions (0.0 = hard, 1.0 = porous, mixed in between). Callers typically
/// pass the same value for all three until per-region ground regions land
/// (Phase 3).
///
/// `h_s`, `h_r` are the source/receiver **heights above local ground** (HAG),
/// passed explicitly rather than read from the position `z`. The positions are
/// in an absolute datum (so `divergence`/`barrier` geometry is consistent over
/// real terrain); only their horizontal components feed `dp` here. Conflating
/// the two — reading `h_s = source_pos.z` while `z` carried absolute elevation
/// — was the v0.x terrain bug (see `docs/solver-review-2026-06.md`, A1).
#[allow(clippy::too_many_arguments)]
pub fn agr_spectrum(
    source_pos: Vec3,
    receiver_pos: Vec3,
    h_s: f64,
    h_r: f64,
    g_source: f64,
    g_middle: f64,
    g_receiver: f64,
    system: BandSystem,
    combination: GroundCombination,
) -> BandSpectrum {
    let delta = receiver_pos.sub(source_pos);
    let dp = delta.length_horizontal();

    // q factor (Table 3 footnote b): zero when source/receiver regions cover
    // the whole path, otherwise the fraction of dp not covered by either.
    let threshold_v = 30.0 * (h_s + h_r);
    let q = if dp <= threshold_v {
        0.0
    } else {
        1.0 - 30.0 * (h_s + h_r) / dp
    };

    // Kgeo (Eq 13).
    let dp_sq = dp * dp;
    let h_diff = h_s - h_r;
    let h_sum = h_s + h_r;
    let kgeo = (dp_sq + h_diff * h_diff) / (dp_sq + h_sum * h_sum);

    let mut spectrum = BandSpectrum::zeros(system);
    let ln10 = std::f64::consts::LN_10;

    for band_idx in 0..system.n_bands() {
        let octave = system.parent_octave(band_idx);
        let a_s = a_side_per_octave(g_source, h_s, dp, octave);
        let a_r = a_side_per_octave(g_receiver, h_r, dp, octave);
        let a_m = a_middle_per_octave(g_middle, q, octave);

        let agr_inner = a_s + a_r + a_m;

        spectrum.bands[band_idx] = match combination {
            // 1996 Eq 9: plain sum.
            GroundCombination::Sum => agr_inner,
            // 2024 Eq 11: Agr = -10·log10(1 + (10^(-Agr_inner/10) - 1) · Kgeo).
            // 10^x is computed as exp(x · ln 10) — kept in this exact form so
            // the value is bit-identical to the pre-EditionSpec implementation.
            GroundCombination::KgeoWrap => {
                let exponent = (-agr_inner / 10.0) * ln10;
                let ten_to_neg = exponent.exp();
                let arg = 1.0 + (ten_to_neg - 1.0) * kgeo;
                -10.0 * arg.log10()
            }
        };
    }

    spectrum
}

/// AS or AR per Table 3. Octave indexing in the 10-band layout:
///   0 = 16 Hz, 1 = 31.5 Hz, 2 = 63 Hz, ..., 9 = 8 kHz.
///
/// ISO 9613-2 Table 3 only defines coefficients from 63 Hz upward. For the
/// sub-63 Hz octaves (16 and 31.5 Hz) we apply the 63 Hz formula — matches
/// the standard's spirit of treating low frequencies as little affected by
/// ground type (non-normative extension; see `spectrum`).
fn a_side_per_octave(g: f64, h: f64, dp: f64, octave: usize) -> f64 {
    let neg_1_5 = -1.5;
    match octave {
        0..=2 => neg_1_5,                              // 16, 31.5, 63 Hz
        3 => neg_1_5 + g * a_prime(h, dp),                 // 125 Hz
        4 => neg_1_5 + g * b_prime(h, dp),                 // 250 Hz
        5 => neg_1_5 + g * c_prime(h, dp),                 // 500 Hz
        6 => neg_1_5 + g * d_prime(h, dp),                 // 1 kHz
        7..=9 => neg_1_5 * (1.0 - g),                  // 2k, 4k, 8k
        _ => unreachable!("octave index out of range: {}", octave),
    }
}

/// Am per Table 3.
fn a_middle_per_octave(g_m: f64, q: f64, octave: usize) -> f64 {
    let neg_3 = -3.0;
    match octave {
        0..=2 => neg_3 * q,                            // 16, 31.5, 63 Hz
        _ => neg_3 * q * (1.0 - g_m),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    // Hand-calculated reference per validation/case-02-flat-ground-general-method.md.
    // Source at (0, 0, 5), receiver at (200, 0, 1.5), G = 0.5 uniform.
    fn case_02_geometry() -> (Vec3, Vec3) {
        (Vec3::new(0.0, 0.0, 5.0), Vec3::new(200.0, 0.0, 1.5))
    }

    #[test]
    fn agr_spectrum_matches_case_02() {
        let (s, r) = case_02_geometry();
        // Flat ground → HAG equals absolute z.
        let agr = agr_spectrum(s, r, s.z, r.z, 0.5, 0.5, 0.5, BandSystem::Octave, GroundCombination::KgeoWrap);
        // 10-band layout: 16, 31.5, 63, 125, 250, 500, 1k, 2k, 4k, 8k.
        // The 16/31.5 Hz octaves use the 63 Hz formula → −3.074.
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
        let agr_oct = agr_spectrum(s, r, s.z, r.z, 0.5, 0.5, 0.5, BandSystem::Octave, GroundCombination::KgeoWrap);
        let agr_3rd = agr_spectrum(s, r, s.z, r.z, 0.5, 0.5, 0.5, BandSystem::OneThirdOctave, GroundCombination::KgeoWrap);

        for (third_idx, &third_value) in agr_3rd.bands.iter().enumerate() {
            let parent = BandSystem::OneThirdOctave.parent_octave(third_idx);
            assert_relative_eq!(third_value, agr_oct.bands[parent], epsilon = 1e-9);
        }
    }
}

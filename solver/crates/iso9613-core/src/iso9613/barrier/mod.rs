//! ISO 9613-2 — 7.4 Screening, Abar.
//!
//! Over-top diffraction (7.4.1) for straight wall barriers, including the
//! multi-edge rubber-band path, plus lateral diffraction around vertical wall
//! ends (7.4.3) combined per Eq 25 (7.4.4).
//!
//! The `Dz` formula bracket and `Kmet` form are edition-dependent — see
//! [`BarrierVariant`] and the `diffraction` module.
//!
//! Lateral-path selection (ISO/TR 17534-3 §5.2: the most-transmitting edge per
//! side of the S–R line, ≤ 2 paths, with the factor-8 neglect) happens in the
//! path engine (`path::build_geometry`); `abar_spectrum` here just combines the
//! ≤ 2 selected laterals with the over-top path per Eq 25.

pub mod diffraction;
pub mod path;

use crate::spectrum::{BandSpectrum, BandSystem};

pub use path::{BarrierGeometry, LateralEdge, WallBarrier};

/// Natural log of 10, for the dB↔energy conversions in the §7.4.4 combination.
const LN10: f64 = std::f64::consts::LN_10;

/// Edition selector for the barrier `Dz` formula: the log-argument bracket
/// (2024 Eq 18 vs 1996 Eq 14) and the `Kmet` form (2024 Eq 21 vs 1996 Eq 18)
/// differ between editions (differences doc §8.1–8.2). `zmin`, `C2`, and `C3`
/// are shared. Held in the active `EditionSpec`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BarrierVariant {
    /// ISO 9613-2:1996, as clarified by ISO/TR 17534-3 §5.4:
    /// `Dz = 10·lg[3 + (C2/λ)·C3·z·Kmet]`, `Kmet` denominator `2z`.
    V1996,
    /// ISO 9613-2:2024: `Dz = 10·lg[1 + (2 + (C2/λ)·C3·z)·Kmet]`,
    /// `Kmet` denominator `2(z − zmin)`, numerator `(max+e)·min`.
    V2024,
}

/// `Abar` per band: the barrier insertion loss, combined with the (barrier-
/// free) ground attenuation `agr` per the literal ISO reading (Eqs 16/17, as
/// clarified by ISO/TR 17534-3 §5.5).
///
/// `Agr` is **always** carried separately in the total attenuation (Eq 5), so
/// this returns just the `Abar` term:
///   - over-top with `Agr > 0`: `Abar = max(0, Dz − Agr)` → net effect `Dz`
///     once the caller adds `Agr` back;
///   - lateral, or `Agr ≤ 0` (a ground *boost*): `Abar = Dz` → net `Agr + Dz`.
/// This is the behaviour ISO/TR 17534-3 §5.5 mandates (never subtract a
/// negative `Agr`).
///
/// `dz_cap_db` overrides the standard 20 / 25 dB over-top cap (used by Annex D
/// for the WT terrain-screening case — typically 3 dB). Lateral paths are
/// never capped (§5.3).
pub fn abar_spectrum(
    geometry: Option<&path::BarrierGeometry>,
    agr: &BandSpectrum,
    system: BandSystem,
    dz_cap_db: Option<f64>,
    variant: BarrierVariant,
) -> BandSpectrum {
    let mut abar = BandSpectrum::zeros(system);

    // No over-top shielding — Abar = 0 across all bands. (Lateral diffraction
    // only ADDS open paths around a wall that IS screening, so there's nothing
    // to combine when the line of sight clears the top.)
    let geometry = match geometry {
        Some(g) => g,
        None => return abar,
    };
    let lengths = &geometry.over_top;
    let lat_lengths = &geometry.lateral;

    // Exact ISO 266 centres for λ = c/f (matches ISO/TR 17534-3 step values).
    for (band_idx, &f_centre) in system.centres_exact().iter().enumerate() {
        let lambda = 340.0 / f_centre;
        // Over-top path — capped (§5.3, over-top only).
        let dz_top = diffraction::cap(
            diffraction::dz_uncapped(lengths, lambda, variant),
            lengths.e_total,
            dz_cap_db,
        );

        // Literal ISO (Eqs 16/17, TR §5.5): the OVER-TOP diffraction takes the
        // ground attenuation off first — subtract a positive Agr from Dz_top
        // (never a negative Agr, which is a boost; Agr is carried separately by
        // the caller so the over-top net is Dz). This Agr adjustment applies to
        // the over-top path ALONE, before combining with the laterals (the
        // around-the-side paths don't travel over the screened ground top).
        let agr_band = agr.bands[band_idx];
        let abar_top = if agr_band > 0.0 && dz_top > 0.0 {
            (dz_top - agr_band).max(0.0)
        } else {
            dz_top
        };

        // §7.4.4 Eq 25 — energy-sum the (Agr-adjusted) over-top path with each
        // around-the-end (lateral) path into one effective attenuation:
        //   Dz_eff = −10·log10( 10^(−Abar_top/10) + Σ 10^(−Dz_lat/10) ).
        // More paths ⇒ more sound ⇒ less attenuation. A fully open path
        // (term = 1) drives Dz_eff ≤ 0, i.e. the obstacle is bypassed. Lateral
        // paths take no Agr, no cap (§5.3), and no Kmet (refraction curves the
        // ray over the top, not around the sides).
        abar.bands[band_idx] = if lat_lengths.is_empty() {
            abar_top
        } else {
            let neg_inv_ten = -LN10 / 10.0;
            let mut sum = (abar_top * neg_inv_ten).exp();
            for ll in lat_lengths {
                let dz_lat = diffraction::dz_uncapped_lateral(ll, lambda, variant);
                sum += (dz_lat * neg_inv_ten).exp();
            }
            let combined = -10.0 * sum.log10();
            if combined < 0.0 { 0.0 } else { combined }
        };
    }

    abar
}

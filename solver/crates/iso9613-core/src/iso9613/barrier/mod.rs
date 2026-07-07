//! ISO 9613-2 — 7.4 Screening, Abar.
//!
//! Over-top diffraction (7.4.1) for straight wall barriers, including the
//! multi-edge rubber-band path, plus lateral diffraction around vertical wall
//! ends (7.4.3) combined per Eq 25 (7.4.4).
//!
//! The `Dz` formula bracket and `Kmet` form are edition-dependent — see
//! [`BarrierVariant`] and the `diffraction` module.
//!
//! NOTE (Phase 1): lateral-path *selection* (ISO/TR 17534-3 §5.2 best-per-side,
//! ≤ 2 paths, factor-8 neglect) is deferred to Phase 3, where buildings
//! introduce the multi-obstacle geometry that carries the per-edge side/offset
//! it needs. For a single finite wall the two supplied end edges already ARE
//! the best left/right paths, so summing them is correct today; the caller
//! currently supplies at most a single wall's ends.

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

    for (band_idx, &f_centre) in system.centres().iter().enumerate() {
        let lambda = 340.0 / f_centre;
        // Over-top path — capped (§5.3).
        let dz_top = diffraction::cap(
            diffraction::dz_uncapped(lengths, lambda, variant),
            lengths.e_total,
            dz_cap_db,
        );

        // §7.4.4 Eq 25 — energy-sum the over-top path with each around-the-end
        // (lateral) path into one effective Dz:
        //   Dz_eff = −10·log10( 10^(−Dz_top/10) + Σ 10^(−Dz_lat/10) ).
        // More paths ⇒ more sound ⇒ less attenuation. A fully open end
        // (Dz_lat = 0 → term = 1) drives Dz_eff ≤ 0, i.e. the wall is bypassed.
        // Lateral paths are NOT capped (§5.3).
        let dz_eff = if lat_lengths.is_empty() {
            dz_top
        } else {
            let neg_inv_ten = -LN10 / 10.0;
            let mut sum = (dz_top * neg_inv_ten).exp();
            for ll in lat_lengths {
                let dz_lat = diffraction::dz_uncapped(ll, lambda, variant);
                sum += (dz_lat * neg_inv_ten).exp();
            }
            let combined = -10.0 * sum.log10();
            if combined < 0.0 { 0.0 } else { combined }
        };

        // Literal ISO (Eqs 16/17, TR §5.5): subtract Agr only when it is a
        // genuine ground attenuation (Agr > 0) and the barrier screens
        // (Dz > 0); never subtract a negative Agr (a boost). Agr is added back
        // by the caller, so the over-top net is Dz.
        let agr_band = agr.bands[band_idx];
        abar.bands[band_idx] = if agr_band > 0.0 && dz_eff > 0.0 {
            (dz_eff - agr_band).max(0.0)
        } else {
            dz_eff
        };
    }

    abar
}

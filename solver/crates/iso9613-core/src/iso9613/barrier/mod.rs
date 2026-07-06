//! ISO 9613-2:2024 — 7.4 Screening, Abar.
//!
//! Over-top diffraction (7.4.1) for straight wall barriers, including the
//! multi-edge rubber-band path, plus lateral diffraction around vertical wall
//! ends (7.4.3) combined per Eq 25 (7.4.4).
//!
//! ⚠ KNOWN DEVIATIONS vs ISO/TR 17534-3 (fixed in Phase 1 — see
//! `docs/iso9613-solver-phase01-execution.md` §2.3): the 20/25 dB cap is
//! applied to lateral paths too (TR §5.3: over-top only), and ALL lateral
//! edges are energy-summed (TR §5.2: best path per side, ≤ 2, with the
//! factor-8 neglect rule).

pub mod diffraction;
pub mod path;

use crate::spectrum::{BandSpectrum, BandSystem};

pub use path::{BarrierGeometry, LateralEdge, WallBarrier};

/// Natural log of 10, for the dB↔energy conversions in the §7.4.4 combination.
const LN10: f64 = std::f64::consts::LN_10;

/// Convention for combining barrier diffraction Dz with ground attenuation
/// Agr in `abar_spectrum`.
///
/// ⚠ Phase-1 note: these two conventions are NOT numerically equivalent when
/// `Agr > 0` — `IsoEq16` drops `Agr` from the total (net `Dz − Agr`), while
/// `DzMinusMaxAgr0` keeps it (net `Dz`). The literal reading of the standard
/// (Eq 5 always includes `Agr`; Eq 16 defines `Abar = Dz − Agr ≥ 0`) is the
/// `DzMinusMaxAgr0` behaviour, which is also BEESTY's default. Phase 1
/// collapses to that single behaviour and removes this enum.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
#[derive(Default)]
pub enum BarrierConvention {
    /// `Abar = max(0, Dz − Agr)` with `Agr` then NOT added separately.
    #[default]
    IsoEq16,
    /// `Abar = Dz − max(Agr, 0)`, `Agr` always added separately.
    DzMinusMaxAgr0,
}


/// `Abar` per band combining `Dz` with `Agr` per the chosen convention.
///
/// `agr` is the ground attenuation computed *as if no barrier were present*.
///
/// Returns:
///   - `abar` per band (dB attenuation; clamped at ≥ 0)
///   - `ground_already_in_bar`: per band, true if the band's `Abar` absorbs
///     `Agr` (Agr > 0 case under IsoEq16 convention). Caller must skip adding
///     Agr separately in the total attenuation when this flag is set. Always
///     false under DzMinusMaxAgr0.
///
/// `dz_cap_db` overrides the standard 20 / 25 dB cap (used by Annex D for
/// the WT terrain-screening case — typically 3 dB).
pub fn abar_spectrum(
    geometry: Option<&path::BarrierGeometry>,
    agr: &BandSpectrum,
    system: BandSystem,
    dz_cap_db: Option<f64>,
    convention: BarrierConvention,
) -> (BandSpectrum, Vec<bool>) {
    let mut abar = BandSpectrum::zeros(system);
    let mut ground_in_bar = vec![false; system.n_bands()];

    // No over-top shielding — Abar = 0 across all bands. (Lateral diffraction
    // only ADDS open paths around a wall that IS screening, so there's nothing
    // to combine when the line of sight clears the top.)
    let geometry = match geometry {
        Some(g) => g,
        None => return (abar, ground_in_bar),
    };
    let lengths = &geometry.over_top;
    let lat_lengths = &geometry.lateral;

    for (band_idx, &f_centre) in system.centres().iter().enumerate() {
        let lambda = 340.0 / f_centre;
        let dz_top = diffraction::cap(
            diffraction::dz_uncapped(lengths, lambda),
            lengths.e_total,
            dz_cap_db,
        );

        // §7.4.4 Eq 25 — energy-sum the diffracted contributions of the over-top
        // path and each around-the-end (lateral) path into one effective Dz:
        //   Dz_eff = −10·log10( 10^(−Dz_top/10) + Σ 10^(−Dz_lat/10) ).
        // More paths ⇒ more sound ⇒ less attenuation. A fully open end
        // (Dz_lat = 0 → term = 1) drives Dz_eff ≤ 0, i.e. the wall is bypassed.
        let dz_eff = if lat_lengths.is_empty() {
            dz_top
        } else {
            let neg_inv_ten = -LN10 / 10.0;
            let mut sum = (dz_top * neg_inv_ten).exp();
            for ll in lat_lengths {
                let dz_lat = diffraction::cap(
                    diffraction::dz_uncapped(ll, lambda),
                    ll.e_total,
                    dz_cap_db,
                );
                sum += (dz_lat * neg_inv_ten).exp();
            }
            let combined = -10.0 * sum.log10();
            if combined < 0.0 { 0.0 } else { combined }
        };

        let agr_band = agr.bands[band_idx];

        let (abar_band, in_bar) = match convention {
            BarrierConvention::IsoEq16 => {
                // Eq 16 (Agr > 0): Abar = Dz - Agr; Agr is then NOT added separately.
                // Eq 17 (Agr ≤ 0): Abar = Dz;       Agr IS added separately in Eq 5.
                if agr_band > 0.0 && dz_eff > 0.0 {
                    let val = dz_eff - agr_band;
                    // Clamp to 0 — Eq 16 specifies Abar ≥ 0.
                    if val < 0.0 { (0.0, true) } else { (val, true) }
                } else {
                    (dz_eff, false)
                }
            }
            BarrierConvention::DzMinusMaxAgr0 => {
                // Abar = Dz − max(Agr, 0). Agr is always added separately
                // (`in_bar = false`). When Agr ≤ 0 the max clamps to 0
                // and we return Dz unchanged; when Agr > 0 we subtract.
                if agr_band > 0.0 && dz_eff > 0.0 {
                    let val = dz_eff - agr_band;
                    if val < 0.0 { (0.0, false) } else { (val, false) }
                } else {
                    (dz_eff, false)
                }
            }
        };

        abar.bands[band_idx] = abar_band;
        ground_in_bar[band_idx] = in_bar;
    }

    (abar, ground_in_bar)
}

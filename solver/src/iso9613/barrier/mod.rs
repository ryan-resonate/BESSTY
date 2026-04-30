//! ISO 9613-2:2024 — 7.4 Screening, Abar.
//!
//! v0.3 implements over-top diffraction (7.4.1) for straight wall barriers,
//! including the multi-edge rubber-band path. Lateral diffraction (7.4.3)
//! and the lateral/vertical combination (7.4.4 Eq 25) are deferred.

pub mod diffraction;
pub mod path;

use crate::dual::ADScalar;
use crate::spectrum::{BandSpectrum, BandSystem};
use crate::units::Vec3;

pub use path::WallBarrier;

/// Convention for combining barrier diffraction Dz with ground attenuation
/// Agr in `abar_spectrum`.
#[derive(Copy, Clone, Debug, PartialEq, Eq)]
pub enum BarrierConvention {
    /// Strict ISO 9613-2 §7.4 Eqs 16/17:
    ///   - When Agr > 0 AND Dz > 0: Abar = max(0, Dz − Agr); Agr is then
    ///     not added separately (it's "absorbed" into Abar).
    ///   - Else: Abar = Dz; Agr is added separately.
    /// Net result is identical to Eq 17 when Agr ≤ 0 (boost case): the
    /// boost stays AND the diffraction attenuation stacks.
    IsoEq16,
    /// Common-practice variant used by some commercial tools:
    ///   - Abar = Dz − max(Agr, 0).
    /// When Agr is negative (boost case) max(Agr, 0) = 0 so Abar = Dz
    /// (same as ISO Eq 17). When Agr > 0 the sign matches ISO Eq 16.
    /// The numerical difference vs ISO is zero in both Agr≤0 and Agr>0
    /// cases, but the bookkeeping is simpler — Agr is always added
    /// separately and never absorbed into Abar.
    DzMinusMaxAgr0,
}

impl Default for BarrierConvention {
    fn default() -> Self { Self::IsoEq16 }
}

/// `Abar` per band combining `Dz` with `Agr` per the chosen convention.
///
/// `agr` is the ground attenuation computed *as if no barrier were present*.
///
/// Returns:
///   - `abar` per band (dB attenuation; clamped at ≥ 0)
///   - `ground_already_in_bar`: per band, true if the band's `Abar` absorbs
///     `Agr` (ISO Eq 16: Agr > 0 case under IsoEq16 convention). Caller
///     must skip adding Agr separately in the total attenuation when this
///     flag is set. Always false under DzMinusMaxAgr0.
///
/// `dz_cap_db` overrides the standard 20 / 25 dB cap (used by Annex D for
/// the WT terrain-screening case — typically 3 dB).
pub fn abar_spectrum<T: ADScalar>(
    source_pos: Vec3<T>,
    receiver_pos: Vec3<T>,
    barriers: &[WallBarrier<T>],
    agr: &BandSpectrum<T>,
    system: BandSystem,
    dz_cap_db: Option<f64>,
    convention: BarrierConvention,
) -> (BandSpectrum<T>, Vec<bool>) {
    let mut abar = BandSpectrum::zeros(system);
    let mut ground_in_bar = vec![false; system.n_bands()];

    let candidates = path::project_walls(source_pos, receiver_pos, barriers);
    let s_in_plane = path::DiffractionEdge { x: T::zero(), z: source_pos.z };
    let dx = receiver_pos.e - source_pos.e;
    let dy = receiver_pos.n - source_pos.n;
    let dp = (dx * dx + dy * dy).sqrt();
    let r_in_plane = path::DiffractionEdge { x: dp, z: receiver_pos.z };

    let active = path::upper_hull_select(s_in_plane, r_in_plane, &candidates);
    if active.is_empty() {
        // No effective shielding — Abar = 0 across all bands.
        return (abar, ground_in_bar);
    }

    let lengths = path::path_lengths(s_in_plane, r_in_plane, &active);

    for (band_idx, &f_centre) in system.centres().iter().enumerate() {
        let lambda = 340.0 / f_centre;
        let dz_raw = diffraction::dz_uncapped(&lengths, lambda);
        let dz_capped = diffraction::cap(dz_raw, lengths.e_total, dz_cap_db);

        let agr_band = agr.bands[band_idx];
        let agr_v = agr_band.to_f64();
        let dz_v = dz_capped.to_f64();

        let (abar_band, in_bar) = match convention {
            BarrierConvention::IsoEq16 => {
                // Eq 16 (Agr > 0): Abar = Dz - Agr; Agr is then NOT added separately.
                // Eq 17 (Agr ≤ 0): Abar = Dz;       Agr IS added separately in Eq 5.
                if agr_v > 0.0 && dz_v > 0.0 {
                    let val = dz_capped - agr_band;
                    // Clamp to 0 — Eq 16 specifies Abar ≥ 0.
                    if val.to_f64() < 0.0 { (T::zero(), true) } else { (val, true) }
                } else {
                    (dz_capped, false)
                }
            }
            BarrierConvention::DzMinusMaxAgr0 => {
                // Abar = Dz − max(Agr, 0). Agr is always added separately
                // (`in_bar = false`). When Agr ≤ 0 the max clamps to 0
                // and we return Dz unchanged; when Agr > 0 we subtract.
                if agr_v > 0.0 && dz_v > 0.0 {
                    let val = dz_capped - agr_band;
                    if val.to_f64() < 0.0 { (T::zero(), false) } else { (val, false) }
                } else {
                    (dz_capped, false)
                }
            }
        };

        abar.bands[band_idx] = abar_band;
        ground_in_bar[band_idx] = in_bar;
    }

    (abar, ground_in_bar)
}

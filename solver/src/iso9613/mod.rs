//! ISO 9613-2:2024 implementation modules.
//!
//! v0.3 status: Adiv (7.1), Aatm (7.2), Agr (7.3.1 General), Abar (7.4.1
//! over-top, single + multi edge). Subsequent commits add:
//! - annex_d/   wind turbine specifics
//! - reflection/ image-source method (engine only — no UI hook in v1)
//!
//! See `docs/solver-design.md` for the full kernel-by-kernel mapping.

pub mod annex_d;
pub mod atmosphere;
pub mod barrier;
pub mod divergence;
pub mod ground;

use crate::dual::ADScalar;
use crate::spectrum::BandSpectrum;
use crate::units::Vec3;

/// Free-field source-to-receiver SPL with no ground, no barrier, no
/// reflection, no Annex D.
///
/// `Lp = LW − Adiv − Aatm`, computed per band of the active system.
pub fn evaluate_free_field<T: ADScalar>(
    lw: &BandSpectrum<T>,
    source_pos: Vec3<T>,
    receiver_pos: Vec3<T>,
) -> BandSpectrum<T> {
    let system = lw.system;
    let adiv = divergence::adiv(source_pos, receiver_pos);
    let aatm = atmosphere::aatm_spectrum(source_pos, receiver_pos, system);

    let mut out = BandSpectrum::zeros(system);
    for i in 0..system.n_bands() {
        out.bands[i] = lw.bands[i] - adiv - aatm.bands[i];
    }
    out
}

/// Source-to-receiver SPL with ground attenuation (General method, no
/// barriers, no reflections, no Annex D).
///
/// `Lp = LW − Adiv − Aatm − Agr`. v0.2 takes uniform G across all three
/// ground regions; future versions accept per-region G derived from terrain
/// classification.
pub fn evaluate_with_ground<T: ADScalar>(
    lw: &BandSpectrum<T>,
    source_pos: Vec3<T>,
    receiver_pos: Vec3<T>,
    g: T,
) -> BandSpectrum<T> {
    let system = lw.system;
    let adiv = divergence::adiv(source_pos, receiver_pos);
    let aatm = atmosphere::aatm_spectrum(source_pos, receiver_pos, system);
    let agr = ground::agr_spectrum(source_pos, receiver_pos, g, g, g, system);

    let mut out = BandSpectrum::zeros(system);
    for i in 0..system.n_bands() {
        out.bands[i] = lw.bands[i] - adiv - aatm.bands[i] - agr.bands[i];
    }
    out
}

/// Source-to-receiver SPL with ground attenuation and barriers.
///
/// `Lp = LW − Adiv − Aatm − Agr − Abar`. Per Eqs 16/17 the per-band Abar
/// either replaces (Eq 16, when Agr > 0 over-top) or stacks with (Eq 17)
/// the ground attenuation.
pub fn evaluate_with_barriers<T: ADScalar>(
    lw: &BandSpectrum<T>,
    source_pos: Vec3<T>,
    receiver_pos: Vec3<T>,
    g: T,
    barriers: &[barrier::WallBarrier<T>],
    dz_cap_db: Option<f64>,
) -> BandSpectrum<T> {
    let system = lw.system;
    let adiv = divergence::adiv(source_pos, receiver_pos);
    let aatm = atmosphere::aatm_spectrum(source_pos, receiver_pos, system);
    let agr = ground::agr_spectrum(source_pos, receiver_pos, g, g, g, system);
    let (abar, ground_in_bar) =
        barrier::abar_spectrum(source_pos, receiver_pos, barriers, &agr, system, dz_cap_db);

    let mut out = BandSpectrum::zeros(system);
    for i in 0..system.n_bands() {
        let agr_term = if ground_in_bar[i] { T::zero() } else { agr.bands[i] };
        out.bands[i] = lw.bands[i] - adiv - aatm.bands[i] - agr_term - abar.bands[i];
    }
    out
}

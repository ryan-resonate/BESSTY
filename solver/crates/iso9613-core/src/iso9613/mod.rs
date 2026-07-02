//! ISO 9613-2 implementation modules (currently the 2024 edition chain; the
//! path-engine / StandardModel / EditionSpec split lands in Phase 1, the 1996
//! edition in Phase 2 — see `docs/iso9613-solver-standalone-plan.md`).

pub mod annex_d;
pub mod atmosphere;
pub mod barrier;
pub mod divergence;
pub mod ground;
pub mod meteorology;

pub use atmosphere::Atmosphere;
pub use barrier::BarrierConvention;

use crate::spectrum::BandSpectrum;
use crate::units::Vec3;

/// Free-field source-to-receiver SPL with no ground, no barrier, no
/// reflection, no Annex D.
///
/// `Lp = LW − Adiv − Aatm`, computed per band of the active system.
pub fn evaluate_free_field(
    lw: &BandSpectrum,
    source_pos: Vec3,
    receiver_pos: Vec3,
    atm: Atmosphere,
) -> BandSpectrum {
    let system = lw.system;
    let adiv = divergence::adiv(source_pos, receiver_pos);
    let aatm = atmosphere::aatm_spectrum(source_pos, receiver_pos, system, atm);

    let mut out = BandSpectrum::zeros(system);
    for i in 0..system.n_bands() {
        out.bands[i] = lw.bands[i] - adiv - aatm.bands[i];
    }
    out
}

/// Source-to-receiver SPL with ground attenuation (General method, no
/// barriers, no reflections, no Annex D).
///
/// `Lp = LW − Adiv − Aatm − Agr`. Takes uniform G across all three ground
/// regions; per-region G arrives with ground regions (Phase 3).
pub fn evaluate_with_ground(
    lw: &BandSpectrum,
    source_pos: Vec3,
    receiver_pos: Vec3,
    h_s: f64,
    h_r: f64,
    g: f64,
    atm: Atmosphere,
) -> BandSpectrum {
    let system = lw.system;
    let adiv = divergence::adiv(source_pos, receiver_pos);
    let aatm = atmosphere::aatm_spectrum(source_pos, receiver_pos, system, atm);
    let agr = ground::agr_spectrum(source_pos, receiver_pos, h_s, h_r, g, g, g, system);

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
///
/// `source_pos`/`receiver_pos` are in an absolute datum (shared with the
/// barrier top heights, so over-top diffraction geometry is correct over real
/// terrain); `h_s`/`h_r` are the heights above local ground for the ground
/// attenuation. See `ground::agr_spectrum`.
#[allow(clippy::too_many_arguments, clippy::needless_range_loop)]
pub fn evaluate_with_barriers(
    lw: &BandSpectrum,
    source_pos: Vec3,
    receiver_pos: Vec3,
    h_s: f64,
    h_r: f64,
    g: f64,
    barriers: &[barrier::WallBarrier],
    lateral: &[barrier::LateralEdge],
    dz_cap_db: Option<f64>,
    atm: Atmosphere,
    barrier_conv: BarrierConvention,
) -> BandSpectrum {
    let system = lw.system;
    let adiv = divergence::adiv(source_pos, receiver_pos);
    let aatm = atmosphere::aatm_spectrum(source_pos, receiver_pos, system, atm);
    let agr = ground::agr_spectrum(source_pos, receiver_pos, h_s, h_r, g, g, g, system);
    let (abar, ground_in_bar) = barrier::abar_spectrum(
        source_pos, receiver_pos, barriers, lateral, &agr, system, dz_cap_db, barrier_conv,
    );

    let mut out = BandSpectrum::zeros(system);
    for i in 0..system.n_bands() {
        let agr_term = if ground_in_bar[i] { 0.0 } else { agr.bands[i] };
        out.bands[i] = lw.bands[i] - adiv - aatm.bands[i] - agr_term - abar.bands[i];
    }
    out
}

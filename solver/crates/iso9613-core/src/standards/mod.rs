//! Standard/edition model — the two extensibility seams (plan §3.5).
//!
//! - [`EditionSpec`] — **data** describing how a given edition/revision within
//!   the ISO 9613-2 family differs from another: one field per edition-varying
//!   term. It grows additively as more terms become edition-aware, and each
//!   edition constant is **frozen** once validated (a change that would alter a
//!   validated edition's numbers becomes a *new* variant, never an edit).
//! - [`StandardModel`] — **dispatch**: given a spec, score a source→receiver
//!   path. The evaluation logic lives ONCE in the trait's default method,
//!   parameterised by `self.spec()`; each edition is a unit struct supplying
//!   its constant. This is also the seam a future different-model-family
//!   evaluator would implement over the same geometry.
//!
//! ISO 9613-2 **:1996** ([`Iso1996`]/[`ISO_1996`]) and **:2024**
//! ([`Iso2024`]/[`ISO_2024`]) are wired. No future-standard names appear here.

use crate::iso9613::atmosphere::{self, Atmosphere};
use crate::iso9613::barrier::path::{DiffractionEdge, FootprintLateral};
use crate::iso9613::barrier::{self, BarrierVariant, LateralEdge, WallBarrier};
use crate::iso9613::divergence;
use crate::iso9613::ground::{self, GroundCombination, GroundMethod};
use crate::spectrum::BandSpectrum;
use crate::units::Vec3;

/// The per-term variant choices that distinguish one ISO 9613-2 edition from
/// another (see `docs/iso9613-2-1996-vs-2024-differences.md` §0). One field per
/// place the editions diverge; extended additively (`Aatm` source, subdivision,
/// reflection loss in later phases).
#[derive(Copy, Clone, Debug)]
pub struct EditionSpec {
    /// How `AS + AR + Am` combine into `Agr` — General method (differences §6).
    pub ground: GroundCombination,
    /// Barrier `Dz` bracket + `Kmet` form (differences §8.1–8.2).
    pub barrier: BarrierVariant,
}

/// ISO 9613-2:1996 (as clarified by ISO/TR 17534-3 §5).
pub const ISO_1996: EditionSpec = EditionSpec {
    ground: GroundCombination::Sum,
    barrier: BarrierVariant::V1996,
};

/// ISO 9613-2:2024.
pub const ISO_2024: EditionSpec = EditionSpec {
    ground: GroundCombination::KgeoWrap,
    barrier: BarrierVariant::V2024,
};

/// Inputs for a general point-source → receiver evaluation. Bundled so the
/// evaluator signature stays small and additive.
pub struct GeneralEval<'a> {
    pub lw: &'a BandSpectrum,
    /// Absolute source position (e, n, z) — the geometry datum shared with the
    /// barrier tops.
    pub source: Vec3,
    /// Absolute receiver position (e, n, z).
    pub receiver: Vec3,
    /// Source height above local ground (for `Agr`).
    pub h_s: f64,
    /// Receiver height above local ground (for `Agr`).
    pub h_r: f64,
    /// Ground factors for the source / middle / receiver regions (§7.3.1).
    /// Uniform ground passes the same value for all three; per-region ground
    /// (the caller derives these from ground‑cover polygons) passes distinct
    /// values.
    pub g_source: f64,
    pub g_middle: f64,
    pub g_receiver: f64,
    pub barriers: &'a [WallBarrier],
    pub lateral: &'a [LateralEdge],
    /// Pre-sampled ground-profile diffraction edges (terrain screening).
    pub terrain_edges: &'a [DiffractionEdge],
    /// Building footprints for around-the-side (multi-corner) lateral wraps.
    pub footprints: &'a [FootprintLateral],
    pub dz_cap: Option<f64>,
    pub atm: Atmosphere,
    /// §7.3 method for the ground effect — a user setting, edition-independent.
    pub ground_method: GroundMethod,
}

/// A propagation standard: scores a source→receiver path per its `EditionSpec`.
pub trait StandardModel {
    fn spec(&self) -> &'static EditionSpec;

    /// `Lp = LW + D − Adiv − Aatm − Agr − Abar` for one general point source.
    /// The body is edition-agnostic — the only edition inputs come from
    /// `self.spec()`. `D` is the simplified-method source correction (0 for the
    /// General method).
    #[allow(clippy::needless_range_loop)]
    fn evaluate_general(&self, i: &GeneralEval) -> BandSpectrum {
        let system = i.lw.system;
        let spec = self.spec();
        let adiv = divergence::adiv(i.source, i.receiver);
        let aatm = atmosphere::aatm_spectrum(i.source, i.receiver, system, i.atm);

        // Ground effect + (simplified-method) source correction D.
        let (agr, d_corr) = match i.ground_method {
            GroundMethod::General => (
                ground::agr_spectrum(
                    i.source, i.receiver, i.h_s, i.h_r,
                    i.g_source, i.g_middle, i.g_receiver, system, spec.ground,
                ),
                0.0,
            ),
            GroundMethod::Simplified => {
                // §7.3.2 — a single frequency-independent Agr + the Eq 15 D term.
                // Flat-ground hm now; terrain-profile hm arrives in Phase 3.
                let d = i.receiver.sub(i.source).length();
                let dp = i.receiver.sub(i.source).length_horizontal();
                let hm = ground::simplified::hm_flat(i.h_s, i.h_r);
                let agr_val = ground::simplified::agr(hm, d);
                let agr = BandSpectrum::from_iter(
                    system,
                    std::iter::repeat_n(agr_val, system.n_bands()),
                );
                (agr, ground::simplified::d_correction(dp, i.h_s, i.h_r))
            }
        };

        // Geometry (path engine) is separate from scoring (this evaluator).
        let geometry = barrier::path::build_geometry(
            i.source, i.receiver, i.barriers, i.lateral, i.terrain_edges, i.footprints,
        );
        let abar = barrier::abar_spectrum(geometry.as_ref(), &agr, system, i.dz_cap, spec.barrier);

        // Agr is always carried separately (Eq 5); Abar already encodes the
        // literal ISO combination (see `barrier::abar_spectrum`).
        let mut out = BandSpectrum::zeros(system);
        for b in 0..system.n_bands() {
            out.bands[b] = i.lw.bands[b] + d_corr - adiv - aatm.bands[b] - agr.bands[b] - abar.bands[b];
        }
        out
    }
}

/// ISO 9613-2:1996 evaluator.
pub struct Iso1996;
impl StandardModel for Iso1996 {
    fn spec(&self) -> &'static EditionSpec {
        &ISO_1996
    }
}

/// ISO 9613-2:2024 evaluator.
pub struct Iso2024;
impl StandardModel for Iso2024 {
    fn spec(&self) -> &'static EditionSpec {
        &ISO_2024
    }
}

//! ISO 9613-2:2024 — Annex D, Wind turbine specifics (2024-only annex).
//!
//! Implements the WT-specific dispatch rules:
//!   - D.2: omnidirectional source at hub height (no Dc — caller's job).
//!   - D.3: barrier `Abar` capped at a project-set value (default 3 dB) and
//!     uses tip-height source for the barrier path-finding (caller wires
//!     this by passing source.z = hub + rotor_radius).
//!   - D.4: ground factor capped at G ≤ 0.5; receiver effective height ≥ 4 m.
//!   - D.5: concave-ground correction `ΔAgr = -3 dB` when `hm ≥ 1.5·(hS+hR)/2`.
//!     The caller computes `hm` from the DEM and supplies it as a flag.
//!
//! Long-term Cmet (D.6) is applied by the caller via `meteorology::cmet_db`.

use crate::spectrum::BandSpectrum;
use crate::units::Vec3;

use super::{atmosphere, barrier, divergence, ground};
use super::atmosphere::Atmosphere;

/// WT-specific configuration applied at every receiver.
#[derive(Copy, Clone, Debug)]
pub struct WtgRules {
    /// Project setting — default 3.0 per Annex D.3.
    pub barrier_dz_cap_db: f64,
    /// Project setting — default true (use tip-height for barrier source).
    /// When true, the barrier evaluator's source z is `hub_z + rotor_radius`
    /// (caller supplies via `source_pos.z`); when false, uses hub_z directly.
    pub use_elevated_source_for_barrier: bool,
    /// Project setting — default true. Apply ΔAgr = -3 dB when concave
    /// criterion is met (caller computes the criterion from DEM).
    pub apply_concave_correction: bool,
    /// Receiver height enforced for ground-attenuation calculations.
    /// Default 4.0 per Annex D.4.
    pub receiver_height_min_m: f64,
}

impl Default for WtgRules {
    fn default() -> Self {
        Self {
            barrier_dz_cap_db: 3.0,
            use_elevated_source_for_barrier: true,
            apply_concave_correction: true,
            receiver_height_min_m: 4.0,
        }
    }
}

/// Helper: cap G at 0.5 per Annex D.4.
pub fn cap_g_for_wtg(g: f64) -> f64 {
    if g > 0.5 { 0.5 } else { g }
}

/// Helper: clamp receiver height to the WT minimum.
pub fn enforce_receiver_height(z: f64, min_m: f64) -> f64 {
    if z < min_m { min_m } else { z }
}

/// Source position used for barrier path-finding. With elevated-source
/// enabled, returns hub_z + rotor_radius; otherwise returns hub_z.
pub fn effective_source_z_for_barrier(hub_z: f64, rotor_diameter_m: f64, use_elevated: bool) -> f64 {
    if use_elevated {
        hub_z + rotor_diameter_m * 0.5
    } else {
        hub_z
    }
}

/// Full WT evaluator. Applies Annex D.4 (G cap, receiver height clamp),
/// optional Annex D.5 (concave −3 dB), and Annex D.3 barrier handling
/// (3 dB cap by default, elevated source).
///
/// `apply_concave` is the caller's pre-computed result of the D.5 condition
/// (`hm ≥ 1.5·(hS+hR)/2`, computed from DEM along the propagation path).
#[allow(clippy::too_many_arguments, clippy::needless_range_loop)]
pub fn evaluate_wtg(
    lw: &BandSpectrum,
    hub_pos: Vec3,
    receiver_pos: Vec3,
    h_s: f64,
    h_r: f64,
    g: f64,
    barriers: &[barrier::WallBarrier],
    lateral: &[barrier::LateralEdge],
    rules: WtgRules,
    apply_concave: bool,
    rotor_diameter_m: f64,
    atm: Atmosphere,
) -> BandSpectrum {
    let system = lw.system;

    // `hub_pos`/`receiver_pos` are absolute (geometry); `h_s`/`h_r` are heights
    // above local ground (ground attenuation). See `evaluate_with_barriers`.
    // Annex D.4: clamp G ≤ 0.5 and the receiver HAG ≥ 4 m for the ground calc.
    let g_capped = cap_g_for_wtg(g);
    let h_r_ground = enforce_receiver_height(h_r, rules.receiver_height_min_m);

    // Adiv and Aatm use the absolute source/receiver geometry.
    let adiv = divergence::adiv(hub_pos, receiver_pos);
    let aatm = atmosphere::aatm_spectrum(hub_pos, receiver_pos, system, atm);

    // Agr uses the hub HAG and the clamped receiver HAG per D.4. Annex D is
    // 2024-only, so the 2024 ground combination is used.
    let mut agr = ground::agr_spectrum(
        hub_pos, receiver_pos, h_s, h_r_ground, g_capped, g_capped, g_capped, system,
        crate::standards::ISO_2024.ground,
    );

    // D.5 concave correction.
    if rules.apply_concave_correction && apply_concave {
        for band_idx in 0..system.n_bands() {
            agr.bands[band_idx] -= 3.0;
        }
    }

    // D.3 barrier handling: elevated-source z and dz cap.
    let barrier_source = Vec3 {
        e: hub_pos.e,
        n: hub_pos.n,
        z: effective_source_z_for_barrier(hub_pos.z, rotor_diameter_m, rules.use_elevated_source_for_barrier),
    };
    let geometry =
        barrier::path::build_geometry(barrier_source, receiver_pos, barriers, lateral, &[], &[], &[]);
    let abar = barrier::abar_spectrum(
        geometry.as_ref(),
        &agr,
        system,
        Some(rules.barrier_dz_cap_db),
        crate::standards::ISO_2024.barrier,
    );

    // Agr is always carried separately (Eq 5); Abar encodes the literal ISO
    // combination (see `barrier::abar_spectrum`).
    let mut out = BandSpectrum::zeros(system);
    for i in 0..system.n_bands() {
        out.bands[i] = lw.bands[i] - adiv - aatm.bands[i] - agr.bands[i] - abar.bands[i];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn g_cap_at_0_5() {
        assert_relative_eq!(cap_g_for_wtg(1.0), 0.5, epsilon = 1e-12);
        assert_relative_eq!(cap_g_for_wtg(0.7), 0.5, epsilon = 1e-12);
        assert_relative_eq!(cap_g_for_wtg(0.3), 0.3, epsilon = 1e-12);
    }

    #[test]
    fn receiver_height_clamp() {
        assert_relative_eq!(enforce_receiver_height(1.5, 4.0), 4.0, epsilon = 1e-12);
        assert_relative_eq!(enforce_receiver_height(6.0, 4.0), 6.0, epsilon = 1e-12);
    }

    #[test]
    fn elevated_source_uses_hub_plus_rotor_radius() {
        // hub at 100 m, rotor diameter 120 m → effective source z = 100 + 60 = 160.
        assert_relative_eq!(
            effective_source_z_for_barrier(100.0, 120.0, true),
            160.0,
            epsilon = 1e-12,
        );
        assert_relative_eq!(
            effective_source_z_for_barrier(100.0, 120.0, false),
            100.0,
            epsilon = 1e-12,
        );
    }
}

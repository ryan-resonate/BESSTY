//! ISO 9613-2:2024 — Annex D, Wind turbine specifics.
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
//! Long-term Cmet (D.6) is out of v1 scope.

use crate::dual::ADScalar;
use crate::spectrum::BandSpectrum;
use crate::units::Vec3;

use super::{atmosphere, barrier, divergence, ground};

/// WT-specific configuration applied at every receiver.
#[derive(Copy, Clone, Debug)]
pub struct WtgRules {
    /// Project setting — default 3.0 per Annex D.3.
    pub barrier_dz_cap_db: f64,
    /// Project setting — default true (use tip-height for barrier source).
    /// When true, the barrier evaluator's source z is `hub_z + rotor_radius`
    /// (caller supplies via `source_pos.z`); when false, uses hub_z directly.
    /// v0.4 reads this via the `effective_source_z_for_barrier` helper.
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
pub fn cap_g_for_wtg<T: ADScalar>(g: T) -> T {
    if g.to_f64() > 0.5 {
        T::from_f64(0.5)
    } else {
        g
    }
}

/// Helper: clamp receiver height to the WT minimum.
pub fn enforce_receiver_height<T: ADScalar>(z: T, min_m: f64) -> T {
    if z.to_f64() < min_m {
        T::from_f64(min_m)
    } else {
        z
    }
}

/// Source position used for barrier path-finding. With elevated-source
/// enabled, returns hub_z + rotor_radius; otherwise returns hub_z.
pub fn effective_source_z_for_barrier<T: ADScalar>(
    hub_z: T,
    rotor_diameter_m: f64,
    use_elevated: bool,
) -> T {
    if use_elevated {
        hub_z + T::from_f64(rotor_diameter_m * 0.5)
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
pub fn evaluate_wtg<T: ADScalar>(
    lw: &BandSpectrum<T>,
    hub_pos: Vec3<T>,
    receiver_pos: Vec3<T>,
    g: T,
    barriers: &[barrier::WallBarrier<T>],
    rules: WtgRules,
    apply_concave: bool,
    rotor_diameter_m: f64,
) -> BandSpectrum<T> {
    let system = lw.system;

    // Annex D.4: clamp G ≤ 0.5 and receiver height ≥ 4 m for ground calc.
    let g_capped = cap_g_for_wtg(g);
    let r_for_ground = Vec3 {
        e: receiver_pos.e,
        n: receiver_pos.n,
        z: enforce_receiver_height(receiver_pos.z, rules.receiver_height_min_m),
    };

    // Adiv and Aatm use the actual receiver height (not the clamped one) so
    // that source-to-receiver geometry is consistent with the user-set point.
    let adiv = divergence::adiv(hub_pos, receiver_pos);
    let aatm = atmosphere::aatm_spectrum(hub_pos, receiver_pos, system);

    // Agr uses the clamped receiver height per D.4.
    let mut agr = ground::agr_spectrum(hub_pos, r_for_ground, g_capped, g_capped, g_capped, system);

    // D.5 concave correction.
    if rules.apply_concave_correction && apply_concave {
        for band_idx in 0..system.n_bands() {
            agr.bands[band_idx] = agr.bands[band_idx] - T::from_f64(3.0);
        }
    }

    // D.3 barrier handling: elevated-source z and dz cap.
    let barrier_source = Vec3 {
        e: hub_pos.e,
        n: hub_pos.n,
        z: effective_source_z_for_barrier(hub_pos.z, rotor_diameter_m, rules.use_elevated_source_for_barrier),
    };
    let (abar, ground_in_bar) = barrier::abar_spectrum(
        barrier_source,
        receiver_pos,
        barriers,
        &agr,
        system,
        Some(rules.barrier_dz_cap_db),
    );

    let mut out = BandSpectrum::zeros(system);
    for i in 0..system.n_bands() {
        let agr_term = if ground_in_bar[i] { T::zero() } else { agr.bands[i] };
        out.bands[i] = lw.bands[i] - adiv - aatm.bands[i] - agr_term - abar.bands[i];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use approx::assert_relative_eq;

    #[test]
    fn g_cap_at_0_5() {
        assert_relative_eq!(cap_g_for_wtg(1.0_f64), 0.5, epsilon = 1e-12);
        assert_relative_eq!(cap_g_for_wtg(0.7_f64), 0.5, epsilon = 1e-12);
        assert_relative_eq!(cap_g_for_wtg(0.3_f64), 0.3, epsilon = 1e-12);
    }

    #[test]
    fn receiver_height_clamp() {
        assert_relative_eq!(enforce_receiver_height(1.5_f64, 4.0), 4.0, epsilon = 1e-12);
        assert_relative_eq!(enforce_receiver_height(6.0_f64, 4.0), 6.0, epsilon = 1e-12);
    }

    #[test]
    fn elevated_source_uses_hub_plus_rotor_radius() {
        // hub at 100 m, rotor diameter 120 m → effective source z = 100 + 60 = 160.
        assert_relative_eq!(
            effective_source_z_for_barrier(100.0_f64, 120.0, true),
            160.0,
            epsilon = 1e-12,
        );
        assert_relative_eq!(
            effective_source_z_for_barrier(100.0_f64, 120.0, false),
            100.0,
            epsilon = 1e-12,
        );
    }
}

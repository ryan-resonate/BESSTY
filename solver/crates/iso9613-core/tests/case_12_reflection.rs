//! Validation case 12 — first-order specular reflection (§7.5).
//!
//! Source and receiver both stand off a large hard vertical facade; the facade
//! adds an image-source path that energy-sums with the direct one. Geometry is
//! chosen tall/wide enough that the Fresnel size gate passes every band, so the
//! reflection contribution is fully checkable. Totals independently computed
//! (scratchpad oracle).

use approx::assert_relative_eq;
use iso9613_core::scene::{
    solve, Amisc, Atmosphere, Ground, Receiver, Reflector, Scene, Settings, Source, SourceKind,
    Standard, SCHEMA_VERSION,
};

fn scene_with(reflectors: Vec<Reflector>) -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere::default(),
        ground: Ground { default_g: 0.0, regions: vec![] }, // hard ground
        terrain: None,
        sources: vec![Source {
            id: "s".into(), kind: SourceKind::General,
            position: [30.0, 20.0, 30.0], height_agl: 30.0, lw: vec![100.0; 10],
        }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "r".into(), position: [70.0, 20.0, 30.0], height_agl: 30.0 }],
        obstacles: vec![],
        reflectors,
        amisc: Amisc::default(),
        settings: Settings::default(),
    }
}

/// A large hard facade along y = 0 (α = 0.1).
fn facade() -> Reflector {
    Reflector { segment: [[-100.0, 0.0], [200.0, 0.0]], base_z: 0.0, top_z: 200.0, alpha: 0.1, alpha_bands: None }
}

#[test]
fn first_order_reflection_adds_a_coherent_image_path() {
    let direct = solve(&scene_with(vec![])).unwrap().per_receiver[0].total_dba.unwrap();
    let with = solve(&scene_with(vec![facade()])).unwrap();
    let t_with = with.per_receiver[0].total_dba.unwrap();

    // Independently computed (oracle): direct 64.13, with reflection 65.81 dB(A).
    assert_relative_eq!(direct, 64.13, epsilon = 0.2);
    assert_relative_eq!(t_with, 65.81, epsilon = 0.2);

    // Per-band (oracle) — pins the image-source path + α loss + energy sum.
    let expected = [59.90, 59.90, 59.89, 59.88, 59.85, 59.81, 59.73, 59.46, 58.40, 54.60];
    let bands = &with.per_receiver[0].per_source[0].bands;
    for (i, exp) in expected.iter().enumerate() {
        assert_relative_eq!(bands[i], *exp, epsilon = 0.15);
    }
}

#[test]
fn facade_that_the_specular_point_misses_adds_nothing() {
    // A tiny facade far from the specular point (x=50) → no reflection.
    let tiny = Reflector { segment: [[-100.0, 0.0], [-90.0, 0.0]], base_z: 0.0, top_z: 200.0, alpha: 0.1, alpha_bands: None };
    let direct = solve(&scene_with(vec![])).unwrap().per_receiver[0].total_dba.unwrap();
    let with = solve(&scene_with(vec![tiny])).unwrap().per_receiver[0].total_dba.unwrap();
    assert_relative_eq!(direct, with, epsilon = 1e-9);
}

#[test]
fn perfectly_absorbing_facade_adds_nothing() {
    // α = 1 → 10·lg(0) = −∞ loss → the image contributes no energy.
    let absorbing = Reflector { segment: [[-100.0, 0.0], [200.0, 0.0]], base_z: 0.0, top_z: 200.0, alpha: 1.0, alpha_bands: None };
    let direct = solve(&scene_with(vec![])).unwrap().per_receiver[0].total_dba.unwrap();
    let with = solve(&scene_with(vec![absorbing])).unwrap().per_receiver[0].total_dba.unwrap();
    assert_relative_eq!(direct, with, epsilon = 1e-6);
}

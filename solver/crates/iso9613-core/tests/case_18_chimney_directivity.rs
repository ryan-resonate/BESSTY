//! Validation case 18 — ISO 9613-2:2024 Annex B chimney-stack directivity.
//!
//! A `ChimneyStack` source must apply the Table B.1 directivity `Dc` (added to
//! `LW`, Eq 3) for the curved-ray direction to the receiver — and nothing else.
//! So per band the chimney level minus an otherwise-identical omnidirectional
//! source equals exactly `Dc(ϑ, ka)`.

use approx::assert_relative_eq;
use iso9613_core::iso9613::annex_b;
use iso9613_core::scene::{
    solve, Atmosphere, Ground, Receiver, Scene, Settings, Source, SourceKind, Standard,
    SCHEMA_VERSION,
};
use iso9613_core::{BandSystem, Vec3};

fn scene(kind: SourceKind) -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere::default(), // 10 °C
        ground: Ground { default_g: 0.5, regions: vec![] },
        terrain: None,
        sources: vec![Source {
            id: "stack".into(), kind,
            position: [0.0, 0.0, 50.0], height_agl: 50.0, lw: vec![100.0; 10],
        }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "r".into(), position: [100.0, 0.0, 1.5], height_agl: 1.5 }],
        obstacles: vec![],
        reflectors: vec![],
        cylinders: vec![],
        amisc: Default::default(),
        settings: Settings::default(),
    }
}

#[test]
fn chimney_applies_annex_b_directivity_per_band() {
    let omni = solve(&scene(SourceKind::General)).unwrap();
    let stack = solve(&scene(SourceKind::ChimneyStack { opening_radius_m: 1.0 })).unwrap();

    // Reproduce the expected Dc independently from the Annex B geometry.
    let (s, r) = (Vec3::new(0.0, 0.0, 50.0), Vec3::new(100.0, 0.0, 1.5));
    let dp = ((r.e - s.e).powi(2) + (r.n - s.n).powi(2)).sqrt();
    let theta = annex_b::emission_angle(dp, r.sub(s).length(), s.z, r.z);

    let ob = &omni.per_receiver[0].per_source[0].bands;
    let sb = &stack.per_receiver[0].per_source[0].bands;
    for (b, &f) in BandSystem::Octave.centres_exact().iter().enumerate() {
        let dc = annex_b::chimney_dc(theta, annex_b::ka(1.0, f, 10.0));
        assert_relative_eq!(sb[b] - ob[b], dc, epsilon = 1e-9);
    }
    // This receiver is below the stack (ϑ ≈ 115°) → net attenuation vs omni.
    assert!(theta > 105.0, "ϑ = {theta}");
    assert!(
        stack.per_receiver[0].total_dba.unwrap() < omni.per_receiver[0].total_dba.unwrap(),
        "downward-facing chimney is quieter than omni here"
    );
}

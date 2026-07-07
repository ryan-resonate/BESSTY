//! Validation case 11 — per-region ground factor G (§7.3.1, Eq 10).
//!
//! A source→receiver path crossing a hard→porous boundary must classify its
//! source / middle / receiver regions independently. Here S(0,0,2) → R(200,0,2)
//! crosses from a hard zone (x < 100, G = 0) into a porous zone (x > 100,
//! G = 1). With hS = hR = 2 the source region is [0, 60] (all hard → GS = 0),
//! the receiver region [140, 200] (all porous → GR = 1) and the middle [60,140]
//! straddles the boundary → GM = 0.5. Per-band Lp independently computed
//! (scratchpad oracle.py with those three factors).

use approx::assert_relative_eq;
use iso9613_core::scene::{
    solve, Amisc, Atmosphere, Ground, GroundRegion, Receiver, Scene, Settings, Source, SourceKind,
    Standard, SCHEMA_VERSION,
};

fn two_zone_scene() -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere::default(),
        ground: Ground {
            default_g: 0.5, // fallback outside both zones (unused on this path)
            regions: vec![
                GroundRegion { polygon: vec![[-50.0, -50.0], [100.0, -50.0], [100.0, 50.0], [-50.0, 50.0]], g: 0.0 },
                GroundRegion { polygon: vec![[100.0, -50.0], [250.0, -50.0], [250.0, 50.0], [100.0, 50.0]], g: 1.0 },
            ],
        },
        terrain: None,
        sources: vec![Source {
            id: "s".into(), kind: SourceKind::General,
            position: [0.0, 0.0, 2.0], height_agl: 2.0, lw: vec![100.0; 10],
        }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "r".into(), position: [200.0, 0.0, 2.0], height_agl: 2.0 }],
        obstacles: vec![],
        reflectors: vec![],
        amisc: Amisc::default(),
        settings: Settings::default(),
    }
}

#[test]
fn per_region_ground_matches_oracle() {
    let res = solve(&two_zone_scene()).unwrap();
    let bands = &res.per_receiver[0].per_source[0].bands;
    let expected = [47.18, 47.17, 47.15, 43.58, 38.98, 42.51, 44.21, 43.14, 38.47, 21.40];
    for (i, exp) in expected.iter().enumerate() {
        assert_relative_eq!(bands[i], *exp, epsilon = 0.1);
    }
}

#[test]
fn empty_regions_fall_back_to_uniform_default_g() {
    // With no regions, the result must equal a uniform-G scene (here G = 0.5).
    let mut regions_scene = two_zone_scene();
    regions_scene.ground.regions.clear();
    let mut uniform = two_zone_scene();
    uniform.ground.regions.clear();
    uniform.ground.default_g = 0.5;

    let a = solve(&regions_scene).unwrap().per_receiver[0].total_dba.unwrap();
    let b = solve(&uniform).unwrap().per_receiver[0].total_dba.unwrap();
    assert_relative_eq!(a, b, epsilon = 1e-9);
}

#[test]
fn hard_ground_is_louder_than_porous() {
    // Sanity: an all-hard path (G=0, no ground dip) is louder than all-porous.
    let mut hard = two_zone_scene();
    hard.ground.regions.clear();
    hard.ground.default_g = 0.0;
    let mut porous = two_zone_scene();
    porous.ground.regions.clear();
    porous.ground.default_g = 1.0;

    let t_hard = solve(&hard).unwrap().per_receiver[0].total_dba.unwrap();
    let t_porous = solve(&porous).unwrap().per_receiver[0].total_dba.unwrap();
    assert!(t_hard > t_porous, "hard {t_hard} should exceed porous {t_porous}");
}

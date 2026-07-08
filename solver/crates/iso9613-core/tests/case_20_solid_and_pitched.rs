//! 3-D solids and pitched-roof buildings (`Obstacle::Solid` / `Obstacle::gable`).
//!
//! There is no ISO/TR reference for 3-D shapes, so these validate two ways:
//! 1. **Equivalence** — a flat box built as a `Solid` (roof edges + corner posts)
//!    must reproduce the TR-validated `Obstacle::Building` to the last bit, since
//!    both feed the same edges to the over-top and lateral-plane constructions.
//! 2. **Physical bracketing** — a gable roof (eaves `e`, ridge `r > e`) must sit
//!    between the two flat buildings at heights `e` and `r`: its ridge screens
//!    more than an `e`-high flat roof but less than an `r`-high one.

use iso9613_core::scene::{
    solve, Atmosphere, Ground, Obstacle, Receiver, Scene, Settings, Source, SourceKind, Standard,
    SCHEMA_VERSION,
};

fn lw_93() -> Vec<f64> {
    let mut lw = vec![-100.0; 10];
    for b in lw.iter_mut().skip(2) {
        *b = 93.0;
    }
    lw
}

fn scene_with(obstacle: Obstacle, s: [f64; 3], r: [f64; 3], g: f64) -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_1996,
        atmosphere: Atmosphere { temperature_c: 20.0, relative_humidity_pct: 70.0, pressure_kpa: 101.325 },
        ground: Ground { default_g: g, regions: vec![] },
        terrain: None,
        sources: vec![Source { id: "S".into(), kind: SourceKind::General, position: s, height_agl: s[2], lw: lw_93() }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "R".into(), position: r, height_agl: r[2] }],
        obstacles: vec![obstacle],
        reflectors: vec![],
        cylinders: vec![],
        amisc: Default::default(),
        settings: Settings::default(),
    }
}

fn total(scene: &Scene) -> f64 {
    solve(scene).unwrap().per_receiver[0].total_dba.unwrap()
}

/// A flat box modelled as a `Solid` (4 roof edges + 4 corner posts) must equal the
/// equivalent `Building` — validating the edge-based over-top + lateral machinery
/// against the TR-validated flat-building path.
#[test]
fn solid_box_equals_flat_building() {
    let s = [50.0, 10.0, 1.0];
    let r = [70.0, 10.0, 4.0];
    let building = Obstacle::Building {
        footprint: vec![[55.0, 5.0], [65.0, 5.0], [65.0, 15.0], [55.0, 15.0]],
        base_z: 0.0,
        height_agl: 10.0,
    };
    // The same box as an explicit wireframe: 4 top corners, 4 base corners.
    let solid = Obstacle::Solid {
        vertices: vec![
            [55.0, 5.0, 10.0], [65.0, 5.0, 10.0], [65.0, 15.0, 10.0], [55.0, 15.0, 10.0], // 0..3 roof
            [55.0, 5.0, 0.0], [65.0, 5.0, 0.0], [65.0, 15.0, 0.0], [55.0, 15.0, 0.0], // 4..7 base
        ],
        edges: vec![
            [0, 1], [1, 2], [2, 3], [3, 0], // roof edges
            [4, 0], [5, 1], [6, 2], [7, 3], // corner posts
        ],
    };

    let b = solve(&scene_with(building, s, r, 0.5)).unwrap().per_receiver[0].per_source[0].bands.clone();
    let sv = solve(&scene_with(solid, s, r, 0.5)).unwrap().per_receiver[0].per_source[0].bands.clone();
    for (bb, ss) in b.iter().zip(sv.iter()) {
        assert!((bb - ss).abs() < 1e-9, "solid box must equal flat building: {bb} vs {ss}");
    }
}

/// A gable roof (eaves 8 m, ridge 12 m) must attenuate MORE than an 8 m flat roof
/// (the ridge rises into the path) and LESS than a 12 m flat roof (the roof falls
/// away to the eaves) — i.e. its level is bracketed between the two.
#[test]
fn gable_roof_brackets_flat_roofs() {
    let s = [50.0, 10.0, 1.0];
    let r = [72.0, 10.0, 2.0];
    let rect = [[55.0, 4.0], [65.0, 4.0], [65.0, 16.0], [55.0, 16.0]];
    let flat = |h: f64| Obstacle::Building { footprint: rect.to_vec(), base_z: 0.0, height_agl: h };
    let gable = Obstacle::gable(rect, 0.0, 8.0, 12.0);

    let flat8 = total(&scene_with(flat(8.0), s, r, 0.5));
    let flat12 = total(&scene_with(flat(12.0), s, r, 0.5));
    let gab = total(&scene_with(gable, s, r, 0.5));
    // Higher roof → more screening → lower level. Gable sits between.
    assert!(flat12 < flat8, "12 m flat must screen more than 8 m flat: {flat12} < {flat8}");
    assert!(
        gab <= flat8 + 1e-6 && gab >= flat12 - 1e-6,
        "gable (eaves 8, ridge 12) must bracket between flat-8 ({flat8}) and flat-12 ({flat12}): {gab}"
    );
}

/// A gable with the ridge at the same height as the eaves is just a flat roof at
/// that height — the ridge edge is coplanar with the roof, adding no screening.
#[test]
fn degenerate_gable_equals_flat() {
    let s = [50.0, 10.0, 1.0];
    let r = [72.0, 10.0, 2.5];
    let rect = [[55.0, 4.0], [65.0, 4.0], [65.0, 16.0], [55.0, 16.0]];
    let flat = total(&scene_with(
        Obstacle::Building { footprint: rect.to_vec(), base_z: 0.0, height_agl: 9.0 },
        s, r, 0.4,
    ));
    let gable = total(&scene_with(Obstacle::gable(rect, 0.0, 9.0, 9.0), s, r, 0.4));
    assert!((flat - gable).abs() < 1e-6, "flat-ridge gable must equal a flat roof: {flat} vs {gable}");
}

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

/// A hip roof insets each ridge end by half the footprint WIDTH (the edge ⟂ to
/// the ridge), not the ridge-parallel length. For a 20 (long) × 10 (wide)
/// footprint the ridge must run (5,5)→(15,5) — length 10 — not collapse to a
/// near-pyramid as it did when the inset used |c0→c1|.
#[test]
fn hip_ridge_inset_uses_footprint_width() {
    let rect = [[0.0, 0.0], [20.0, 0.0], [20.0, 10.0], [0.0, 10.0]];
    let Obstacle::Solid { vertices, .. } = Obstacle::hip(rect, 0.0, 6.0, 9.0) else {
        panic!("hip must produce a Solid");
    };
    let (r0, r1) = (vertices[4], vertices[5]);
    assert!((r0[0] - 5.0).abs() < 1e-9 && (r0[1] - 5.0).abs() < 1e-9 && (r0[2] - 9.0).abs() < 1e-9, "ridge end 0: {r0:?}");
    assert!((r1[0] - 15.0).abs() < 1e-9 && (r1[1] - 5.0).abs() < 1e-9, "ridge end 1: {r1:?}");
    let ridge_len = ((r1[0] - r0[0]).powi(2) + (r1[1] - r0[1]).powi(2)).sqrt();
    assert!((ridge_len - 10.0).abs() < 1e-9, "hip ridge should be 10 m (width-inset), got {ridge_len}");
}

/// Rectangular footprint from two plan corners, in the same vertex order as
/// `box_solid`'s roof (so a Building and a box `Solid` share identical edges).
fn rect_from(lo: [f64; 2], hi: [f64; 2]) -> Vec<[f64; 2]> {
    vec![[lo[0], lo[1]], [hi[0], lo[1]], [hi[0], hi[1]], [lo[0], hi[1]]]
}

/// Two adjacent boxes between S and R must give the SAME result whether built as
/// `Solid`s or as `Building`s — and a mixed Solid+Building cluster must equal two
/// Buildings. This is the B1 fix: solids are now pooled into the shared cluster
/// lateral hull instead of each being wrapped in isolation (previously a taut
/// string could pass straight through an adjacent solid).
#[test]
fn solids_pool_into_the_cluster_like_buildings() {
    let s = [40.0, 10.0, 1.0];
    let r = [90.0, 10.0, 3.0];
    let (alo, ahi) = ([55.0, 4.0], [62.0, 16.0]);
    let (blo, bhi) = ([68.0, 4.0], [75.0, 16.0]);
    let bld = |lo, hi| Obstacle::Building { footprint: rect_from(lo, hi), base_z: 0.0, height_agl: 9.0 };

    let mut buildings = scene_with(bld(alo, ahi), s, r, 0.5);
    buildings.obstacles.push(bld(blo, bhi));
    let mut solids = scene_with(box_solid(alo, ahi, 0.0, 9.0), s, r, 0.5);
    solids.obstacles.push(box_solid(blo, bhi, 0.0, 9.0));
    let mut mixed = scene_with(box_solid(alo, ahi, 0.0, 9.0), s, r, 0.5);
    mixed.obstacles.push(bld(blo, bhi));

    let bands = |sc| solve(sc).unwrap().per_receiver[0].per_source[0].bands.clone();
    let (bb, sb, mb) = (bands(&buildings), bands(&solids), bands(&mixed));
    for i in 0..bb.len() {
        assert!((bb[i] - sb[i]).abs() < 1e-9, "two solids must equal two buildings @ band {i}: {} vs {}", bb[i], sb[i]);
        assert!((bb[i] - mb[i]).abs() < 1e-9, "solid+building must equal two buildings @ band {i}: {} vs {}", bb[i], mb[i]);
    }
}

/// An axis-aligned box `Solid` from two plan corners.
fn box_solid(lo: [f64; 2], hi: [f64; 2], base: f64, top: f64) -> Obstacle {
    Obstacle::Solid {
        vertices: vec![
            [lo[0], lo[1], top], [hi[0], lo[1], top], [hi[0], hi[1], top], [lo[0], hi[1], top],
            [lo[0], lo[1], base], [hi[0], lo[1], base], [hi[0], hi[1], base], [lo[0], hi[1], base],
        ],
        edges: vec![
            [0, 1], [1, 2], [2, 3], [3, 0], // roof
            [4, 0], [5, 1], [6, 2], [7, 3], // posts
        ],
    }
}

/// A `Solid` that straddles the S→R plan line but lies wholly BEYOND the receiver
/// (or BEHIND the source) does not screen the direct ray — its over-top and
/// lateral plane-crossings project outside the [0, L] span and must be dropped.
/// Regression for the phantom-screening bug (project_solid_edges / lateral_plane_hull
/// were missing the span gate that project_walls has).
#[test]
fn off_span_solid_does_not_screen() {
    let s = [0.0, 0.0, 2.0];
    let r = [100.0, 0.0, 2.0];
    for (name, lo, hi) in [
        ("beyond receiver", [110.0, -6.0], [122.0, 6.0]),
        ("behind source", [-25.0, -6.0], [-12.0, 6.0]),
    ] {
        let with = scene_with(box_solid(lo, hi, 0.0, 12.0), s, r, 0.5);
        let mut without = with.clone();
        without.obstacles.clear();
        let wb = solve(&with).unwrap().per_receiver[0].per_source[0].bands.clone();
        let ob = solve(&without).unwrap().per_receiver[0].per_source[0].bands.clone();
        for (a, b) in wb.iter().zip(ob.iter()) {
            assert!(
                (a - b).abs() < 1e-9,
                "off-span solid ({name}) must not screen: {a} vs open {b}"
            );
        }
    }
}

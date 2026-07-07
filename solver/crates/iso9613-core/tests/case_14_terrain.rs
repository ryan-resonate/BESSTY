//! Validation case 14 — terrain (heightfield ridge) screening.
//!
//! A triangular ground ridge between source and receiver breaks the line of
//! sight and diffracts the ray like a barrier top edge (ISO/TR 17534-3 §5.8:
//! a relevant ground ridge is a diffracting edge, and — being an unbounded
//! ridge — contributes NO lateral edge). Because the ridge is triangular, its
//! apex is the sole convex-hull vertex above the S→R line, so terrain screening
//! here reduces to a SINGLE diffracting edge at (dp = 100 m along the path,
//! z = 10 m) — identical geometry to a thin wall at x = 100 with top z = 10.
//!
//! Expected per-band Lp and total are independently computed (scratchpad
//! `oracle.py`, single-edge 2024 chain — NOT ported from the Rust): the apex
//! geometry is `geom_single(hS=3, hR=3, dp=200, edge_x=100, edge_z=10)`.

use approx::assert_relative_eq;
use iso9613_core::iso9613::terrain::Heightfield;
use iso9613_core::scene::{
    solve, Atmosphere, Ground, Receiver, Scene, Settings, Source, SourceKind, Standard, Terrain,
    SCHEMA_VERSION,
};

/// A triangular ridge on a regular raster: `z = max(0, 10 − 0.2·|x − 100|)`,
/// nonzero over x ∈ [50, 150], flat (0) elsewhere. Nodes every 5 m over
/// x ∈ [0, 200] (`ny = 1`: the profile depends only on x). The apex node sits
/// exactly at x = 100, z = 10.
fn ridge_terrain() -> Terrain {
    let nx = 41usize; // 0, 5, …, 200
    let heights: Vec<f64> = (0..nx)
        .map(|i| {
            let x = i as f64 * 5.0;
            (10.0 - 0.2 * (x - 100.0).abs()).max(0.0)
        })
        .collect();
    Terrain::Heightfield(Heightfield {
        origin: [0.0, 0.0],
        spacing: 5.0,
        nx,
        ny: 1,
        heights,
    })
}

/// Flat scene: S(0,0,3) → R(200,0,3), both 3 m over z = 0 ground, hard ground
/// (G = 0). `terrain` optional so the with/without comparison shares geometry.
fn scene(terrain: Option<Terrain>) -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere::default(), // 10 °C, 70 %, 101.325 kPa (oracle defaults)
        ground: Ground { default_g: 0.0, regions: vec![] },
        terrain,
        sources: vec![Source {
            id: "s".into(),
            kind: SourceKind::General,
            position: [0.0, 0.0, 3.0],
            height_agl: 3.0,
            lw: vec![100.0; 10],
        }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "r".into(), position: [200.0, 0.0, 3.0], height_agl: 3.0 }],
        obstacles: vec![],
        reflectors: vec![],
        settings: Settings::default(),
    }
}

#[test]
fn terrain_ridge_screens_like_a_single_edge_barrier() {
    let res = solve(&scene(Some(ridge_terrain()))).unwrap();
    let bands = &res.per_receiver[0].per_source[0].bands;

    // Independently computed (oracle.py, CASE 14).
    let expected = [
        41.797, 41.575, 41.033, 40.013, 38.376, 36.171, 33.398, 29.500, 21.988, 2.601,
    ];
    for (i, exp) in expected.iter().enumerate() {
        assert_relative_eq!(bands[i], *exp, epsilon = 0.05);
    }
    assert_relative_eq!(res.per_receiver[0].total_dba.unwrap(), 38.307, epsilon = 0.05);
}

#[test]
fn terrain_ridge_attenuates_vs_flat_ground() {
    // Same S/R, ridge removed → no screening. The ridge must drop the level by
    // ~12 dB (oracle: 50.364 → 38.307).
    let with_ridge = solve(&scene(Some(ridge_terrain()))).unwrap().per_receiver[0]
        .total_dba
        .unwrap();
    let flat = solve(&scene(None)).unwrap().per_receiver[0].total_dba.unwrap();
    assert_relative_eq!(flat, 50.364, epsilon = 0.05);
    assert!(
        flat - with_ridge > 10.0,
        "ridge should screen by >10 dB: flat={flat} ridge={with_ridge}"
    );
}

#[test]
fn terrain_round_trips_through_json() {
    let s = scene(Some(ridge_terrain()));
    let json = serde_json::to_string(&s).unwrap();
    let back: Scene = serde_json::from_str(&json).unwrap();
    // The reloaded scene solves identically.
    let a = solve(&s).unwrap().per_receiver[0].total_dba.unwrap();
    let b = solve(&back).unwrap().per_receiver[0].total_dba.unwrap();
    assert_relative_eq!(a, b, epsilon = 1e-12);
}

//! P5 — measure what wall screening actually costs before optimising it.
//!
//! `project_walls` runs once per source→receiver pair and intersects the S→R
//! line with EVERY wall segment in the scene. Walls scale with drawn length:
//! BEESTY densifies a polyline to ≤10 m sub-segments (so a wall crest follows
//! the terrain), and every source container contributes four more. A real BESS
//! site is therefore several hundred segments inside the innermost loop.
//!
//! Run with (single-threaded — the two cases interleave and contaminate each
//! other's timings otherwise):
//!   cargo test -p iso9613-core --release --test perf_wall_screening -- \n//!     --ignored --nocapture --test-threads=1
//!
//! `#[ignore]` so it never runs in the ordinary suite — it is a measurement,
//! not an assertion about wall-clock time on unknown hardware.

use std::time::Instant;

use iso9613_core::scene::{
    Atmosphere, Ground, Obstacle, Receiver, Scene, Settings, Source, SourceKind, Standard,
    SCHEMA_VERSION,
};
use iso9613_core::iso9613::ground::GroundMethod;

fn lw() -> Vec<f64> {
    vec![95.0; 10]
}

/// A site the shape of a real project: `containers` boxes in rows (four wall
/// segments each) plus a perimeter fence densified to 10 m, exactly as
/// `sceneBuilder` would emit it.
fn site(containers: usize, fence_m: f64) -> Vec<Obstacle> {
    let mut obs = Vec::new();
    let per_row = 20;
    for i in 0..containers {
        let (r, c) = (i / per_row, i % per_row);
        let (x, y) = (c as f64 * 8.0, r as f64 * 12.0);
        obs.push(Obstacle::Building {
            footprint: vec![
                [x, y],
                [x + 6.06, y],
                [x + 6.06, y + 2.44],
                [x, y + 2.44],
            ],
            base_z: 0.0,
            height_agl: 2.9,
        });
    }
    // Perimeter fence, 10 m segments — one Wall obstacle with many vertices.
    let n = (fence_m / 10.0) as usize;
    let mut poly = Vec::with_capacity(n + 1);
    for k in 0..=n {
        poly.push([-60.0 + k as f64 * 10.0, -40.0]);
    }
    let len = poly.len();
    obs.push(Obstacle::Wall {
        polyline: poly,
        base_z: vec![0.0; len],
        height_agl: 3.0,
        top_z: None,
    });
    obs
}

/// One grid tile's worth of work: 16×16 cells against `n_sources` sources.
fn tile_scene(n_sources: usize, obstacles: Vec<Obstacle>) -> Scene {
    let sources = (0..n_sources)
        .map(|i| Source {
            id: format!("s{i}"),
            kind: SourceKind::General,
            position: [(i % 20) as f64 * 8.0 + 3.0, (i / 20) as f64 * 12.0 + 1.2, 3.2],
            height_agl: 3.2,
            lw: lw(),
        })
        .collect();
    let receivers = (0..256)
        .map(|i| Receiver {
            id: format!("r{i}"),
            position: [400.0 + (i % 16) as f64 * 25.0, 300.0 + (i / 16) as f64 * 25.0, 1.5],
            height_agl: 1.5,
        })
        .collect();
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere { temperature_c: 10.0, relative_humidity_pct: 70.0, pressure_kpa: 101.325 },
        ground: Ground { default_g: 0.5, regions: vec![] },
        terrain: None,
        sources,
        extended_sources: vec![],
        receivers,
        obstacles,
        reflectors: vec![],
        cylinders: vec![],
        amisc: Default::default(),
        settings: Settings { ground_method: GroundMethod::General, ..Default::default() },
    }
}

fn time_solve(label: &str, scene: &Scene) -> f64 {
    // One warm-up, then the timed run.
    let _ = iso9613_core::scene::solve(scene).unwrap();
    let t0 = Instant::now();
    let res = iso9613_core::scene::solve(scene).unwrap();
    let ms = t0.elapsed().as_secs_f64() * 1000.0;
    // Touch the result so nothing is optimised away.
    assert!(res.per_receiver[0].total_dba.is_some());
    println!("  {label:<44} {ms:9.1} ms");
    ms
}

/// Walls nowhere near any source→receiver line: a perimeter fence on the far
/// side of the site. These can never screen, so their whole cost is the
/// per-pair rejection test — which is what P5's prune targets.
fn distant_fence(segments: usize) -> Vec<Obstacle> {
    // Runs due south of the sources, while every receiver is far north-east:
    // no S→R line comes near it.
    let mut poly = Vec::with_capacity(segments + 1);
    for k in 0..=segments {
        poly.push([-500.0 + k as f64 * 10.0, -800.0]);
    }
    let len = poly.len();
    vec![Obstacle::Wall {
        polyline: poly,
        base_z: vec![0.0; len],
        height_agl: 3.0,
        top_z: None,
    }]
}

#[test]
#[ignore = "measurement, not an assertion — run explicitly with --release --nocapture"]
fn irrelevant_walls_are_cheap_to_reject() {
    println!("\nP5 — cost of walls that CANNOT screen (pure rejection cost)\n");
    let n_src = 50;
    let bare = time_solve("no obstacles", &tile_scene(n_src, vec![]));
    for n in [100usize, 500, 1000, 2000] {
        let t = time_solve(
            &format!("{n} distant fence segments (never cross)"),
            &tile_scene(n_src, distant_fence(n)),
        );
        println!(
            "      → rejection overhead {:.1} ms ({:.1} %)",
            t - bare,
            100.0 * (t - bare) / t
        );
    }
    println!();
}

#[test]
#[ignore = "measurement, not an assertion — run explicitly with --release --nocapture"]
fn wall_screening_cost_scales_with_segment_count() {
    println!("\nP5 — cost of wall screening in one 16x16 grid tile (256 receivers)\n");

    // 50 sources is a modest BESS row; the grid's near-field tiles carry far
    // more, so treat these as a lower bound on the real cost.
    let n_src = 50;

    println!("50 sources:");
    let bare = time_solve("no obstacles", &tile_scene(n_src, vec![]));
    let small = time_solve("20 containers + 200 m fence  (100 segs)", &tile_scene(n_src, site(20, 200.0)));
    let mid = time_solve("100 containers + 1 km fence  (500 segs)", &tile_scene(n_src, site(100, 1000.0)));
    let big = time_solve("200 containers + 2 km fence  (1000 segs)", &tile_scene(n_src, site(200, 2000.0)));

    println!("\n  screening share of total solve:");
    for (label, t) in [("100 segs", small), ("500 segs", mid), ("1000 segs", big)] {
        println!("  {label:<44} {:8.1} %", 100.0 * (t - bare) / t);
    }
    println!(
        "\n  per-segment marginal cost: {:.3} ms per 100 segments\n",
        (big - small) / 9.0,
    );
}

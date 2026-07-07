//! Rough throughput benchmark for the grid hot path. Not a correctness test —
//! it prints ns/eval and projects grid wall-clock for the per-tile clustering.
//!
//! Run: `cargo test --release --test bench_grid -- --ignored --nocapture`
//!
//! Native build (no wasm SIMD), so the absolute numbers are conservative vs the
//! deployed wasm; the *ratio* (global vs per-tile clustering) is what matters.

use std::time::Instant;

use iso9613_core::iso9613::atmosphere::Atmosphere;
use iso9613_core::iso9613::barrier::WallBarrier;
use iso9613_core::iso9613::evaluate_with_barriers;
use iso9613_core::{BandSpectrum, BandSystem, Vec3};

fn flat_100() -> BandSpectrum {
    BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat_n(100.0, 10))
}

/// One BESS-like source → one cell, through a barrier subdivided into 10 m
/// pieces (perpendicular wall at x=150, 10 sub-segments spanning n=−50..50).
fn time_one_eval(walls: &[WallBarrier], iters: u32) -> f64 {
    let lw = flat_100();
    let r = Vec3::new(300.0, 0.0, 1.5);
    let atm = Atmosphere::iso_reference();
    let t = Instant::now();
    let mut acc = 0.0f64;
    for i in 0..iters {
        // Nudge the source each iter so the optimiser can't hoist the call.
        let s2 = Vec3::new((i as f64) * 1e-6, 0.0, 2.0);
        let lp = evaluate_with_barriers(
            &lw, s2, r, s2.z, r.z, 0.5, walls, &[], None, atm,
        );
        acc += lp.bands[0];
    }
    std::hint::black_box(acc);
    t.elapsed().as_nanos() as f64 / iters as f64
}

fn subdivided_barrier(pieces: usize) -> Vec<WallBarrier> {
    (0..pieces)
        .map(|k| {
            let n0 = -50.0 + (k as f64) * (100.0 / pieces as f64);
            let n1 = -50.0 + ((k + 1) as f64) * (100.0 / pieces as f64);
            WallBarrier { a_e: 150.0, a_n: n0, b_e: 150.0, b_n: n1, base_z_a: 0.0, base_z_b: 0.0, height_agl: 5.0 }
        })
        .collect()
}

#[test]
#[ignore]
fn bench_grid_projection() {
    let no_bar: Vec<WallBarrier> = vec![];
    let ns_nobar = time_one_eval(&no_bar, 300_000);
    let ns_bar10 = time_one_eval(&subdivided_barrier(10), 300_000);

    println!("\n--- per-source eval cost (native, no SIMD) ---");
    println!("  no barrier        : {:.0} ns/eval", ns_nobar);
    println!("  10-piece barrier  : {:.0} ns/eval", ns_bar10);

    // Project a 200×200 grid (40 000 cells), 200 BESS clustered tightly, grid
    // extending well beyond them (grid ≫ cluster) — the user's case.
    let cells = 40_000.0;
    let ns = ns_bar10;
    let global = cells * 200.0 * ns / 1e6; // OLD: 200 sources every cell
    // Per-tile: most cells are "far" → 1 cluster (and clusters skip topo);
    // only a small near zone keeps all 200. Assume 92% far / 8% near.
    let per_tile = cells * (0.92 * 1.0 + 0.08 * 200.0) * ns / 1e6;
    println!("\n--- projected 200x200 grid, 200 BESS, grid >> cluster ---");
    println!("  global clustering (old) : {:.0} ms", global);
    println!("  per-tile clustering     : {:.0} ms   ({:.0}x faster)", per_tile, global / per_tile);
    println!("(wasm SIMD + worker offload reduce wall-clock further; ratio is the point.)\n");
}

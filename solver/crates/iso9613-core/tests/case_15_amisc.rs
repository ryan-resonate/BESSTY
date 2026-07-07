//! Validation case 15 — Annex A miscellaneous attenuation `Amisc`.
//!
//! Wires the foliage / industrial / housing kernels (already unit-tested vs the
//! Annex A tables) into the Scene and validates the WIRING: the plan-path
//! length crossing each region (× the 3D slant) and the per-band application.
//! The expected drops are the Annex A values for INDEPENDENTLY hand-computed
//! path lengths — so a correct result confirms both the geometry (segment ∩
//! polygon) and the subtraction.
//!
//! Amisc is off by default; every assertion is a with-region MINUS without-
//! region delta, which isolates Amisc from the rest of the propagation chain.

use approx::assert_relative_eq;
use iso9613_core::scene::{
    solve, Amisc, Atmosphere, FoliageRegion, Ground, HousingRegion, Receiver, Scene, Settings,
    SiteRegion, Source, SourceKind, Standard, SCHEMA_VERSION,
};

/// Flat hard-ground scene S(sx,sy,sz)→R(rx,ry,rz), octave, Lw = 100, with the
/// supplied `Amisc`.
fn scene(s: [f64; 3], r: [f64; 3], amisc: Amisc) -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere::default(),
        ground: Ground { default_g: 0.0, regions: vec![] },
        terrain: None,
        sources: vec![Source {
            id: "s".into(),
            kind: SourceKind::General,
            position: s,
            height_agl: s[2],
            lw: vec![100.0; 10],
        }],
        extended_sources: vec![],
        receivers: vec![Receiver { id: "r".into(), position: r, height_agl: r[2] }],
        obstacles: vec![],
        reflectors: vec![],
        amisc,
        settings: Settings::default(),
    }
}

/// Per-band drop introduced by `amisc` vs the same scene without it.
fn amisc_delta(s: [f64; 3], r: [f64; 3], amisc: Amisc) -> Vec<f64> {
    let base = solve(&scene(s, r, Amisc::default())).unwrap().per_receiver[0].per_source[0]
        .bands
        .clone();
    let with = solve(&scene(s, r, amisc)).unwrap().per_receiver[0].per_source[0].bands.clone();
    base.iter().zip(with.iter()).map(|(b, w)| b - w).collect()
}

/// A rectangle [x0,x1]×[y0,y1] as a closed CCW polygon.
fn rect(x0: f64, x1: f64, y0: f64, y1: f64) -> Vec<[f64; 2]> {
    vec![[x0, y0], [x1, y0], [x1, y1], [x0, y1]]
}

const S: [f64; 3] = [0.0, 0.0, 3.0];
const R: [f64; 3] = [200.0, 0.0, 3.0]; // straight-line distance 200 → slant == plan

#[test]
fn foliage_belt_applies_table_a1() {
    // Foliage x∈[80,120] crossed head-on → df = 40 m. Table A.1 per-metre row
    // (63…8k = 0.02,0.02,0.03,0.04,0.05,0.06,0.08,0.09,0.12; sub-63 = 63) × 40.
    let amisc = Amisc {
        foliage: vec![FoliageRegion { polygon: rect(80.0, 120.0, -50.0, 50.0) }],
        ..Default::default()
    };
    let delta = amisc_delta(S, R, amisc);
    let expected = [0.8, 0.8, 0.8, 1.2, 1.6, 2.0, 2.4, 3.2, 3.6, 4.8];
    for (i, e) in expected.iter().enumerate() {
        assert_relative_eq!(delta[i], *e, epsilon = 1e-9);
    }
}

#[test]
fn industrial_site_applies_table_a7() {
    // Site x∈[80,120] → ds = 40 m. Per-metre (125…8k = .015,.025,.025,.02,.02,
    // .015,.015) × 40, sub-125 = 0.
    let amisc = Amisc {
        site: vec![SiteRegion { polygon: rect(80.0, 120.0, -50.0, 50.0) }],
        ..Default::default()
    };
    let delta = amisc_delta(S, R, amisc);
    let expected = [0.0, 0.0, 0.0, 0.6, 1.0, 1.0, 0.8, 0.8, 0.6, 0.6];
    for (i, e) in expected.iter().enumerate() {
        assert_relative_eq!(delta[i], *e, epsilon = 1e-9);
    }
}

#[test]
fn housing_density_and_facade_terms() {
    // Housing x∈[80,120] → db = 40 m. Density term 0.1·B·db, B=0.5 → 2.0 dB,
    // frequency-independent.
    let dens = Amisc {
        housing: vec![HousingRegion { polygon: rect(80.0, 120.0, -50.0, 50.0), b_density: 0.5, facade_pct: 0.0 }],
        ..Default::default()
    };
    for d in amisc_delta(S, R, dens) {
        assert_relative_eq!(d, 2.0, epsilon = 1e-9);
    }

    // Add façade rows p=50 % → −10·lg(0.5) = 3.0103 dB on top → 5.0103 dB.
    let both = Amisc {
        housing: vec![HousingRegion { polygon: rect(80.0, 120.0, -50.0, 50.0), b_density: 0.5, facade_pct: 50.0 }],
        ..Default::default()
    };
    for d in amisc_delta(S, R, both) {
        assert_relative_eq!(d, 2.0 + 3.010_299_957, epsilon = 1e-6);
    }
}

#[test]
fn housing_total_caps_at_10db() {
    // B=1.0, db=40 → a1=4; façade p=90 → a2=−10·lg(0.1)=10; total 14 → capped 10.
    let amisc = Amisc {
        housing: vec![HousingRegion { polygon: rect(80.0, 120.0, -50.0, 50.0), b_density: 1.0, facade_pct: 90.0 }],
        ..Default::default()
    };
    for d in amisc_delta(S, R, amisc) {
        assert_relative_eq!(d, 10.0, epsilon = 1e-9);
    }
}

#[test]
fn three_terms_are_additive() {
    // Foliage + site + housing over the same 40 m belt: the total drop is the
    // sum of the three independent contributions.
    let amisc = Amisc {
        foliage: vec![FoliageRegion { polygon: rect(80.0, 120.0, -50.0, 50.0) }],
        site: vec![SiteRegion { polygon: rect(80.0, 120.0, -50.0, 50.0) }],
        housing: vec![HousingRegion { polygon: rect(80.0, 120.0, -50.0, 50.0), b_density: 0.5, facade_pct: 0.0 }],
    };
    let delta = amisc_delta(S, R, amisc);
    let afol = [0.8, 0.8, 0.8, 1.2, 1.6, 2.0, 2.4, 3.2, 3.6, 4.8];
    let asite = [0.0, 0.0, 0.0, 0.6, 1.0, 1.0, 0.8, 0.8, 0.6, 0.6];
    for i in 0..10 {
        assert_relative_eq!(delta[i], afol[i] + asite[i] + 2.0, epsilon = 1e-9);
    }
}

#[test]
fn oblique_path_length_is_the_slant_through_the_polygon() {
    // Diagonal ray S(0,0)→R(100,100) (both z=10). A foliage square x∈[30,90],
    // y∈[40,80]: the ray y=x enters the bottom edge at (40,40) and leaves the
    // top edge at (80,80) — plan chord hypot(40,40), fraction 0.4 of the path.
    // df = 0.4·slant, slant = hypot(100,100). Validates oblique segment∩polygon
    // + slant scaling against Table A.1's per-metre row.
    let s = [0.0, 0.0, 10.0];
    let r = [100.0, 100.0, 10.0];
    let slant = (100.0f64).hypot(100.0);
    let df = 0.4 * slant; // ≈ 56.5685 m
    let per_m = [0.02, 0.02, 0.02, 0.03, 0.04, 0.05, 0.06, 0.08, 0.09, 0.12];
    let amisc = Amisc {
        foliage: vec![FoliageRegion { polygon: rect(30.0, 90.0, 40.0, 80.0) }],
        ..Default::default()
    };
    let delta = amisc_delta(s, r, amisc);
    for i in 0..10 {
        assert_relative_eq!(delta[i], per_m[i] * df, epsilon = 1e-6);
    }
}

#[test]
fn ray_missing_the_region_changes_nothing() {
    // Foliage patch off to the side (y∈[10,50]) the y=0 ray never enters.
    let amisc = Amisc {
        foliage: vec![FoliageRegion { polygon: rect(80.0, 120.0, 10.0, 50.0) }],
        ..Default::default()
    };
    for d in amisc_delta(S, R, amisc) {
        assert_relative_eq!(d, 0.0, epsilon = 1e-12);
    }
}

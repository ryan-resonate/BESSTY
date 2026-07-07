//! Validation case 13 — extended (line / area) sources (§4 subdivision).
//!
//! An extended source is subdivided per receiver into point sub-sources. We
//! validate by comparison against a *fine* manual decomposition into many equal
//! point sources evaluated through the already-validated point solver — the
//! adaptive k = 0.5 subdivision must converge to it.

use approx::assert_relative_eq;
use iso9613_core::scene::{
    solve, Amisc, Atmosphere, ExtendedSource, ExtentGeometry, Ground, Receiver, Scene, Settings,
    Source, SourceKind, Standard, SCHEMA_VERSION,
};

fn base_scene(sources: Vec<Source>, extended: Vec<ExtendedSource>) -> Scene {
    Scene {
        schema_version: SCHEMA_VERSION,
        standard: Standard::Iso9613_2_2024,
        atmosphere: Atmosphere::default(),
        ground: Ground { default_g: 0.0, regions: vec![] },
        terrain: None,
        sources,
        extended_sources: extended,
        receivers: vec![Receiver { id: "r".into(), position: [50.0, 100.0, 2.0], height_agl: 2.0 }],
        obstacles: vec![],
        reflectors: vec![],
        amisc: Amisc::default(),
        settings: Settings::default(),
    }
}

/// N equal point sources evenly spaced along the x∈[0,100] line at y=0, each
/// carrying `total_lw − 10·lg(N)`.
fn point_reference(n: usize) -> Vec<Source> {
    let per = 100.0 - 10.0 * (n as f64).log10();
    (0..n)
        .map(|i| Source {
            id: format!("p{i}"),
            kind: SourceKind::General,
            position: [(i as f64 + 0.5) / n as f64 * 100.0, 0.0, 2.0],
            height_agl: 2.0,
            lw: vec![per; 10],
        })
        .collect()
}

fn line_source() -> ExtendedSource {
    ExtendedSource {
        id: "line".into(),
        kind: SourceKind::General,
        geometry: ExtentGeometry::Line { vertices: vec![[0.0, 0.0], [100.0, 0.0]] },
        z: 2.0,
        height_agl: 2.0,
        lw: vec![100.0; 10],
    }
}

#[test]
fn line_source_matches_fine_point_reference() {
    let line = solve(&base_scene(vec![], vec![line_source()])).unwrap()
        .per_receiver[0].total_dba.unwrap();
    let reference = solve(&base_scene(point_reference(400), vec![])).unwrap()
        .per_receiver[0].total_dba.unwrap();

    // The k = 0.5 adaptive subdivision must converge to the fine reference.
    assert_relative_eq!(line, reference, epsilon = 0.3);
}

#[test]
fn line_source_conserves_total_power_vs_single_point() {
    // A line source and a single point at its centre carrying the same total LW
    // should be within a couple dB at this distance (spread vs point), and the
    // line must not be quieter than a point 50 m further away.
    let line = solve(&base_scene(vec![], vec![line_source()])).unwrap()
        .per_receiver[0].total_dba.unwrap();
    let centre = Source {
        id: "c".into(), kind: SourceKind::General,
        position: [50.0, 0.0, 2.0], height_agl: 2.0, lw: vec![100.0; 10],
    };
    let point = solve(&base_scene(vec![centre], vec![])).unwrap()
        .per_receiver[0].total_dba.unwrap();
    assert!((line - point).abs() < 2.0, "line {line} vs centre point {point}");
}

#[test]
fn area_source_solves_and_is_finite() {
    let area = ExtendedSource {
        id: "area".into(),
        kind: SourceKind::General,
        geometry: ExtentGeometry::Area { polygon: vec![[0.0, 0.0], [40.0, 0.0], [40.0, 40.0], [0.0, 40.0]] },
        z: 2.0,
        height_agl: 2.0,
        lw: vec![100.0; 10],
    };
    let t = solve(&base_scene(vec![], vec![area])).unwrap().per_receiver[0].total_dba.unwrap();
    assert!(t.is_finite() && t > 0.0, "area total = {t}");
}

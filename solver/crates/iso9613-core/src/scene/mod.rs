//! Typed, serializable scene model — the public "what to compute" API.
//!
//! Phase-0 scope: types + validation + a one-shot `solve()` for point
//! receivers, wrapping the existing 2024 evaluators. The stateful `Session`
//! (incremental updates, grids) arrives in Phase 6; terrain, ground regions,
//! buildings and reflections extend these types in Phase 3 — extension is by
//! ADDING fields/variants, never by repurposing existing ones.
//!
//! Coordinates are Cartesian metres (e, n, z-absolute); heights are metres
//! above local ground. Callers own all geodetic work.

use serde::{Deserialize, Serialize};

pub mod extent;

use crate::iso9613::annex_d::{self, WtgRules};
use crate::iso9613::atmosphere::Atmosphere as CoreAtmosphere;
use crate::iso9613::barrier::{LateralEdge, WallBarrier};
use crate::iso9613::ground::GroundMethod;
use crate::iso9613::meteorology::cmet_db;
use crate::iso9613::reflection;
use crate::spectrum::{BandSpectrum, BandSystem};
use crate::standards::{GeneralEval, Iso1996, Iso2024, StandardModel};
use crate::units::Vec3;

pub const SCHEMA_VERSION: u32 = 1;

/// Calculation standard. `#[non_exhaustive]`: future editions/standards are
/// added as new variants without breaking consumers.
#[non_exhaustive]
#[derive(Copy, Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Standard {
    #[serde(rename = "iso9613-2:1996")]
    Iso9613_2_1996,
    #[serde(rename = "iso9613-2:2024")]
    Iso9613_2_2024,
}

#[derive(Copy, Clone, Debug, Serialize, Deserialize)]
pub struct Atmosphere {
    pub temperature_c: f64,
    pub relative_humidity_pct: f64,
    pub pressure_kpa: f64,
}

impl Default for Atmosphere {
    fn default() -> Self {
        Self { temperature_c: 10.0, relative_humidity_pct: 70.0, pressure_kpa: 101.325 }
    }
}

impl From<Atmosphere> for CoreAtmosphere {
    fn from(a: Atmosphere) -> Self {
        CoreAtmosphere {
            temperature_c: a.temperature_c,
            relative_humidity_pct: a.relative_humidity_pct,
            pressure_kpa: a.pressure_kpa,
        }
    }
}

/// A ground-cover polygon: a uniform ground factor over a closed plan-view
/// region.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct GroundRegion {
    /// Closed plan-view polygon (implicitly closed — last vertex joins first).
    pub polygon: Vec<[f64; 2]>,
    /// Ground factor G (0 hard … 1 porous) inside the polygon.
    pub g: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Ground {
    /// Ground factor outside every region (0 hard … 1 porous).
    pub default_g: f64,
    /// Optional ground-cover polygons. Each source→receiver path's source /
    /// middle / receiver region `G` is the length-weighted average of the
    /// covers it crosses over that region's ground-plane extent (Eq 10). Empty
    /// ⇒ uniform `default_g` everywhere. Where polygons overlap, the first
    /// listed wins.
    #[serde(default)]
    pub regions: Vec<GroundRegion>,
}

impl Default for Ground {
    fn default() -> Self { Self { default_g: 0.5, regions: Vec::new() } }
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum SourceKind {
    #[default]
    General,
    WindTurbine { rotor_diameter_m: f64, apply_concave: bool },
}

/// Plan-view geometry of an extended source.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ExtentGeometry {
    /// A polyline (open) — a line source.
    Line { vertices: Vec<[f64; 2]> },
    /// A closed polygon — an area source.
    Area { polygon: Vec<[f64; 2]> },
}

/// A line or area source: subdivided per receiver into point sub-sources (§4,
/// raster factor k = 0.5), each carrying its share of `lw` (the TOTAL sound
/// power of the whole extent). `z` is the absolute source-plane elevation and
/// `height_agl` the height above local ground (both shared by all sub-sources).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ExtendedSource {
    pub id: String,
    #[serde(default)]
    pub kind: SourceKind,
    pub geometry: ExtentGeometry,
    pub z: f64,
    pub height_agl: f64,
    pub lw: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Source {
    pub id: String,
    pub kind: SourceKind,
    /// Absolute position (e, n, z-absolute) in metres. For a wind turbine,
    /// z is the absolute hub elevation.
    pub position: [f64; 3],
    /// Height above local ground (m) — feeds the ground-attenuation shape
    /// functions independently of the absolute z (split z-datum).
    pub height_agl: f64,
    /// Sound power level per band, dB re 1 pW. Length selects the band
    /// system: 10 = octave (16 Hz – 8 kHz), 31 = one-third octave.
    pub lw: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Receiver {
    pub id: String,
    pub position: [f64; 3],
    pub height_agl: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Obstacle {
    /// Thin screen: plan-view polyline with the absolute ground elevation
    /// under each vertex and a constant height above ground. Decomposed into
    /// terrain-following `WallBarrier` segments; the two polyline ENDS emit
    /// vertical `LateralEdge`s for around-the-end diffraction (§7.4.3).
    Wall {
        polyline: Vec<[f64; 2]>,
        base_z: Vec<f64>,
        height_agl: f64,
    },
    /// A 2D building footprint extruded to a flat roof: a closed plan-view
    /// polygon (implicitly closed — the last vertex joins the first), a single
    /// base ground elevation, and a constant height above it. Each footprint
    /// edge becomes a `WallBarrier`, so a source→receiver ray crossing the
    /// footprint diffracts over the near+far walls (multi-edge over the roof).
    ///
    /// Opaque, per ISO 9613-2 (no transmission). Per-vertex eave heights /
    /// pitched roofs (per-vertex `Solid3D`) and around-building lateral
    /// diffraction (needs the Fix-4 best-per-side selection) are later
    /// increments; buildings screen **over-top** only for now. Façade
    /// reflections arrive with the reflection engine.
    Building {
        footprint: Vec<[f64; 2]>,
        base_z: f64,
        height_agl: f64,
    },
    // Solid3D (true 3D objects) arrives later in Phase 3.
}

#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Settings {
    /// Override for the standard 20/25 dB Dz caps (general sources only;
    /// WTG sources use Annex D's own cap). None = standard caps.
    pub dz_cap_db: Option<f64>,
    /// §8 meteorological-correction factor C0 (dB). 0 disables Cmet.
    pub c0_db: f64,
    /// §7.3 ground method (edition-independent). Default General.
    #[serde(default)]
    pub ground_method: GroundMethod,
}

/// A reflecting vertical facade: a plan-view segment `[A, B]`, its height band
/// `[base_z, top_z]` (absolute m), and absorption `alpha` (0 = perfectly
/// reflecting; 0.1 typical). First-order specular reflections off it are
/// energy-summed with the direct path (§7.5). Reflectors are listed separately
/// from screening `obstacles` so the reflected ray isn't also diffracted by the
/// same surface.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Reflector {
    pub segment: [[f64; 2]; 2],
    pub base_z: f64,
    pub top_z: f64,
    pub alpha: f64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Scene {
    pub schema_version: u32,
    pub standard: Standard,
    pub atmosphere: Atmosphere,
    pub ground: Ground,
    pub sources: Vec<Source>,
    #[serde(default)]
    pub extended_sources: Vec<ExtendedSource>,
    pub receivers: Vec<Receiver>,
    pub obstacles: Vec<Obstacle>,
    #[serde(default)]
    pub reflectors: Vec<Reflector>,
    pub settings: Settings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SourceContribution {
    pub source_id: String,
    /// Z-weighted per-band Lp (dB), Cmet already applied.
    pub bands: Vec<f64>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReceiverResult {
    pub receiver_id: String,
    /// A-weighted total of the energy-summed per-band levels, dB(A).
    /// `None` when no source contributes (−∞).
    pub total_dba: Option<f64>,
    pub per_source: Vec<SourceContribution>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Results {
    pub per_receiver: Vec<ReceiverResult>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SceneError {
    UnsupportedSchemaVersion(u32),
    StandardNotImplemented(&'static str),
    NonFinite { entity: String },
    BadLwLength { source_id: String, len: usize },
    MixedBandSystems,
    DegenerateWall { index: usize, reason: &'static str },
    DegenerateBuilding { index: usize, reason: &'static str },
}

impl std::fmt::Display for SceneError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedSchemaVersion(v) => write!(f, "unsupported scene schema_version {v}"),
            Self::StandardNotImplemented(s) => write!(f, "standard not implemented yet: {s}"),
            Self::NonFinite { entity } => write!(f, "non-finite coordinate or value in {entity}"),
            Self::BadLwLength { source_id, len } => write!(
                f, "source '{source_id}': lw has {len} bands (expected 10 octave or 31 third-octave)"
            ),
            Self::MixedBandSystems => write!(f, "all sources must use the same band system"),
            Self::DegenerateWall { index, reason } => write!(f, "wall obstacle {index}: {reason}"),
            Self::DegenerateBuilding { index, reason } => write!(f, "building obstacle {index}: {reason}"),
        }
    }
}

impl std::error::Error for SceneError {}

fn band_system_for(len: usize) -> Option<BandSystem> {
    match len {
        10 => Some(BandSystem::Octave),
        31 => Some(BandSystem::OneThirdOctave),
        _ => None,
    }
}

fn all_finite(vals: impl IntoIterator<Item = f64>) -> bool {
    vals.into_iter().all(f64::is_finite)
}

impl Scene {
    /// Structural validation — cheap, no physics. `solve` calls this first.
    pub fn validate(&self) -> Result<BandSystem, SceneError> {
        if self.schema_version != SCHEMA_VERSION {
            return Err(SceneError::UnsupportedSchemaVersion(self.schema_version));
        }
        // Both editions are implemented (1996 + 2024).
        match self.standard {
            Standard::Iso9613_2_1996 | Standard::Iso9613_2_2024 => {}
        }
        if !all_finite([
            self.atmosphere.temperature_c,
            self.atmosphere.relative_humidity_pct,
            self.atmosphere.pressure_kpa,
            self.ground.default_g,
            self.settings.c0_db,
        ]) {
            return Err(SceneError::NonFinite { entity: "scene settings".into() });
        }

        let mut system: Option<BandSystem> = None;
        for src in &self.sources {
            if !all_finite(src.position.iter().copied().chain([src.height_agl]))
                || !all_finite(src.lw.iter().copied())
            {
                return Err(SceneError::NonFinite { entity: format!("source '{}'", src.id) });
            }
            let bs = band_system_for(src.lw.len())
                .ok_or(SceneError::BadLwLength { source_id: src.id.clone(), len: src.lw.len() })?;
            match system {
                None => system = Some(bs),
                Some(prev) if prev != bs => return Err(SceneError::MixedBandSystems),
                _ => {}
            }
        }
        for ext in &self.extended_sources {
            let verts: &[[f64; 2]] = match &ext.geometry {
                ExtentGeometry::Line { vertices } => vertices,
                ExtentGeometry::Area { polygon } => polygon,
            };
            let min_v = if matches!(ext.geometry, ExtentGeometry::Area { .. }) { 3 } else { 2 };
            if verts.len() < min_v {
                return Err(SceneError::BadLwLength { source_id: ext.id.clone(), len: verts.len() });
            }
            if !all_finite(verts.iter().flat_map(|p| p.iter().copied()).chain([ext.z, ext.height_agl]))
                || !all_finite(ext.lw.iter().copied())
            {
                return Err(SceneError::NonFinite { entity: format!("extended source '{}'", ext.id) });
            }
            let bs = band_system_for(ext.lw.len())
                .ok_or(SceneError::BadLwLength { source_id: ext.id.clone(), len: ext.lw.len() })?;
            match system {
                None => system = Some(bs),
                Some(prev) if prev != bs => return Err(SceneError::MixedBandSystems),
                _ => {}
            }
        }
        for rx in &self.receivers {
            if !all_finite(rx.position.iter().copied().chain([rx.height_agl])) {
                return Err(SceneError::NonFinite { entity: format!("receiver '{}'", rx.id) });
            }
        }
        for (i, ob) in self.obstacles.iter().enumerate() {
            match ob {
                Obstacle::Wall { polyline, base_z, height_agl } => {
                    if polyline.len() < 2 {
                        return Err(SceneError::DegenerateWall { index: i, reason: "polyline needs ≥ 2 vertices" });
                    }
                    if base_z.len() != polyline.len() {
                        return Err(SceneError::DegenerateWall { index: i, reason: "base_z length must match polyline" });
                    }
                    if !height_agl.is_finite() || *height_agl < 0.0 {
                        return Err(SceneError::DegenerateWall { index: i, reason: "height_agl must be finite and ≥ 0" });
                    }
                    if !all_finite(polyline.iter().flat_map(|p| p.iter().copied()).chain(base_z.iter().copied())) {
                        return Err(SceneError::NonFinite { entity: format!("obstacle {i}") });
                    }
                }
                Obstacle::Building { footprint, base_z, height_agl } => {
                    if footprint.len() < 3 {
                        return Err(SceneError::DegenerateBuilding { index: i, reason: "footprint needs ≥ 3 vertices" });
                    }
                    if !height_agl.is_finite() || *height_agl < 0.0 || !base_z.is_finite() {
                        return Err(SceneError::DegenerateBuilding { index: i, reason: "base_z/height_agl must be finite, height ≥ 0" });
                    }
                    if !all_finite(footprint.iter().flat_map(|p| p.iter().copied())) {
                        return Err(SceneError::NonFinite { entity: format!("obstacle {i}") });
                    }
                }
            }
        }
        // Default to octave when there are no sources (empty scene solves to silence).
        Ok(system.unwrap_or(BandSystem::Octave))
    }

    /// Decompose obstacles into solver primitives.
    fn barriers(&self) -> (Vec<WallBarrier>, Vec<LateralEdge>) {
        let mut walls = Vec::new();
        let mut lateral = Vec::new();
        for ob in &self.obstacles {
            match ob {
                Obstacle::Wall { polyline, base_z, height_agl } => {
                    for i in 0..polyline.len() - 1 {
                        walls.push(WallBarrier {
                            a_e: polyline[i][0], a_n: polyline[i][1],
                            b_e: polyline[i + 1][0], b_n: polyline[i + 1][1],
                            base_z_a: base_z[i], base_z_b: base_z[i + 1],
                            height_agl: *height_agl,
                        });
                    }
                    // Finite screens diffract around their two ends (§7.4.3).
                    for v in [0, polyline.len() - 1] {
                        lateral.push(LateralEdge {
                            e: polyline[v][0], n: polyline[v][1],
                            base_z: base_z[v], top_z: base_z[v] + height_agl,
                        });
                    }
                }
                Obstacle::Building { footprint, base_z, height_agl } => {
                    // Each footprint edge is a wall (implicitly closed loop). A
                    // ray crossing the footprint hits two edges → multi-edge
                    // over-the-roof diffraction. Every vertex is a candidate
                    // lateral (around-the-side) edge; the path engine's §5.2
                    // best-per-side selection reduces them to ≤ 2.
                    let n = footprint.len();
                    for i in 0..n {
                        let a = footprint[i];
                        let b = footprint[(i + 1) % n];
                        walls.push(WallBarrier {
                            a_e: a[0], a_n: a[1], b_e: b[0], b_n: b[1],
                            base_z_a: *base_z, base_z_b: *base_z, height_agl: *height_agl,
                        });
                        lateral.push(LateralEdge {
                            e: a[0], n: a[1], base_z: *base_z, top_z: base_z + height_agl,
                        });
                    }
                }
            }
        }
        (walls, lateral)
    }
}

/// Ray-casting point-in-polygon (even–odd rule) for an implicitly-closed
/// polygon.
fn point_in_polygon(p: [f64; 2], poly: &[[f64; 2]]) -> bool {
    let n = poly.len();
    if n < 3 {
        return false;
    }
    let mut inside = false;
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = (poly[i][0], poly[i][1]);
        let (xj, yj) = (poly[j][0], poly[j][1]);
        if ((yi > p[1]) != (yj > p[1])) && (p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) {
            inside = !inside;
        }
        j = i;
    }
    inside
}

/// Ground factor at a plan-view point: the first region containing it, else
/// `default_g`.
fn g_at(p: [f64; 2], regions: &[GroundRegion], default_g: f64) -> f64 {
    regions
        .iter()
        .find(|reg| point_in_polygon(p, &reg.polygon))
        .map_or(default_g, |reg| reg.g)
}

/// Length-weighted average ground factor for the source / middle / receiver
/// regions (§7.3.1) of the source→receiver path, from the ground-cover
/// `regions` (Eq 10). Source region: `[0, min(30·hS, dp)]`; receiver region:
/// `[max(0, dp − 30·hR), dp]`; middle: between them (empty ⇒ value unused, as
/// the kernel's `q` zeroes `Am`). Sampled along the plan projection.
fn region_ground_factors(
    s: [f64; 2],
    r: [f64; 2],
    h_s: f64,
    h_r: f64,
    regions: &[GroundRegion],
    default_g: f64,
) -> (f64, f64, f64) {
    let dp = ((r[0] - s[0]).powi(2) + (r[1] - s[1]).powi(2)).sqrt();
    if dp < 1e-9 {
        return (default_g, default_g, default_g);
    }
    // Midpoint-sample the extent `[lo, hi]` (metres along the path) and average
    // the ground factor. ~0.2 m resolution, floor of 1 sample.
    let avg = |lo: f64, hi: f64| -> f64 {
        let span = hi - lo;
        if span < 1e-9 {
            return default_g;
        }
        let k = ((span / dp * 1000.0).ceil() as usize).max(1);
        let mut acc = 0.0;
        for i in 0..k {
            let t = lo + (i as f64 + 0.5) / (k as f64) * span;
            let frac = t / dp;
            let p = [s[0] + frac * (r[0] - s[0]), s[1] + frac * (r[1] - s[1])];
            acc += g_at(p, regions, default_g);
        }
        acc / k as f64
    };
    let src_end = (30.0 * h_s).min(dp);
    let rx_start = (dp - 30.0 * h_r).max(0.0);
    let gs = avg(0.0, src_end);
    let gr = avg(rx_start, dp);
    let gm = if src_end < rx_start { avg(src_end, rx_start) } else { default_g };
    (gs, gm, gr)
}

/// One-shot point-receiver solve.
pub fn solve(scene: &Scene) -> Result<Results, SceneError> {
    let system = scene.validate()?;
    let atm: CoreAtmosphere = scene.atmosphere.into();
    let (walls, lateral) = scene.barriers();
    let g = scene.ground.default_g;

    // Edition dispatch (once) — general sources score through the standard's
    // evaluator; WTG sources always use Annex D (2024-only), independent of the
    // selected edition (1996 has no wind-turbine annex).
    let model: &dyn StandardModel = match scene.standard {
        Standard::Iso9613_2_1996 => &Iso1996,
        Standard::Iso9613_2_2024 => &Iso2024,
    };

    let per_receiver = scene
        .receivers
        .iter()
        .map(|rx| {
            let r = Vec3::new(rx.position[0], rx.position[1], rx.position[2]);
            let mut per_source = Vec::with_capacity(scene.sources.len());
            for src in &scene.sources {
                let s = Vec3::new(src.position[0], src.position[1], src.position[2]);
                let lw = BandSpectrum::from_iter(system, src.lw.iter().copied());
                let (g_source, g_middle, g_receiver) = if scene.ground.regions.is_empty() {
                    (g, g, g)
                } else {
                    region_ground_factors(
                        [s.e, s.n], [r.e, r.n], src.height_agl, rx.height_agl,
                        &scene.ground.regions, g,
                    )
                };
                let lp = match &src.kind {
                    SourceKind::General => model.evaluate_general(&GeneralEval {
                        lw: &lw,
                        source: s,
                        receiver: r,
                        h_s: src.height_agl,
                        h_r: rx.height_agl,
                        g_source,
                        g_middle,
                        g_receiver,
                        barriers: &walls,
                        lateral: &lateral,
                        dz_cap: scene.settings.dz_cap_db,
                        atm,
                        ground_method: scene.settings.ground_method,
                    }),
                    SourceKind::WindTurbine { rotor_diameter_m, apply_concave } => annex_d::evaluate_wtg(
                        &lw, s, r, src.height_agl, rx.height_agl, g, &walls, &lateral,
                        WtgRules::default(), *apply_concave, *rotor_diameter_m, atm,
                    ),
                };

                // §7.5 first-order reflections (general sources): each valid
                // facade adds an image-source contribution, energy-summed with
                // the direct path per band (gated by the Fresnel size validity).
                let mut bands: Vec<f64> = lp.bands.iter().copied().collect();
                if matches!(src.kind, SourceKind::General) && !scene.reflectors.is_empty() {
                    let centres = system.centres();
                    for reflector in &scene.reflectors {
                        let facade = reflection::Facade {
                            a: reflector.segment[0], b: reflector.segment[1],
                            base_z: reflector.base_z, top_z: reflector.top_z, alpha: reflector.alpha,
                        };
                        let Some(refl) = reflection::reflect(s, r, &facade) else { continue };
                        let img_lw = BandSpectrum::from_iter(system, src.lw.iter().map(|&x| x + refl.loss_db));
                        let refl_lp = model.evaluate_general(&GeneralEval {
                            lw: &img_lw, source: refl.image_source, receiver: r,
                            h_s: src.height_agl, h_r: rx.height_agl,
                            g_source, g_middle, g_receiver,
                            barriers: &walls, lateral: &lateral,
                            dz_cap: scene.settings.dz_cap_db, atm,
                            ground_method: scene.settings.ground_method,
                        });
                        for b in 0..system.n_bands() {
                            let lambda = 340.0 / centres[b];
                            if reflection::fresnel_valid(&refl, &facade, s, lambda) {
                                bands[b] = 10.0
                                    * (10f64.powf(0.1 * bands[b]) + 10f64.powf(0.1 * refl_lp.bands[b])).log10();
                            }
                        }
                    }
                }

                // §8 long-term meteorological correction (frequency-independent).
                let dp = ((r.e - s.e).powi(2) + (r.n - s.n).powi(2)).sqrt();
                let cmet = cmet_db(scene.settings.c0_db, src.height_agl, rx.height_agl, dp);
                per_source.push(SourceContribution {
                    source_id: src.id.clone(),
                    bands: bands.iter().map(|b| b - cmet).collect(),
                });
            }

            // Extended (line / area) sources: subdivide per this receiver into
            // point sub-sources and energy-sum their contributions (§4).
            let n = system.n_bands();
            for ext in &scene.extended_sources {
                let subs = match &ext.geometry {
                    ExtentGeometry::Line { vertices } => extent::subdivide_line(vertices, [r.e, r.n]),
                    ExtentGeometry::Area { polygon } => extent::subdivide_area(polygon, [r.e, r.n]),
                };
                let mut acc = vec![f64::NEG_INFINITY; n];
                for (pos, lw_off) in subs {
                    let ss = Vec3::new(pos[0], pos[1], ext.z);
                    let lw_sub = BandSpectrum::from_iter(system, ext.lw.iter().map(|&x| x + lw_off));
                    let (gs, gm, gr) = if scene.ground.regions.is_empty() {
                        (g, g, g)
                    } else {
                        region_ground_factors([ss.e, ss.n], [r.e, r.n], ext.height_agl, rx.height_agl, &scene.ground.regions, g)
                    };
                    let lp = model.evaluate_general(&GeneralEval {
                        lw: &lw_sub, source: ss, receiver: r,
                        h_s: ext.height_agl, h_r: rx.height_agl,
                        g_source: gs, g_middle: gm, g_receiver: gr,
                        barriers: &walls, lateral: &lateral,
                        dz_cap: scene.settings.dz_cap_db, atm,
                        ground_method: scene.settings.ground_method,
                    });
                    let dp = ((r.e - ss.e).powi(2) + (r.n - ss.n).powi(2)).sqrt();
                    let cmet = cmet_db(scene.settings.c0_db, ext.height_agl, rx.height_agl, dp);
                    for (a, &b) in acc.iter_mut().zip(lp.bands.iter()) {
                        *a = 10.0 * (10f64.powf(0.1 * *a) + 10f64.powf(0.1 * (b - cmet))).log10();
                    }
                }
                if acc.iter().any(|v| v.is_finite()) {
                    per_source.push(SourceContribution { source_id: ext.id.clone(), bands: acc });
                }
            }

            // Energy-sum per band across sources, then A-weight.
            let total_dba = if per_source.is_empty() {
                None
            } else {
                let n = system.n_bands();
                let mut summed = BandSpectrum::zeros(system);
                for i in 0..n {
                    let energy: f64 = per_source
                        .iter()
                        .map(|c| 10f64.powf(0.1 * c.bands[i]))
                        .sum();
                    summed.bands[i] = if energy > 0.0 { 10.0 * energy.log10() } else { f64::NEG_INFINITY };
                }
                let t = summed.a_weighted_total();
                if t.is_finite() { Some(t) } else { None }
            };

            ReceiverResult { receiver_id: rx.id.clone(), total_dba, per_source }
        })
        .collect();

    Ok(Results { per_receiver })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::iso9613::evaluate_with_barriers;
    use approx::assert_relative_eq;

    fn basic_scene() -> Scene {
        Scene {
            schema_version: SCHEMA_VERSION,
            standard: Standard::Iso9613_2_2024,
            atmosphere: Atmosphere::default(),
            ground: Ground { default_g: 0.5, regions: vec![] },
            sources: vec![Source {
                id: "s1".into(),
                kind: SourceKind::General,
                position: [0.0, 0.0, 5.0],
                height_agl: 5.0,
                lw: vec![100.0; 10],
            }],
            extended_sources: vec![],
            receivers: vec![Receiver { id: "r1".into(), position: [200.0, 0.0, 1.5], height_agl: 1.5 }],
            obstacles: vec![],
            reflectors: vec![],
            settings: Settings::default(),
        }
    }

    #[test]
    fn scene_solve_matches_direct_evaluator() {
        // The typed API must produce exactly what the flat evaluator produces.
        let scene = basic_scene();
        let results = solve(&scene).unwrap();
        let lw = BandSpectrum::from_iter(BandSystem::Octave, std::iter::repeat_n(100.0, 10));
        let direct = evaluate_with_barriers(
            &lw,
            Vec3::new(0.0, 0.0, 5.0),
            Vec3::new(200.0, 0.0, 1.5),
            5.0, 1.5, 0.5, &[], &[], None,
            CoreAtmosphere::iso_reference(),
        );
        let got = &results.per_receiver[0].per_source[0].bands;
        for (a, b) in got.iter().zip(direct.bands.iter()) {
            assert!(a == b, "scene path diverged from direct evaluator: {a} vs {b}");
        }
        assert_relative_eq!(
            results.per_receiver[0].total_dba.unwrap(),
            direct.a_weighted_total(),
            epsilon = 1e-12,
        );
    }

    #[test]
    fn iso1996_solves_and_differs_from_2024_over_a_barrier() {
        // A barrier makes the edition switch observable: 1996's Dz bracket
        // (3 + X·Kmet) gives slightly MORE attenuation than 2024's
        // (1 + (2+X)·Kmet), so the 1996 total is a touch lower.
        let mut base = basic_scene();
        base.obstacles.push(Obstacle::Wall {
            polyline: vec![[100.0, -50.0], [100.0, 50.0]],
            base_z: vec![0.0, 0.0],
            height_agl: 8.0,
        });
        let mut s96 = base.clone();
        s96.standard = Standard::Iso9613_2_1996;

        let t24 = solve(&base).unwrap().per_receiver[0].total_dba.unwrap();
        let t96 = solve(&s96).unwrap().per_receiver[0].total_dba.unwrap();
        assert!(t96 < t24, "1996 barrier should attenuate more: 1996={t96} 2024={t24}");
        assert!((t24 - t96) < 1.0, "edition delta should be small: {}", t24 - t96);
    }

    #[test]
    fn simplified_ground_method_solves() {
        // §7.3.2 selected via the setting — produces a finite result distinct
        // from the General method for the same flat-ground scene.
        let mut simp = basic_scene();
        simp_ground(&mut simp);
        let general = solve(&basic_scene()).unwrap().per_receiver[0].total_dba.unwrap();
        let simplified = solve(&simp).unwrap().per_receiver[0].total_dba.unwrap();
        assert!(simplified.is_finite());
        assert!((simplified - general).abs() > 0.01, "simplified should differ from general");
    }

    fn simp_ground(scene: &mut Scene) {
        scene.settings.ground_method = GroundMethod::Simplified;
    }

    #[test]
    fn region_factors_classify_two_zone_path() {
        // Hard zone x<100, porous zone x>100. S(0,0)→R(200,0), hS=hR=2 →
        // source region [0,60] (hard), receiver [140,200] (porous), middle
        // [60,140] straddles the boundary (40 m hard + 40 m porous → 0.5).
        let regions = vec![
            GroundRegion { polygon: vec![[-50.0, -50.0], [100.0, -50.0], [100.0, 50.0], [-50.0, 50.0]], g: 0.0 },
            GroundRegion { polygon: vec![[100.0, -50.0], [250.0, -50.0], [250.0, 50.0], [100.0, 50.0]], g: 1.0 },
        ];
        let (gs, gm, gr) = region_ground_factors([0.0, 0.0], [200.0, 0.0], 2.0, 2.0, &regions, 0.5);
        assert!((gs - 0.0).abs() < 1e-6, "gs = {gs}");
        assert!((gr - 1.0).abs() < 1e-6, "gr = {gr}");
        assert!((gm - 0.5).abs() < 0.01, "gm = {gm}");
    }

    #[test]
    fn nan_coordinate_rejected() {
        let mut scene = basic_scene();
        scene.receivers[0].position[0] = f64::NAN;
        assert!(matches!(solve(&scene), Err(SceneError::NonFinite { .. })));
    }

    #[test]
    fn wall_obstacle_decomposes_and_screens() {
        let mut scene = basic_scene();
        scene.obstacles.push(Obstacle::Wall {
            polyline: vec![[100.0, -50.0], [100.0, 50.0]],
            base_z: vec![0.0, 0.0],
            height_agl: 8.0,
        });
        let with_wall = solve(&scene).unwrap();
        let no_wall = solve(&basic_scene()).unwrap();
        assert!(
            with_wall.per_receiver[0].total_dba.unwrap()
                < no_wall.per_receiver[0].total_dba.unwrap() - 1.0,
            "wall should attenuate"
        );
    }

    #[test]
    fn scene_round_trips_through_json() {
        let scene = basic_scene();
        let json = serde_json::to_string(&scene).unwrap();
        let back: Scene = serde_json::from_str(&json).unwrap();
        assert_eq!(back.sources[0].id, "s1");
    }
}

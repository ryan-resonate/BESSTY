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
use crate::iso9613::barrier::path::{DiffractionEdge, FootprintLateral};
use crate::iso9613::barrier::{LateralEdge, WallBarrier};
use crate::iso9613::ground::GroundMethod;
use crate::iso9613::meteorology::cmet_db;
use crate::iso9613::misc;
use crate::iso9613::reflection;
use crate::iso9613::terrain::Heightfield;
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
    ///
    /// The top follows the terrain at constant `height_agl` (`base_z[i] +
    /// height_agl`) UNLESS `top_z` is given — an explicit absolute top
    /// elevation per vertex (a sloped / stepped crest, e.g. a screen whose
    /// crest is level while the ground beneath it rises). When present, `top_z`
    /// wins and `height_agl` is ignored for the crest.
    Wall {
        polyline: Vec<[f64; 2]>,
        base_z: Vec<f64>,
        height_agl: f64,
        #[serde(default)]
        top_z: Option<Vec<f64>>,
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
    /// Maximum specular-reflection order (ISO 9613-2:2024 §7.5.3). 1 = first
    /// order only (also the 1996 behaviour); 2+ adds multi-bounce paths between
    /// (nearly) parallel or surrounding reflectors. 0/absent ⇒ 1.
    #[serde(default)]
    pub max_reflection_order: u32,
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
    /// Broadband absorption coefficient (0 = perfectly reflecting). Used for
    /// every band unless `alpha_bands` is given.
    pub alpha: f64,
    /// Optional per-band absorption (real façades are frequency-dependent). When
    /// present its length must match the band system; it overrides `alpha`.
    #[serde(default)]
    pub alpha_bands: Option<Vec<f64>>,
}

/// A vertical cylindrical reflector (vessel, tank, curved façade) — ISO
/// 9613-2:2024 §7.5.4. A first-order specular reflection off the tangent plane
/// at the reflection point, weakened by the curvature attenuation `Acurv`
/// (Eq 30). Higher-order reflections off curved surfaces are not considered.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CylindricalReflector {
    pub centre: [f64; 2],
    pub radius: f64,
    pub base_z: f64,
    pub top_z: f64,
    pub alpha: f64,
    #[serde(default)]
    pub alpha_bands: Option<Vec<f64>>,
}

/// A dense-foliage plan region (Annex A.1). `Afol` accrues with the path length
/// crossing it. Assumes the ray lies within the canopy over the crossed extent
/// (canopy-height gating is a later refinement).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FoliageRegion {
    pub polygon: Vec<[f64; 2]>,
}

/// An industrial-installation plan region (Annex A.2). `Asite` accrues with the
/// path length crossing it (each band capped at 10 dB).
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct SiteRegion {
    pub polygon: Vec<[f64; 2]>,
}

/// A built-up (housing) plan region (Annex A.3). `Ahous` = `0.1·B·db` (density
/// term) `+ −10·lg(1 − p/100)` (façade-row term), A-weighted / frequency-
/// independent, from the path length `db` crossing it.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HousingRegion {
    pub polygon: Vec<[f64; 2]>,
    /// Building plan density `B` (0…1).
    pub b_density: f64,
    /// Façade-row percentage `p` along the corridor (0…90); 0 ⇒ no façade term.
    #[serde(default)]
    pub facade_pct: f64,
}

/// Annex A miscellaneous attenuation `Amisc` — foliage / industrial / housing
/// plan regions. Informative and **off by default** (all lists empty ⇒ 0 dB).
/// Edition-independent (identical simplified form in 1996 and 2024).
#[derive(Clone, Debug, Serialize, Deserialize, Default)]
pub struct Amisc {
    #[serde(default)]
    pub foliage: Vec<FoliageRegion>,
    #[serde(default)]
    pub site: Vec<SiteRegion>,
    #[serde(default)]
    pub housing: Vec<HousingRegion>,
}

impl Amisc {
    fn is_empty(&self) -> bool {
        self.foliage.is_empty() && self.site.is_empty() && self.housing.is_empty()
    }
}

/// Ground-elevation model for terrain screening (§7.4 / ISO/TR 17534-3 §5.8).
/// A relevant ground ridge between source and receiver breaks the line of sight
/// and diffracts the ray like a barrier top edge (contributing no lateral edge,
/// being an unbounded ridge). `#[non_exhaustive]` + tagged so contour/TIN
/// ingestion can be added as new variants (parsed down to a raster upstream).
#[non_exhaustive]
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Terrain {
    /// A regular gridded elevation raster (bilinearly sampled).
    Heightfield(Heightfield),
}

impl Terrain {
    /// Terrain-profile diffraction edges (absolute-elevation) in the vertical
    /// plane of the source→receiver plan line. Empty when the plan distance is
    /// degenerate.
    fn profile_edges(&self, s: [f64; 2], r: [f64; 2]) -> Vec<DiffractionEdge> {
        let dp = ((r[0] - s[0]).powi(2) + (r[1] - s[1]).powi(2)).sqrt();
        match self {
            Terrain::Heightfield(hf) => hf.profile_edges(s, r, dp),
        }
    }

    /// Simplified-method mean height `hm` over this terrain (§7.3.2, Fig 3).
    fn mean_height(&self, s: [f64; 2], r: [f64; 2], sz: f64, rz: f64) -> f64 {
        match self {
            Terrain::Heightfield(hf) => hf.mean_height(s, r, sz, rz),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Scene {
    pub schema_version: u32,
    pub standard: Standard,
    pub atmosphere: Atmosphere,
    pub ground: Ground,
    /// Optional ground-elevation model. `None` ⇒ flat ground at each entity's
    /// absolute z (no terrain screening). When present, a ground ridge between
    /// source and receiver diffracts the ray (§7.4 / ISO/TR 17534-3 §5.8).
    #[serde(default)]
    pub terrain: Option<Terrain>,
    pub sources: Vec<Source>,
    #[serde(default)]
    pub extended_sources: Vec<ExtendedSource>,
    pub receivers: Vec<Receiver>,
    pub obstacles: Vec<Obstacle>,
    #[serde(default)]
    pub reflectors: Vec<Reflector>,
    /// Cylindrical reflectors (2024 §7.5.4). First-order only.
    #[serde(default)]
    pub cylinders: Vec<CylindricalReflector>,
    /// Annex A miscellaneous attenuation regions (foliage / industrial /
    /// housing). Default-empty ⇒ no `Amisc`.
    #[serde(default)]
    pub amisc: Amisc,
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
                Obstacle::Wall { polyline, base_z, height_agl, top_z } => {
                    if polyline.len() < 2 {
                        return Err(SceneError::DegenerateWall { index: i, reason: "polyline needs ≥ 2 vertices" });
                    }
                    if base_z.len() != polyline.len() {
                        return Err(SceneError::DegenerateWall { index: i, reason: "base_z length must match polyline" });
                    }
                    if !height_agl.is_finite() || *height_agl < 0.0 {
                        return Err(SceneError::DegenerateWall { index: i, reason: "height_agl must be finite and ≥ 0" });
                    }
                    if let Some(tz) = top_z {
                        if tz.len() != polyline.len() {
                            return Err(SceneError::DegenerateWall { index: i, reason: "top_z length must match polyline" });
                        }
                        if !all_finite(tz.iter().copied()) {
                            return Err(SceneError::NonFinite { entity: format!("obstacle {i}") });
                        }
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

    /// Decompose obstacles into solver primitives: over-top wall segments,
    /// thin-wall lateral end edges, and building footprints (for multi-corner
    /// around-the-side wraps).
    fn barriers(&self) -> (Vec<WallBarrier>, Vec<LateralEdge>, Vec<FootprintLateral>) {
        let mut walls = Vec::new();
        let mut lateral = Vec::new();
        let mut footprints = Vec::new();
        for ob in &self.obstacles {
            match ob {
                Obstacle::Wall { polyline, base_z, height_agl, top_z } => {
                    // Absolute crest per vertex: explicit `top_z`, else the
                    // terrain-following `base_z + height_agl`.
                    let top = |i: usize| top_z.as_ref().map_or(base_z[i] + height_agl, |tz| tz[i]);
                    for i in 0..polyline.len() - 1 {
                        // The over-top diffraction only needs the CREST; encode a
                        // sloped crest as a zero-height segment sitting at `top`
                        // (WallBarrier's top = base + height, interpolated).
                        walls.push(WallBarrier {
                            a_e: polyline[i][0], a_n: polyline[i][1],
                            b_e: polyline[i + 1][0], b_n: polyline[i + 1][1],
                            base_z_a: top(i), base_z_b: top(i + 1),
                            height_agl: 0.0,
                        });
                    }
                    // Finite screens diffract around their two ends (§7.4.3);
                    // the vertical edge spans the real ground base to the crest.
                    for v in [0, polyline.len() - 1] {
                        lateral.push(LateralEdge {
                            e: polyline[v][0], n: polyline[v][1],
                            base_z: base_z[v], top_z: top(v),
                        });
                    }
                }
                Obstacle::Building { footprint, base_z, height_agl } => {
                    // Each footprint edge is a wall (implicitly closed loop). A
                    // ray crossing the footprint hits two edges → multi-edge
                    // over-the-roof diffraction. The around-the-side diffraction
                    // wraps the taut string around the corners of each side —
                    // emitted once as a FootprintLateral (NOT per-vertex single
                    // edges, which underestimate the detour; ISO/TR 17534-3 T11).
                    let n = footprint.len();
                    for i in 0..n {
                        let a = footprint[i];
                        let b = footprint[(i + 1) % n];
                        walls.push(WallBarrier {
                            a_e: a[0], a_n: a[1], b_e: b[0], b_n: b[1],
                            base_z_a: *base_z, base_z_b: *base_z, height_agl: *height_agl,
                        });
                    }
                    footprints.push(FootprintLateral {
                        verts: footprint.iter().map(|p| (p[0], p[1])).collect(),
                        base_z: *base_z,
                        top_z: base_z + height_agl,
                    });
                }
            }
        }
        (walls, lateral, footprints)
    }
}

/// All ordered reflector sequences of length 2..=`max_order` from `m` reflectors,
/// with no immediate repeat (a ray can't bounce off the same facade twice in a
/// row). Drives the higher-order reflection search (§7.5.3).
fn reflection_sequences(m: usize, max_order: usize) -> Vec<Vec<usize>> {
    fn rec(m: usize, max_order: usize, cur: &mut Vec<usize>, out: &mut Vec<Vec<usize>>) {
        if cur.len() >= 2 {
            out.push(cur.clone());
        }
        if cur.len() == max_order {
            return;
        }
        for i in 0..m {
            if cur.last() == Some(&i) {
                continue;
            }
            cur.push(i);
            rec(m, max_order, cur, out);
            cur.pop();
        }
    }
    let mut out = Vec::new();
    rec(m, max_order, &mut Vec::new(), &mut out);
    out
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

/// Fraction (0…1) of the S→R plan segment that lies inside `poly`. Partitions
/// the segment at its polygon-edge crossings and inside-tests each sub-segment's
/// midpoint — exact for arbitrary simple polygons (convex or not).
fn segment_fraction_in_polygon(s: [f64; 2], r: [f64; 2], poly: &[[f64; 2]]) -> f64 {
    let n = poly.len();
    if n < 3 {
        return 0.0;
    }
    let (dx, dy) = (r[0] - s[0], r[1] - s[1]);
    if dx.abs() < 1e-12 && dy.abs() < 1e-12 {
        return 0.0;
    }
    // Break points along t ∈ [0, 1]: endpoints + every edge crossing.
    let mut ts = vec![0.0f64, 1.0];
    for i in 0..n {
        let a = poly[i];
        let b = poly[(i + 1) % n];
        let (ex, ey) = (b[0] - a[0], b[1] - a[1]);
        let det = ex * dy - ey * dx; // cross(E, D)
        if det.abs() < 1e-12 {
            continue; // parallel / degenerate edge
        }
        let (wx, wy) = (a[0] - s[0], a[1] - s[1]);
        let t = (ex * wy - ey * wx) / det; // param along S→R
        let u = (dx * wy - dy * wx) / det; // param along the edge
        if (0.0..=1.0).contains(&t) && (0.0..=1.0).contains(&u) {
            ts.push(t);
        }
    }
    ts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut frac = 0.0;
    for w in ts.windows(2) {
        let mid = 0.5 * (w[0] + w[1]);
        let p = [s[0] + mid * dx, s[1] + mid * dy];
        if point_in_polygon(p, poly) {
            frac += w[1] - w[0];
        }
    }
    frac
}

/// Annex A `Amisc` per band (dB, to be SUBTRACTED) for one source→receiver path.
/// `slant` is the 3D ray length; the plan-path fraction crossing each region
/// scales it to a slant path length. Foliage/site are per-octave; housing is
/// frequency-independent (added to every band), the total capped at 10 dB.
///
/// The `Afol`/`Asite` kernels are the Annex A OCTAVE tables (10 bands). For a
/// one-third-octave scene, per-octave-band Amisc mapping is a later refinement,
/// so only the frequency-independent housing term is applied there for now.
fn amisc_spectrum(
    amisc: &Amisc,
    s: [f64; 2],
    r: [f64; 2],
    slant: f64,
    system: BandSystem,
) -> BandSpectrum {
    let mut out = BandSpectrum::zeros(system);
    if amisc.is_empty() || slant <= 0.0 {
        return out;
    }
    let path_len = |poly: &[[f64; 2]]| segment_fraction_in_polygon(s, r, poly) * slant;
    let ahous: f64 = amisc
        .housing
        .iter()
        .map(|h| misc::ahous(h.b_density, path_len(&h.polygon), h.facade_pct))
        .sum::<f64>()
        .min(10.0);

    // Octave-only foliage/site tables. Non-octave scenes get housing only.
    if system.n_bands() != 10 {
        for b in 0..system.n_bands() {
            out.bands[b] = ahous;
        }
        return out;
    }

    let df: f64 = amisc.foliage.iter().map(|f| path_len(&f.polygon)).sum();
    let ds: f64 = amisc.site.iter().map(|z| path_len(&z.polygon)).sum();
    let afol = misc::afol(df);
    let asite = misc::asite(ds);
    for b in 0..10 {
        out.bands[b] = afol[b] + asite[b] + ahous;
    }
    out
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
    let (walls, lateral, footprints) = scene.barriers();
    let g = scene.ground.default_g;

    // Edition dispatch (once) — general sources score through the standard's
    // evaluator; WTG sources always use Annex D (2024-only), independent of the
    // selected edition (1996 has no wind-turbine annex). `+ Sync` lets the
    // per-receiver closure run on a rayon worker pool under the `parallel`
    // feature (the unit-struct evaluators are trivially Sync).
    let model: &(dyn StandardModel + Sync) = match scene.standard {
        Standard::Iso9613_2_1996 => &Iso1996,
        Standard::Iso9613_2_2024 => &Iso2024,
    };

    // Each receiver is an independent, read-only-over-`scene` computation — the
    // natural parallelism unit. Bound once so the serial and rayon paths share
    // one body.
    let compute = |rx: &Receiver| -> ReceiverResult {
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
                let terrain_edges = scene
                    .terrain
                    .as_ref()
                    .map(|t| t.profile_edges([s.e, s.n], [r.e, r.n]))
                    .unwrap_or_default();
                // Simplified method over terrain: mean height from the profile.
                let hm_override = if matches!(scene.settings.ground_method, GroundMethod::Simplified) {
                    scene.terrain.as_ref().map(|t| t.mean_height([s.e, s.n], [r.e, r.n], s.z, r.z))
                } else {
                    None
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
                        terrain_edges: &terrain_edges,
                        footprints: &footprints,
                        dz_cap: scene.settings.dz_cap_db,
                        atm,
                        ground_method: scene.settings.ground_method,
                        hm_override,
                    }),
                    SourceKind::WindTurbine { rotor_diameter_m, apply_concave } => annex_d::evaluate_wtg(
                        &lw, s, r, src.height_agl, rx.height_agl, g, &walls, &lateral,
                        WtgRules::default(), *apply_concave, *rotor_diameter_m, atm,
                    ),
                };

                // Annex A Amisc (foliage / industrial / housing) on the direct
                // path. Reflected-path Amisc is deferred (distinct geometry).
                let mut bands: Vec<f64> = lp.bands.iter().copied().collect();
                if !scene.amisc.is_empty() && matches!(src.kind, SourceKind::General) {
                    let slant = r.sub(s).length();
                    let am = amisc_spectrum(&scene.amisc, [s.e, s.n], [r.e, r.n], slant, system);
                    for (b, a) in bands.iter_mut().zip(am.bands.iter()) {
                        *b -= a;
                    }
                }

                // §7.5 first-order reflections (general sources): each valid
                // facade adds an image-source contribution, energy-summed with
                // the direct path per band (gated by the Fresnel size validity).
                if matches!(src.kind, SourceKind::General) && !scene.reflectors.is_empty() {
                    let centres = system.centres_exact();
                    for reflector in &scene.reflectors {
                        let facade = reflection::Facade {
                            a: reflector.segment[0], b: reflector.segment[1],
                            base_z: reflector.base_z, top_z: reflector.top_z, alpha: reflector.alpha,
                        };
                        let Some(refl) = reflection::reflect(s, r, &facade) else { continue };
                        // Per-band reflection loss 10·lg(1−α); α may vary by band.
                        let img_lw = BandSpectrum::from_iter(
                            system,
                            src.lw.iter().enumerate().map(|(b, &x)| {
                                let alpha = reflector
                                    .alpha_bands
                                    .as_ref()
                                    .and_then(|ab| ab.get(b).copied())
                                    .unwrap_or(reflector.alpha);
                                x + 10.0 * (1.0 - alpha).max(1e-12).log10()
                            }),
                        );
                        let refl_lp = model.evaluate_general(&GeneralEval {
                            lw: &img_lw, source: refl.image_source, receiver: r,
                            h_s: src.height_agl, h_r: rx.height_agl,
                            g_source, g_middle, g_receiver,
                            barriers: &walls, lateral: &lateral,
                            // Terrain screening + building wraps of the reflected
                            // ray (a distinct image→R profile) are deferred; the
                            // direct path dominates in practice.
                            terrain_edges: &[],
                            footprints: &[],
                            dz_cap: scene.settings.dz_cap_db, atm,
                            ground_method: scene.settings.ground_method,
                            hm_override,
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

                // §7.5.3 higher-order reflections (2024): multi-bounce image
                // sources between (nearly) parallel or surrounding reflectors.
                let max_order = scene.settings.max_reflection_order.max(1) as usize;
                if matches!(src.kind, SourceKind::General) && max_order >= 2 && scene.reflectors.len() >= 2 {
                    let lambdas: Vec<f64> =
                        system.centres_exact().iter().map(|c| 340.0 / c).collect();
                    let facades: Vec<reflection::Facade> = scene
                        .reflectors
                        .iter()
                        .map(|refl| reflection::Facade {
                            a: refl.segment[0], b: refl.segment[1],
                            base_z: refl.base_z, top_z: refl.top_z, alpha: refl.alpha,
                        })
                        .collect();
                    for seq in reflection_sequences(scene.reflectors.len(), max_order) {
                        let seq_facades: Vec<reflection::Facade> =
                            seq.iter().map(|&i| facades[i]).collect();
                        let Some((chain, valid)) =
                            reflection::reflect_chain(s, r, &seq_facades, &lambdas)
                        else {
                            continue;
                        };
                        // Image LW = LW + Σ per-band reflection losses of the chain.
                        let img_lw = BandSpectrum::from_iter(
                            system,
                            (0..system.n_bands()).map(|b| {
                                let loss: f64 = seq
                                    .iter()
                                    .map(|&i| {
                                        let a = scene.reflectors[i]
                                            .alpha_bands
                                            .as_ref()
                                            .and_then(|ab| ab.get(b).copied())
                                            .unwrap_or(scene.reflectors[i].alpha);
                                        10.0 * (1.0 - a).max(1e-12).log10()
                                    })
                                    .sum();
                                src.lw[b] + loss
                            }),
                        );
                        let refl_lp = model.evaluate_general(&GeneralEval {
                            lw: &img_lw, source: chain.image_source, receiver: r,
                            h_s: src.height_agl, h_r: rx.height_agl,
                            g_source, g_middle, g_receiver,
                            barriers: &walls, lateral: &lateral,
                            terrain_edges: &[], footprints: &[],
                            dz_cap: scene.settings.dz_cap_db, atm,
                            ground_method: scene.settings.ground_method, hm_override,
                        });
                        for b in 0..system.n_bands() {
                            if valid[b] {
                                bands[b] = 10.0
                                    * (10f64.powf(0.1 * bands[b]) + 10f64.powf(0.1 * refl_lp.bands[b])).log10();
                            }
                        }
                    }
                }

                // §7.5.4 cylindrical reflections (2024): tangent-plane reflection
                // weakened by the curvature attenuation Acurv (first order only).
                if matches!(src.kind, SourceKind::General) && !scene.cylinders.is_empty() {
                    let lambdas: Vec<f64> =
                        system.centres_exact().iter().map(|c| 340.0 / c).collect();
                    for cyl in &scene.cylinders {
                        let c = reflection::Cylinder {
                            centre: cyl.centre, radius: cyl.radius,
                            base_z: cyl.base_z, top_z: cyl.top_z, alpha: cyl.alpha,
                        };
                        let Some(cr) = reflection::reflect_cylinder(s, r, &c, &lambdas) else {
                            continue;
                        };
                        let img_lw = BandSpectrum::from_iter(
                            system,
                            src.lw.iter().enumerate().map(|(b, &x)| {
                                let alpha = cyl
                                    .alpha_bands
                                    .as_ref()
                                    .and_then(|ab| ab.get(b).copied())
                                    .unwrap_or(cyl.alpha);
                                x + 10.0 * (1.0 - alpha).max(1e-12).log10() - cr.a_curv
                            }),
                        );
                        let refl_lp = model.evaluate_general(&GeneralEval {
                            lw: &img_lw, source: cr.image_source, receiver: r,
                            h_s: src.height_agl, h_r: rx.height_agl,
                            g_source, g_middle, g_receiver,
                            barriers: &walls, lateral: &lateral,
                            terrain_edges: &[], footprints: &[],
                            dz_cap: scene.settings.dz_cap_db, atm,
                            ground_method: scene.settings.ground_method, hm_override,
                        });
                        for ((band, &v), &rl) in bands
                            .iter_mut()
                            .zip(cr.valid.iter())
                            .zip(refl_lp.bands.iter())
                        {
                            if v {
                                *band = 10.0
                                    * (10f64.powf(0.1 * *band) + 10f64.powf(0.1 * rl)).log10();
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
                    let terrain_edges = scene
                        .terrain
                        .as_ref()
                        .map(|t| t.profile_edges([ss.e, ss.n], [r.e, r.n]))
                        .unwrap_or_default();
                    let lp = model.evaluate_general(&GeneralEval {
                        lw: &lw_sub, source: ss, receiver: r,
                        h_s: ext.height_agl, h_r: rx.height_agl,
                        g_source: gs, g_middle: gm, g_receiver: gr,
                        barriers: &walls, lateral: &lateral,
                        terrain_edges: &terrain_edges,
                        footprints: &footprints,
                        dz_cap: scene.settings.dz_cap_db, atm,
                        ground_method: scene.settings.ground_method,
                        hm_override: if matches!(scene.settings.ground_method, GroundMethod::Simplified) {
                            scene.terrain.as_ref().map(|t| t.mean_height([ss.e, ss.n], [r.e, r.n], ss.z, r.z))
                        } else { None },
                    });
                    let dp = ((r.e - ss.e).powi(2) + (r.n - ss.n).powi(2)).sqrt();
                    let cmet = cmet_db(scene.settings.c0_db, ext.height_agl, rx.height_agl, dp);
                    let am = if scene.amisc.is_empty() {
                        BandSpectrum::zeros(system)
                    } else {
                        amisc_spectrum(&scene.amisc, [ss.e, ss.n], [r.e, r.n], r.sub(ss).length(), system)
                    };
                    for (i, (a, &b)) in acc.iter_mut().zip(lp.bands.iter()).enumerate() {
                        *a = 10.0 * (10f64.powf(0.1 * *a) + 10f64.powf(0.1 * (b - cmet - am.bands[i]))).log10();
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
    };

    // Fan out over receivers. The rayon pool is configured by `solve_par`; a
    // bare `solve()` under the feature uses rayon's global pool (all cores).
    #[cfg(feature = "parallel")]
    let per_receiver: Vec<ReceiverResult> = {
        use rayon::prelude::*;
        scene.receivers.par_iter().map(compute).collect()
    };
    #[cfg(not(feature = "parallel"))]
    let per_receiver: Vec<ReceiverResult> = scene.receivers.iter().map(compute).collect();

    Ok(Results { per_receiver })
}

/// Multithreaded solve with an explicit concurrency budget (native only).
///
/// `max_threads` caps the rayon worker count for THIS solve: `0` uses all
/// logical cores (100 % of the machine); a smaller value leaves headroom so an
/// interactive host (e.g. a web backend) stays responsive. Runs on a private
/// pool, so it never disturbs rayon's global pool or other solves.
#[cfg(feature = "parallel")]
pub fn solve_par(scene: &Scene, max_threads: usize) -> Result<Results, SceneError> {
    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(max_threads) // 0 ⇒ rayon default (all logical cores)
        .build()
        .map_err(|_| SceneError::StandardNotImplemented("rayon thread pool"))?;
    pool.install(|| solve(scene))
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
            terrain: None,
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
            cylinders: vec![],
            amisc: Amisc::default(),
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
            top_z: None,
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
            top_z: None,
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

    /// The multithreaded solve must be bit-for-bit identical to the serial one,
    /// regardless of thread count (results collected in receiver order).
    #[cfg(feature = "parallel")]
    #[test]
    fn solve_par_matches_serial_bit_for_bit() {
        let mut scene = basic_scene();
        scene.obstacles.push(Obstacle::Wall {
            polyline: vec![[100.0, -50.0], [100.0, 50.0]],
            base_z: vec![0.0, 0.0],
            height_agl: 8.0,
            top_z: None,
        });
        // A grid of receivers so the fan-out actually has work to split.
        scene.receivers = (0..200)
            .map(|i| Receiver {
                id: format!("r{i}"),
                position: [150.0 + i as f64, (i as f64 * 0.5) - 50.0, 1.5],
                height_agl: 1.5,
            })
            .collect();

        let serial = solve(&scene).unwrap();
        for threads in [0usize, 1, 4] {
            let par = solve_par(&scene, threads).unwrap();
            assert_eq!(par.per_receiver.len(), serial.per_receiver.len());
            for (a, b) in par.per_receiver.iter().zip(&serial.per_receiver) {
                assert_eq!(a.receiver_id, b.receiver_id, "order preserved");
                assert_eq!(a.total_dba, b.total_dba, "identical total (threads={threads})");
                for (x, y) in a.per_source[0].bands.iter().zip(&b.per_source[0].bands) {
                    assert_eq!(x, y, "identical per-band (threads={threads})");
                }
            }
        }
    }
}

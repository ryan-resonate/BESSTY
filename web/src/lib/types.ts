// Mirrors docs/firestore-schema.md.

export type BandSystem = 'octave' | 'oneThirdOctave';

export type SourceKind = 'wtg' | 'bess' | 'auxiliary';

/// Where the source's catalog entry lives.
///   - 'global'   — shared library at `catalogsGlobal/{id}`, any signed-in
///                  user can read/write.
///   - 'local'    — embedded on the project doc (`project.localCatalog`),
///                  scoped to this project; visible to all collaborators.
///   - 'personal' — per-user library at `users/{uid}/catalogs/{id}`,
///                  only the owning user can read. Sources that reference
///                  a personal entry will resolve for the owner; for other
///                  users opening the same project the lookup returns null
///                  and the UI surfaces a "missing entry" warning. Useful
///                  for solo projects or as a staging area before
///                  promoting an entry to global/local.
export type CatalogScope = 'global' | 'local' | 'personal';

export interface ProjectSummary {
  id: string;
  name: string;
  description?: string;
  updatedAt: string;       // ISO 8601
  sourceCount?: number;
  receiverCount?: number;
}

export interface Scenario {
  windSpeed: number;
  windSpeedReferenceHeight: number;
  period: 'day' | 'evening' | 'night';
  bandSystem: BandSystem;
}

export interface Source {
  id: string;
  kind: SourceKind;
  name: string;
  latLng: [number, number];
  /// Reference to a CatalogEntry. The same id may exist in both scopes
  /// (e.g. a local copy of a global entry); `catalogScope` disambiguates.
  modelId: string;
  catalogScope: CatalogScope;
  hubHeight?: number;          // WTG only
  /// Per-source override of the rotor diameter (m). When set, takes
  /// precedence over the catalog entry's `rotorDiameterM` for the Annex
  /// D.3 elevated-source-for-barrier rule (source z = hub + rotor/2).
  /// Leave undefined to inherit from the catalog model. WTG only.
  rotorDiameterM?: number;
  elevationOffset?: number;    // BESS / Auxiliary
  yawDeg?: number;
  /// Per-source container overrides (BESS / auxiliary). Dimensions default to
  /// the catalog product's `footprintM` + `containerHeightM`; set any field here
  /// to override for this unit. `enabled: false` opts one unit out entirely.
  ///
  /// Orientation comes from `yawDeg` (the row heading) when the source belongs
  /// to a group; `bearingDeg` is the fallback for standalone units.
  container?: {
    enabled?: boolean;
    lengthM?: number;
    widthM?: number;
    heightM?: number;
    bearingDeg?: number;
  };
  modeOverride?: string | null;
  /// When this source belongs to a BessGroup, the group's id. Lets the
  /// editor select the whole group on click, route drag events through
  /// the group's centre handle, and recolour group members on the map.
  /// Standalone (non-grouped) sources omit this.
  groupId?: string;
  /// Stable slot identifier within the parent group, of the form
  /// `r<rowIdx>-c<rowCopyIdx>-p<patternCopyIdx>-u<unitIdx>`. The
  /// materialiser uses this to map hand-edits back to the right unit
  /// when the user changes a group's parameters and we regenerate.
  /// Set together with `groupId`; meaningless otherwise.
  slotKey?: string;
}

// =================== BESS groups (parametric arrays) ===================

/// A parametric BESS / auxiliary array. Stores the layout RECIPE; the
/// individual units are materialised into the project's flat `sources`
/// list (tagged with `groupId` + `slotKey`) so the solver / drag /
/// selection code can treat them as ordinary sources.
///
/// Editing flow: user opens the wizard, tweaks parameters, hits Apply.
/// `materialiseBessGroup` regenerates the slot table; per-slot
/// `unitOverrides` are re-applied so hand-edits survive.
/// ===== Recursive sequence model (supersedes the flat rows[] layout) =====
///
/// A group's content is an ordered list of items, each either a single row or
/// a nested repeat-group. Each repeat-group tiles its content in 2-D: `down`
/// copies stacked vertically (more rows) and `right` copies along the row
/// direction. The whole `BessGroup` is the implicit outermost group, with its
/// own top-level 2-D repeat (`repeatDown`/`repeatRight`).
///
/// Only groups that carry a `sequence` use this path; legacy `rows`-based
/// groups keep the original flat materialiser untouched (so existing layouts
/// and per-unit overrides are unaffected) until converted in the wizard.
export type BessSeqItem = BessRowItem | BessGroupItem;

export interface BessRowItem {
  kind: 'row';
  /// Stable id for this item (drives slot keys + drag identity).
  id: string;
  /// The row content (segments). `rowRepeat` is NOT used here — repeating a
  /// row is expressed by wrapping it in a group with `repeatDown > 1`.
  row: BessRow;
  /// Edge-to-edge gap (m) to the next sibling item. Ignored for the last item.
  gapAfterM: number;
}

export interface BessGroupItem {
  kind: 'group';
  id: string;
  /// Optional label shown on the group header.
  name?: string;
  /// Vertical replication: `repeatDown` copies of the group's content stacked
  /// top-to-bottom, `gapDownM` between copies. 1 = no vertical tiling.
  repeatDown: number;
  gapDownM: number;
  /// Horizontal replication: `repeatRight` copies along the row direction,
  /// `gapRightM` between copies. 1 = no horizontal tiling.
  repeatRight: number;
  gapRightM: number;
  /// Edge-to-edge gap (m) to the next sibling item.
  gapAfterM: number;
  /// Recursive content — rows and/or nested groups.
  items: BessSeqItem[];
}

export interface BessGroup {
  id: string;
  name: string;
  /// Geographic centre of the unrotated group's bounding box.
  /// The on-map centre handle drags this; everything else is derived.
  centerLatLng: [number, number];
  /// Clockwise from north, in degrees.
  rotationDeg: number;
  /// Recursive sequence content. When present this is the source of truth and
  /// the flat `rows`/`sequenceRepeat`/`interRowGapsM` fields are ignored.
  sequence?: BessSeqItem[];
  /// Top-level 2-D repeat of the whole sequence (the "Repeat whole sequence"
  /// control). `repeatDown` subsumes the legacy `sequenceRepeat`.
  repeatDown?: number;
  gapDownM?: number;
  repeatRight?: number;
  gapRightM?: number;
  rows: BessRow[];
  /// Inter-row-template gaps (m, edge-to-edge), rendered in the wizard
  /// as editable controls between the row cards. Length is
  /// `rows.length - 1` -- entry `i` is the gap from row `i` to row
  /// `i+1`. (The gap between rowRepeat copies of the SAME template
  /// lives on `BessRow.gapBetweenCopiesM`.)
  /// Auto-padded to the right length on read; trailing entries are
  /// dropped on save when rows are removed.
  interRowGapsM?: number[];
  /// "Repeat row sequence × N" -- stamps the ENTIRE row sequence
  /// (rows[] in order, with their interRowGapsM[] between them) N
  /// times top-to-bottom. Different from the per-row rowRepeat:
  /// that one stamps a single row template N times; this one stamps
  /// the whole sequence. Defaults to 1 (no extra stamping).
  sequenceRepeat?: number;
  /// Edge-to-edge gap (m) between adjacent copies of the row
  /// sequence when sequenceRepeat > 1. Defaults to 5 m.
  gapBetweenSequencesM?: number;
  /// Per-slot user overrides preserved across re-materialisation
  /// (e.g. one BESS dragged 3 m east for fence clearance). Slot keys
  /// match the format on the materialised Source's `slotKey` field.
  /// Slots that no longer exist after a parameter change are dropped
  /// silently -- the wizard surfaces a "N overrides discarded" notice
  /// before Apply so the user can review.
  unitOverrides?: Record<string, BessUnitOverride>;
}

/// A row template. Stamped `rowRepeat` times top-to-bottom, with
/// `gapBetweenCopiesM` between copies. The gap to the NEXT row
/// template is on `BessGroup.interRowGapsM` (so it's editable as a
/// distinct UI element between cards rather than buried inside a row).
export interface BessRow {
  id: string;
  /// Ordered list of segments. A row of "8 BESS @1.5m then a 3 m
  /// gap then 1 inverter" is two segments: BESS×8 with gapAfterM=3,
  /// then Inverter×1 with gapAfterM=0. An empty `segments` array
  /// makes the row a pure spacer.
  segments: BessSegment[];
  /// Repeats the entire segment sequence WITHIN one physical row.
  /// E.g. segments=[BESS×8, INV×1] with segmentSequenceRepeat=3 gives
  /// [BESS×8 INV BESS×8 INV BESS×8 INV] all in one row, with
  /// `gapBetweenSegmentSequencesM` between each repeat. Distinct from
  /// the group-level `BessGroup.sequenceRepeat` which repeats the
  /// entire row sequence top-to-bottom. Default 1.
  segmentSequenceRepeat?: number;
  /// Edge-to-edge gap (m) between adjacent copies of the segment
  /// sequence when segmentSequenceRepeat > 1. Defaults to the last
  /// segment's gapAfterM (if any) or 3 m. Ignored when
  /// segmentSequenceRepeat <= 1.
  gapBetweenSegmentSequencesM?: number;
  /// How many copies of this row template are stamped, top-to-bottom.
  /// Copies are separated by `gapBetweenCopiesM`.
  rowRepeat: number;
  /// Edge-to-edge gap between rowRepeat copies of THIS template.
  /// (Distinct from the inter-template gap on the parent group.)
  /// Ignored when rowRepeat <= 1.
  gapBetweenCopiesM: number;
  /// Horizontal alignment of this row within the group's overall
  /// bounding box (the base sequence block, BEFORE the top-level
  /// whole-sequence repeat, but INCLUDING any nested groups). The box
  /// width is the widest row anywhere in the group.
  ///   'left'   → row's left edge at the box left edge (the default; how
  ///              every row behaved before this field existed).
  ///   'center' → row centred in the box.
  ///   'right'  → row's right edge flush with the box right edge.
  /// Absent = 'left'.
  align?: 'left' | 'center' | 'right';
  /// Signed horizontal nudge (m) applied AFTER `align`: +ve shifts the
  /// row right (east in the group's local frame), -ve shifts it left.
  /// e.g. align:'right', alignOffsetM:-5 sits the row 5 m inside the
  /// box's right edge. Absent = 0.
  alignOffsetM?: number;

  // ===== Legacy fields, kept for backward-compat read-side only =====
  // Older projects stored a flat unit pattern + uniform spacing. We
  // migrate to segments on load (see `migrateLegacyRow`). The legacy
  // fields are typed optional here so old data parses cleanly; new
  // code paths shouldn't write them.
  pattern?: BessRowUnit[];
  patternRepeat?: number;
  spacingWithinM?: number;
  gapToNextRowM?: number;
}

/// One contiguous run of the same unit type within a row.
export interface BessSegment {
  id: string;
  /// Catalog reference (BESS or auxiliary -- WTGs aren't grouped).
  catalogScope: CatalogScope;
  modelId: string;
  /// Optional per-segment mode override (e.g. "PO4500-low-noise" on
  /// a row of BESS in night mode). Inherits the catalog entry's
  /// `defaultMode` when undefined.
  modeOverride?: string | null;
  /// How many units in this segment.
  count: number;
  /// Edge-to-edge gap between consecutive units WITHIN this segment.
  spacingWithinM: number;
  /// Edge-to-edge gap between this segment's last unit and the next
  /// segment's first unit. Ignored for the row's final segment.
  gapAfterM: number;
  /// Rotation of each unit in this segment, in degrees clockwise, added on
  /// top of the group rotation. 0 = long axis along the row; 90 = long axis
  /// across the row ("standing on end"). Any value is allowed (packing uses
  /// the rotated bounding box) but 0 and 90 are the common cases. Replaces the
  /// legacy `orientation` toggle; when absent it's derived from `orientation`
  /// (across → 90, along → 0).
  rotationDeg?: number;
  /// How units sit across the row's depth band when units in the row have
  /// different depths (mixed models / rotations): 'top' aligns their top
  /// edges, 'middle' centres them, 'bottom' aligns their bottom edges.
  /// Defaults to 'middle'. Set per-segment so e.g. inverters can bottom-align
  /// while the BESS they punctuate stay centred.
  alignment?: 'top' | 'middle' | 'bottom';
  /// Legacy binary orientation, kept so older projects round-trip. New code
  /// reads `rotationDeg`/`alignment` (with this as the fallback).
  orientation?: 'along' | 'across';
}

// Legacy unit reference (pre-segment model). Kept so old projects
// round-trip cleanly through migrateLegacyRow. New code uses BessSegment.
export interface BessRowUnit {
  catalogScope: CatalogScope;
  modelId: string;
}

export interface BessUnitOverride {
  /// dLat / dLng offset from the materialised position (degrees).
  latLngDelta?: [number, number];
  /// Per-unit model swap (e.g. one slot has a different BESS model).
  modelOverride?: { catalogScope: CatalogScope; modelId: string };
  /// Per-unit mode override.
  modeOverride?: string | null;
  /// Per-unit height-above-ground override.
  elevationOffset?: number;
}

export interface Barrier {
  id: string;
  name: string;
  type: 'wall';
  polylineLatLng: Array<[number, number]>;
  topHeightsM: number[];
  baseFromGroundM: number;
  surfaceDensityKgM2: number;
  absorptionCoeff: number;
}

export type Period = 'day' | 'evening' | 'night';

export interface Receiver {
  id: string;
  name: string;
  latLng: [number, number];
  heightAboveGroundM: number;
  /// Period-specific limits in dB(A). The active limit is the one matching
  /// the project's `scenario.period`.
  limitDayDbA: number;
  limitEveningDbA: number;
  limitNightDbA: number;
  /// Legacy aggregate limit, kept for compatibility with v0.x projects that
  /// only had a single limit field. Migration backfills the per-period limits
  /// to match this value when reading old projects.
  limitDbA?: number;
  period?: Period;     // legacy — period now lives on the project scenario
}

/// A project's settings with the historical defaults filled in for anything
/// absent. `Project.settings` is optional and old documents predate several
/// fields, so every reader needs the same fallback — duplicating the literal
/// is how two call sites end up disagreeing about what "default" means.
export function settingsOf(project: Project): ProjectSettings {
  return project.settings ?? {
    ground: { defaultG: 0.5 },
    annexD: {
      barrierAbarCapDb: 3.0,
      useElevatedSourceForBarrier: true,
      applyConcaveCorrection: true,
      wtReceiverHeightMin: 4.0,
    },
    general: { defaultReceiverHeight: 1.5 },
  };
}

/// Pick the right limit for a receiver given the active scenario period.
export function limitForPeriod(r: Receiver, period: Period): number {
  switch (period) {
    case 'day':     return r.limitDayDbA ?? r.limitDbA ?? 40;
    case 'evening': return r.limitEveningDbA ?? r.limitDbA ?? 40;
    case 'night':   return r.limitNightDbA ?? r.limitDbA ?? 40;
  }
}

export interface CalculationArea {
  centerLatLng: [number, number];
  widthM: number;
  heightM: number;
  rotationDeg: number;
}

/// How the project was last being LOOKED at (I19). Purely presentational —
/// nothing here reaches the solver, and every field is optional so a project
/// saved before this existed opens on today's defaults.
///
/// Persisted on the project rather than per user: reopening restores the view
/// you left, and a colleague opening the same project sees the same
/// presentation.
///
/// `showGridDebug` is deliberately absent — it's a diagnostic, and a project
/// that reopens covered in pink dots looks broken.
export interface DisplaySettings {
  baseMap?: 'satellite' | 'osm';
  showContours?: boolean;
  contourMode?: 'filled' | 'lines' | 'both';
  contourOpacity?: number;
  contourStepDb?: number;
  contourBounds?: { min: number; max: number; step: number };
  palette?: string;
  domainMode?: 'auto' | 'fixed';
  fixedDomain?: { min: number; max: number };
  showReceiverLimits?: boolean;
  gridSpacingM?: number;
  /// Whether the user has explicitly chosen a grid spacing. Persisted so
  /// reopening doesn't re-run the auto-pick over a deliberate choice.
  gridSpacingTouched?: boolean;
}

export interface ProjectSettings {
  ground: { defaultG: number };
  /// Presentational state — see `DisplaySettings`. Never affects computed levels.
  display?: DisplaySettings;
  /// I18 — specular reflections off barriers and source containers.
  ///
  /// Absent ⇒ OFF everywhere, so existing projects keep their current levels
  /// until this is deliberately switched on.
  ///
  /// Point receivers and the contour grid toggle independently: a grid re-culls
  /// reflectors per tile and pays for it at every cell.
  reflections?: {
    receiverCalc?: boolean;
    grid?: boolean;
    /// Requested specular order, 1–3. Degraded automatically when the reflector
    /// count would exceed the engine's path-enumeration guard.
    maxOrder?: number;
  };
  /// How a computed level is judged against a receiver's limit. Absent =
  /// `'integer'`: the level is rounded to the nearest integer first, so 40.4
  /// does NOT exceed a 40 dB limit. `'exact'` compares unrounded. See
  /// `lib/limits.ts` — every pass/fail site goes through `exceedsLimit`.
  limitComparison?: 'integer' | 'exact';
  /// Which edition of ISO 9613-2 the solver applies. Absent = `'2024'`, which
  /// is what every project computed with before the selector existed.
  ///
  /// The editions differ in the ground-effect geometry factor, the barrier `Dz`
  /// bracket and `Kmet`, and the 2024-only annexes; see
  /// `docs/iso9613-2-1996-vs-2024-differences.md`.
  standard?: '1996' | '2024';
  /// Model each BESS / auxiliary unit as its rectangular container (a screening
  /// box with the acoustic centre sitting just above the roof), rather than a
  /// bare point. Off by default.
  ///
  /// Point-receiver and grid/contour calculations toggle INDEPENDENTLY: a grid
  /// pays for the extra obstacles at every cell, so it's common to want the
  /// detail on reported receiver levels but not on a whole-site map.
  containers?: {
    /// Include containers when solving named point receivers.
    receiverCalc?: boolean;
    /// Include containers when solving the contour grid.
    grid?: boolean;
    /// Clearance of the acoustic centre above the container roof (m).
    /// The source must sit at or above the roof or the box would screen its own
    /// emission. Default 0.3.
    roofOffsetM?: number;
  };
  /// Frequency-independent corrections applied at every source, in the
  /// `Lp = Lw + DΩ + Dc − A` form of ISO 9613-2 §5 Eq (1).
  ///
  /// **DΩ — solid-angle / "directivity index" correction (dB):**
  ///   - `0` (default) — strict ISO 9613-2 / IEC 61400-11. Treats LwA
  ///     as already encoding the hemispherical radiation pattern (which
  ///     is how IEC 61400-11 reports it). Matches BESSTY's own
  ///     validation Case 5 number.
  ///   - `+3` — common practice in Australian / European wind-farm
  ///     spreadsheets and several commercial tools (CONCAWE, some
  ///     CadnaA / SoundPLAN setups). Reads as "the source radiates
  ///     into a hemisphere — apply the +3 dB ground-reflection boost
  ///     that ISO 9613-2 leaves out". Use this if your reference tool
  ///     sits ~3 dB above strict ISO output.
  ///
  /// Applied uniformly to every WTG / BESS / auxiliary source. There's
  /// no per-source override yet — set it once at the project level.
  dOmegaDb?: number;
  /// ISO 9613-2 §8 long-term meteorological correction. `Cmet = C0·[1 −
  /// 10(hs+hr)/dp]` (0 when dp ≤ 10(hs+hr)) is SUBTRACTED from the downwind
  /// level to give the long-term average. `c0Db` is the site-meteorology factor
  /// (dB, typically 0–5); default/absent = 0 = no correction (pure downwind,
  /// matching SoundPlan's default and the validation set).
  meteorology?: {
    c0Db: number;
  };
  annexD: {
    barrierAbarCapDb: number;
    useElevatedSourceForBarrier: boolean;
    applyConcaveCorrection: boolean;
    wtReceiverHeightMin: number;
  };
  /// Barrier-attenuation convention. Affects how Agr interacts with Abar
  /// per ISO 9613-2 §7.4.
  ///   - `'iso-eq16'` (default) — strict ISO 9613-2 Eq 16/17:
  ///     Abar = max(0, Dz − Agr) when both Agr > 0 and Dz > 0,
  ///     Abar = Dz otherwise (Agr added separately).
  ///   - `'dz-minus-max-agr-0'` — common practice variant:
  ///     Abar = Dz − max(Agr, 0). When Agr is negative (boost), this
  ///     keeps the boost AND the full Dz attenuation; when Agr is
  ///     positive, Abar absorbs Agr as in the ISO version.
  /// Both variants are implemented inside the WASM solver
  /// (`BarrierConvention` enum); this field selects which the project uses.
  /// Only relevant when barriers are present (or the DEM injects ridges
  /// as virtual barriers via the topography path).
  barrierConvention?: 'iso-eq16' | 'dz-minus-max-agr-0';
  /// Optional uniform per-band cap on Dz for general (non-WTG) sources.
  /// `null`/`undefined` = use the standard ISO §7.4 caps (20 dB single
  /// edge, 25 dB multi-edge); a finite non-negative value (e.g. 2)
  /// overrides them — useful when project rules limit credit for
  /// terrain / barrier diffraction. WTG sources continue to use
  /// `annexD.barrierAbarCapDb` (default 3 dB) and ignore this field.
  barrierDiffractionCapDb?: number | null;
  general: { defaultReceiverHeight: number };
  /// REMOVED: `extrapolation` caps. The Taylor-extrapolation-during-drag layer
  /// they governed no longer exists (drags simply re-solve), so the setting had
  /// no reader — it was UI for a knob connected to nothing. Old project
  /// documents may still carry the field; it is ignored.
  /// Distance-aware solver settings. Apply project-wide.
  propagation?: {
    /// Sources further than this from a receiver are skipped (treated as
    /// negligible contribution). Default 20 000 m. Set to 0 / negative to
    /// disable the cutoff entirely. No upper bound — the user can pin it
    /// to 0.1 m if they want to inspect a specific source-receiver pair.
    maxContributionDistanceM: number;
    /// Barnes-Hut tree acceptance parameter (s/d ratio threshold) for
    /// adaptive source clustering. Lower = more accurate but slower
    /// (recurses deeper into the tree). 0.5 keeps geometric error well
    /// under 1 dB; 0.3 is conservative; 1.0 is aggressive. Default 0.5.
    treeAcceptanceTheta: number;
    /// Legacy fields kept on disk for back-compat with v0.x projects.
    /// No longer consulted by the current Barnes-Hut path.
    clusterBeyondM?: number;
    maxClustersPerReceiver?: number;
  };
  /// Atmospheric conditions for ISO 9613-1 absorption (Aatm). When
  /// unset, the solver uses the ISO 9613-2 default reference of
  /// 10 °C, 70 % RH, 101.325 kPa. Setting these allows the user to
  /// match commercial tools that default to different conditions
  /// (e.g. 15 °C / 70 % RH for moderate-climate noise modelling).
  /// Threaded through to the WASM solver, which evaluates α(f) per
  /// band from first principles per ISO 9613-1 §8 + Annex E.
  atmosphere?: {
    temperatureC: number;
    relativeHumidityPct: number;
    pressureKpa?: number;
  };
  /// DEM-driven topography settings. Applies to point + grid solves.
  topography?: {
    /// @deprecated Sampling is now automatic at the DEM's native resolution
    /// (one sample per ~cell, capped), so there's no count to tune. Retained
    /// optional so old saved projects round-trip; ignored by the solver.
    pathSamples?: number;
    /// @deprecated Ridge selection is now the solver's own silhouette hull over
    /// the elevation raster, not a web-side pre-filter, so there is no
    /// prominence threshold to tune. Retained optional so old saved projects
    /// round-trip; ignored by the solver.
    virtualBarrierMinHeightM?: number;
    /// Peak-preserving DEM despike (Hampel filter) applied when the elevation
    /// raster is sampled. Removes isolated DEM blunders (single-cell spikes)
    /// without lowering genuine crests, since a rank filter only touches
    /// statistical outliers. 'off' disables it; 'low' clears egregious spikes
    /// only; 'medium' is more aggressive (use on noisy DEMs, not clean LiDAR).
    /// Default 'low'.
    despikeStrength?: 'off' | 'low' | 'medium';
  };
}

/// A named collection of source / receiver IDs. Groups exist purely as
/// editor-side affordances (selection shortcut, bulk edit, group-move) — the
/// solver doesn't see them. Members may be a mix of sources and receivers.
export interface Group {
  id: string;
  name: string;
  memberIds: string[];
  /// Display-only colour, used for the small ring around member markers.
  /// Hex string, e.g. '#3b82f6'.
  color?: string;
}

export interface Project {
  schemaVersion: number;
  name: string;
  description: string;
  createdAt: string;
  updatedAt: string;
  /// Legacy owner field, kept for compatibility with v0.x projects that
  /// predate Firebase auth. New projects set this to the email of the
  /// owning user; the canonical machine-readable owner identifier is
  /// `ownerUid` (Firebase UID). Either may be 'anonymous' on demo
  /// projects loaded from a non-Firebase context.
  owner: string;

  // --- Firestore-specific fields ---
  // These are populated when the project lives in Firestore. On the
  // local-storage code path (legacy / offline / unsigned-in) they may be
  // absent — consumers must handle undefined defensively.

  /// Firebase UID of the project owner. Always equal to the user who
  /// originally created the project; never changes (use a separate
  /// "transfer ownership" flow if/when that becomes needed).
  ownerUid?: string;
  /// Denormalised display name of the owner, used in the project list
  /// "Owner" column to avoid an N+1 read across every list row.
  /// Kept in sync best-effort when the owner edits their profile.
  ownerDisplayName?: string;
  /// 'public' — any signed-in user can read the project (write still
  /// restricted to owner + allowedUserIds + admins).
  /// 'private' — only owner + allowedUserIds + admins can even read.
  /// Default 'public' on creation.
  visibility?: 'public' | 'private';
  /// Additional users beyond the owner who can read/edit the project.
  /// Used both as the access list for private projects AND as the
  /// collaborator list for public projects (collaborators can still edit
  /// a public project; the public visibility only widens read access).
  allowedUserIds?: string[];
  /// Firebase UID of the last user to write the doc. Used by the
  /// real-time collab path to suppress echo notifications for the
  /// local user's own writes.
  updatedByUid?: string;

  scenario: Scenario;
  sources: Source[];
  barriers: Barrier[];
  receivers: Receiver[];
  groups?: Group[];
  /// Parametric BESS / aux arrays. Their materialised individual units
  /// also live in `sources` (flat list), tagged with `groupId` +
  /// `slotKey` so the solver, drag handlers, and selection code don't
  /// need to know about groups at all. Editing a group calls
  /// `materialiseBessGroup` which diffs against the current sources,
  /// preserving per-unit hand-edits (`unitOverrides`).
  bessGroups?: BessGroup[];
  calculationArea?: CalculationArea;
  settings?: ProjectSettings;
  /// Project-local catalog of source models. Independent of the global
  /// catalog: entries can be in either, both, or just one.
  localCatalog?: CatalogEntry[];

  /// User-uploaded DEM, persisted to Firebase Storage.
  ///
  /// When present, the project editor auto-downloads the file from
  /// Storage on open and parses it into a DemRaster (replacing the
  /// auto-loaded AWS Terrain Tiles for the area). When absent, the
  /// project falls back to AWS tiles.
  ///
  /// The raster bytes themselves are NEVER stored in the project doc --
  /// only this reference. Keeps the project under Firestore's 1 MB doc
  /// limit even for users who upload very detailed DEMs.
  dem?: {
    /// Path within the default Storage bucket.
    /// Format: `projects/{projectId}/dem/{timestamp}-{filename}`.
    storagePath: string;
    /// Original filename (e.g. "site-DEM-5m.tif"). For display only.
    filename: string;
    /// Original size in bytes. Used by the loading indicator + by the
    /// upload size cap (currently 200 MB).
    sizeBytes: number;
    /// EPSG override the user picked at upload time, if any. Replays
    /// the user's CRS choice when re-parsing -- otherwise we'd have to
    /// re-prompt every time the project opens.
    epsg?: number;
    uploadedAt: string;          // ISO 8601
    uploadedByUid: string;
  };

  /// Reference / annotation layers — purely visual map geometry (property
  /// boundaries, site context, access tracks). The solver NEVER reads these;
  /// they live outside `sources`/`barriers` so terrain/propagation can't be
  /// affected. Imported from shapefiles for now.
  referenceLayers?: ReferenceLayer[];
}

// =============== Reference (non-solver) layers ===============

export type ReferenceGeometryType = 'point' | 'line' | 'polygon';

export interface ReferenceFeature {
  id: string;
  type: ReferenceGeometryType;
  /// WGS84 vertices as [lat, lng] pairs:
  ///   point   → exactly one pair
  ///   line    → ordered vertices
  ///   polygon → ordered outer-ring vertices (auto-closed on render)
  coords: Array<[number, number]>;
  /// Optional label, e.g. mapped from a shapefile (.dbf) attribute.
  label?: string;
}

export type ReferencePointShape = 'circle' | 'square' | 'triangle';

export interface ReferenceLayerStyle {
  stroke: string;       // hex, e.g. "#2563EB"
  fill: string;         // hex (polygons + point shapes)
  weight: number;       // line/stroke width in px
  opacity: number;      // 0..1
  fillOpacity: number;  // 0..1 (polygons + point shapes)
  showLabels: boolean;
  /// Point rendering. Optional for back-compat with layers saved before these
  /// existed; readers default to 'circle' / 5 px.
  pointShape?: ReferencePointShape;
  pointSizePx?: number; // radius / half-extent in px
}

export interface ReferenceLayer {
  id: string;
  name: string;
  visible: boolean;
  /// 'vector' today. A future 'raster' kind (georeferenced geo-PDF / image,
  /// stored in Firebase Storage) plugs in here without reshaping the model.
  kind: 'vector';
  style: ReferenceLayerStyle;
  features: ReferenceFeature[];
}

export const DEFAULT_REFERENCE_STYLE: ReferenceLayerStyle = {
  stroke: '#2563EB',
  fill: '#2563EB',
  weight: 2,
  opacity: 0.95,
  fillOpacity: 0.12,
  showLabels: false,
  pointShape: 'circle',
  pointSizePx: 5,
};

// =================== Catalog ===================

export type CatalogBandSystem = 'octave' | 'oneThirdOctave';

export type SpectrumWeighting = 'A' | 'Z';

export interface CatalogModeData {
  /// Mode name from the source data (or 'default' / 'broadband').
  name: string;
  bandSystem: CatalogBandSystem;
  /// Frequency-weighting of the per-band Lw values stored in `spectra`:
  ///   - `'Z'` (default) — un-weighted sound power per band, the
  ///     ISO 9613-2 convention; values pass straight to the WASM solver.
  ///   - `'A'` — A-weighted per band (LwA per band). The catalog layer
  ///     converts to `Z` (un-weighted) before handing to the solver by
  ///     subtracting the IEC 61672-1 weighting offset for each band's
  ///     centre frequency. Common for IEC 61400-11 wind turbine reports
  ///     and ISO 3744 BESS / transformer datasheets.
  /// Missing field is treated as `'Z'` for backwards compatibility with
  /// projects saved before this distinction was introduced.
  weighting?: SpectrumWeighting;
  /// Frequency centres (Hz), ascending. Held verbatim from the source file
  /// — we do not strip out-of-range bands here so audit trail is preserved.
  frequencies: number[];
  /// Spectra keyed by wind speed (m/s @ 10 m, stringified). For sources with
  /// no wind dependence (BESS / Auxiliary), the single key 'broadband' is used.
  spectra: Record<string, number[]>;
  /// Wind speeds the spectra were defined for; empty for non-WTG.
  windSpeeds?: number[];
}

export interface CatalogEntry {
  id: string;
  kind: SourceKind;
  /// For auxiliary entries, free-text sub-label ("inverter" / "transformer" /
  /// "other"). Carried for display only — the solver treats all auxiliaries the same.
  auxiliaryType?: string;
  displayName: string;
  manufacturer?: string;
  /// Mode picked when none is specified on a Source.
  defaultMode: string;
  modes: CatalogModeData[];
  /// WTG-only.
  rotorDiameterM?: number;
  /// WTG-only — common installed hub heights (UI hint).
  hubHeights?: number[];
  /// Default source emission height above local ground (m). Used for
  /// the ISO 9613-2 source z passed to the solver:
  ///   - WTG: acts as the default hub height (overridden per-source
  ///     by `Source.hubHeight`; falls back to `hubHeights[0]` then 100 m).
  ///   - BESS / Auxiliary: replaces the previous hard-coded 1.5 m base.
  ///     `Source.elevationOffset` is added on top as a per-unit delta.
  /// Optional: when unset, the per-kind fallback (WTG 100 m hub,
  /// BESS / Aux 1.5 m base) is used so older catalog entries keep
  /// their existing behaviour.
  sourceHeightM?: number;
  /// Physical footprint of one unit (metres). Used by the BESS group
  /// materialiser to compute edge-to-edge spacing in metres -- without
  /// this, "1.5 m spacing" wouldn't know how wide a unit is to leave
  /// 1.5 m of clear gap. Optional because WTGs don't need it
  /// (rotorDiameterM serves the same purpose, and WTGs aren't grouped).
  /// Falls back to `defaultFootprintFor(kind)` when unset (see catalog.ts).
  footprintM?: { widthM: number; lengthM: number };
  /// Height of the unit's enclosure (m) — the container/cabinet body, NOT the
  /// acoustic-centre height (`sourceHeightM`). Only used when the unit is
  /// modelled as a screening box (see `ProjectSettings.containers`); the plan
  /// dimensions come from `footprintM`.
  /// Falls back to `containerHeightFor(kind)` when unset (BESS 2.6 m,
  /// auxiliary 2.2 m — see catalog.ts), exactly as `footprintM` does, so the
  /// containers setting applies to every unit rather than only to products
  /// whose catalog entry has been filled in.
  containerHeightM?: number;
  /// File of origin, for traceability ('imported from V163.xlsx').
  source?: string;
  /// 'seed' = bundled with the app on first launch; 'user' = user-added.
  origin: 'seed' | 'user';
}

export interface WtgCatalogEntry {
  modelId: string;
  displayName: string;
  rotorDiameterM: number;
  hubHeights: number[];
  modes: string[];
  defaultMode: string;
  spectrumAt(windSpeed: number, mode: string): Float64Array;
}

export interface GeneralCatalogEntry {
  modelId: string;
  displayName: string;
  modes: string[];
  defaultMode: string;
  spectrumFor(mode: string): Float64Array;
}

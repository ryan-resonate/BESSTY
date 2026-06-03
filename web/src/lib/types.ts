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
export interface BessGroup {
  id: string;
  name: string;
  /// Geographic centre of the unrotated group's bounding box.
  /// The on-map centre handle drags this; everything else is derived.
  centerLatLng: [number, number];
  /// Clockwise from north, in degrees.
  rotationDeg: number;
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

export interface ProjectSettings {
  ground: { defaultG: number };
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
  /// Limits on how far first-order Taylor extrapolation is allowed to push
  /// a per-band Lp value before forcing an exact re-snapshot. The clamp
  /// stops false high values from showing during long drags; the stale
  /// flag triggers a background recompute.
  extrapolation: {
    capPerBandDb: number;     // default 6 dB per octave band
    capTotalDbA: number;      // default 3 dB(A) on the per-receiver total
  };
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
    /// Sample the DEM at N evenly-spaced points along each source→receiver
    /// path and feed the mean ground height to the General-method ground
    /// attenuation. 0 disables (flat ground assumed). Default 12.
    pathSamples: number;
    /// When the DEM shows a ridge poking above the source-receiver line of
    /// sight by more than this many metres, treat it as a virtual barrier
    /// (Abar applies). Default 2 m.
    virtualBarrierMinHeightM: number;
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
}

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

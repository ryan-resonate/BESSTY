// Mirrors docs/firestore-schema.md.

export type BandSystem = 'octave' | 'oneThirdOctave';

export type SourceKind = 'wtg' | 'bess' | 'auxiliary';

/// Where the source's catalog entry lives.
export type CatalogScope = 'global' | 'local';

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
  elevationOffset?: number;    // BESS / Auxiliary
  yawDeg?: number;
  modeOverride?: string | null;
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
  annexD: {
    barrierAbarCapDb: number;
    useElevatedSourceForBarrier: boolean;
    applyConcaveCorrection: boolean;
    wtReceiverHeightMin: number;
  };
  general: { defaultReceiverHeight: number };
  /// Limits on how far first-order Taylor extrapolation is allowed to push
  /// a per-band Lp value before forcing an exact re-snapshot. The clamp
  /// stops false high values from showing during long drags; the stale
  /// flag triggers a background recompute.
  extrapolation: {
    capPerBandDb: number;     // default 6 dB per octave band
    capTotalDbA: number;      // default 3 dB(A) on the per-receiver total
  };
  /// Distance-aware solver settings. Both apply project-wide.
  propagation?: {
    /// Sources further than this from a receiver are skipped (treated as
    /// negligible contribution). Default 20 000 m. Set to 0 / negative to
    /// disable the cutoff entirely. No upper bound — the user can pin it
    /// to 0.1 m if they want to inspect a specific source-receiver pair.
    maxContributionDistanceM: number;
    /// Sources further than this from a receiver get folded into a single
    /// equivalent point source (energy-summed Lw at the cluster centroid).
    /// Below this distance every source is propagated individually so the
    /// near-field directivity / barrier interaction is preserved.
    /// Set to 0 / negative to disable clustering. Default 1 500 m.
    clusterBeyondM: number;
    /// Maximum number of clusters formed per receiver. Caps memory at very
    /// large projects (e.g. a 200-WTG portfolio behind a 20-receiver line).
    maxClustersPerReceiver: number;
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
  owner: string;
  scenario: Scenario;
  sources: Source[];
  barriers: Barrier[];
  receivers: Receiver[];
  groups?: Group[];
  calculationArea?: CalculationArea;
  settings?: ProjectSettings;
  /// Project-local catalog of source models. Independent of the global
  /// catalog: entries can be in either, both, or just one.
  localCatalog?: CatalogEntry[];
}

// =================== Catalog ===================

export type CatalogBandSystem = 'octave' | 'oneThirdOctave';

export interface CatalogModeData {
  /// Mode name from the source data (or 'default' / 'broadband').
  name: string;
  bandSystem: CatalogBandSystem;
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

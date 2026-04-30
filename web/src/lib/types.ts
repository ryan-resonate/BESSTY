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
  /// Per-source override of the rotor diameter (m). When set, takes
  /// precedence over the catalog entry's `rotorDiameterM` for the Annex
  /// D.3 elevated-source-for-barrier rule (source z = hub + rotor/2).
  /// Leave undefined to inherit from the catalog model. WTG only.
  rotorDiameterM?: number;
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

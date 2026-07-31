// Physical dimensions resolved from a catalog product: emission height,
// footprint, and the screening box ("source container").
//
// Split out of `catalog.ts` because that module reaches Firestore, which drags
// the whole Firebase SDK into anything that imports it — including the test
// bundle and `MapView`. These helpers are pure functions over a CatalogEntry
// and a Source, so they live here where they can be unit-tested directly and
// imported from the map without a runtime dependency on the network layer.
//
// `catalog.ts` re-exports everything below, so existing
// `from './catalog'` imports keep working.

import type { CatalogEntry, Source, SourceKind } from './types';

/// Per-kind defaults used when a CatalogEntry doesn't specify
/// `footprintM`. Picked from typical product datasheets:
///   - BESS: Tesla Megapack 2 XL exterior dims.
///   - Auxiliary: a generic inverter cabinet (Sungrow SG3300-ish).
///   - WTG: not applicable (rotorDiameterM serves the same purpose).
const DEFAULT_FOOTPRINT_M: Record<SourceKind, { widthM: number; lengthM: number }> = {
  bess:      { widthM: 5.1, lengthM: 1.7 },
  auxiliary: { widthM: 2.0, lengthM: 1.5 },
  wtg:       { widthM: 0,   lengthM: 0 },
};

/// Per-kind default enclosure height (m) used when a CatalogEntry doesn't
/// specify `containerHeightM`. Same spirit as `DEFAULT_FOOTPRINT_M`: a
/// product without a pinned value still gets a plausible box, so the
/// "Source containers" setting does something on every project rather than
/// silently no-op'ing until someone edits the catalog.
///   - BESS: typical utility container / Megapack-class cabinet.
///   - Auxiliary: a generic inverter cabinet.
///   - WTG: not applicable (turbines never get a container).
const DEFAULT_CONTAINER_HEIGHT_M: Record<SourceKind, number> = {
  bess:      2.6,
  auxiliary: 2.2,
  wtg:       0,
};

/// Per-kind default source emission height above local ground (m), used
/// when the catalog entry doesn't pin a `sourceHeightM`. WTG default
/// matches the previous hard-coded fallback in solver.ts; BESS / Aux
/// default matches the previous hard-coded 1.5 m base.
const DEFAULT_SOURCE_HEIGHT_M: Record<SourceKind, number> = {
  wtg: 100,
  bess: 1.5,
  auxiliary: 1.5,
};

/// Resolve a catalog entry's default source emission height (m above
/// local ground). Order of precedence:
///   1. `entry.sourceHeightM` if set
///   2. WTG only: `entry.hubHeights[0]` (legacy convention)
///   3. Per-kind default (WTG 100 m; BESS / Aux 1.5 m)
///
/// Callers should ADD the per-source delta on top of this:
///   - WTG: `Source.hubHeight ?? sourceHeightFor(entry)` (the override
///     replaces the catalog default rather than stacking).
///   - BESS / Aux: `(Source.elevationOffset ?? 0) + sourceHeightFor(entry)`
///     (the offset is a delta from the library height).
export function sourceHeightFor(entry: CatalogEntry | null | undefined): number {
  if (!entry) return DEFAULT_SOURCE_HEIGHT_M.bess;
  if (Number.isFinite(entry.sourceHeightM) && (entry.sourceHeightM as number) > 0) {
    return entry.sourceHeightM as number;
  }
  if (entry.kind === 'wtg' && entry.hubHeights && entry.hubHeights.length > 0) {
    return entry.hubHeights[0];
  }
  return DEFAULT_SOURCE_HEIGHT_M[entry.kind];
}

/// Resolve a catalog entry's footprint, falling back to the kind default
/// when the entry doesn't pin a value. Always returns finite positive
/// dimensions for grouped kinds (BESS, auxiliary); WTGs are zero-sized
/// because they're never grouped.
export function footprintFor(entry: CatalogEntry): { widthM: number; lengthM: number } {
  if (entry.footprintM
      && Number.isFinite(entry.footprintM.widthM)
      && Number.isFinite(entry.footprintM.lengthM)
      && entry.footprintM.widthM > 0
      && entry.footprintM.lengthM > 0) {
    return entry.footprintM;
  }
  return DEFAULT_FOOTPRINT_M[entry.kind];
}

/// Resolve a catalog entry's enclosure height (m), falling back to the kind
/// default when the entry doesn't pin one. Mirrors `footprintFor` so the pair
/// of dimensions a container needs — plan from `footprintM`, body from
/// `containerHeightM` — always resolve together.
///
/// Returns 0 for WTGs, which are never boxed (`resolveContainer` bails on kind
/// before reaching here).
export function containerHeightFor(entry: CatalogEntry): number {
  if (Number.isFinite(entry.containerHeightM) && (entry.containerHeightM as number) > 0) {
    return entry.containerHeightM as number;
  }
  return DEFAULT_CONTAINER_HEIGHT_M[entry.kind];
}

/// A unit's screening box, in the solver's convention: `lengthM` is the LONG
/// axis, laid along the compass `bearingDeg` (0 = north, clockwise).
export interface ContainerBox {
  lengthM: number;
  widthM: number;
  heightM: number;
  bearingDeg: number;
}

/// A per-source dimension override, or `undefined` when it isn't a usable
/// positive number. Blank / 0 / NaN means "not overridden" rather than
/// "zero-sized box", so a half-typed field falls back to the catalog instead of
/// silently deleting the container.
function overrideDim(v: number | undefined): number | undefined {
  return Number.isFinite(v) && (v as number) > 0 ? (v as number) : undefined;
}

/// The screening box for one BESS / auxiliary unit, or `undefined` when the unit
/// opted out (`container.enabled === false`) or is a turbine.
///
/// Dimensions come from the catalog product — `footprintM` for the plan and
/// `containerHeightM` for the body — each with a per-kind fallback
/// (`footprintFor` / `containerHeightFor`) and a per-source override on top.
/// Both fall back, so every BESS / auxiliary unit resolves to a box: the
/// containers setting is a project-level choice, not something that quietly
/// depends on whether anyone has filled in the catalog. (It used to depend on
/// exactly that, and since nothing ever set `containerHeightM`, the whole
/// setting was a silent no-op — see `catalogDims.test.ts`.)
///
/// **Orientation.** BEESTY's footprint convention is `widthM` = the LONG axis,
/// which at `yawDeg = 0` runs EAST along an unrotated row (see `bessGroups.ts`),
/// and `yawDeg` is clockwise from north. `containerFootprint` instead takes the
/// long axis along a compass `bearingDeg` with 0 = north. Hence the +90: a unit
/// with no yaw lies east-west, as the map draws it.
export function resolveContainer(
  source: Source,
  entry: CatalogEntry,
): ContainerBox | undefined {
  if (source.kind === 'wtg') return undefined;              // turbines have no box
  const override = source.container;
  if (override?.enabled === false) return undefined;
  const heightM = overrideDim(override?.heightM) ?? containerHeightFor(entry);
  if (!(heightM > 0)) return undefined;
  const fp = footprintFor(entry);
  const lengthM = overrideDim(override?.lengthM) ?? fp.widthM;  // widthM is the long axis
  const widthM = overrideDim(override?.widthM) ?? fp.lengthM;
  if (!(lengthM > 0) || !(widthM > 0)) return undefined;
  // Grouped units take the row heading; `bearingDeg` is the standalone fallback
  // (see the `Source.container` doc comment).
  const yaw = source.yawDeg ?? override?.bearingDeg ?? 0;
  return { lengthM, widthM, heightM, bearingDeg: yaw + 90 };
}

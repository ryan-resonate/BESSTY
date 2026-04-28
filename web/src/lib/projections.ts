// Tiny proj4 wrapper with a curated EPSG registry. Used wherever the user
// can hand BESSTY data in something other than WGS84 lat/lng — CSV imports,
// GeoTIFF DEMs, and (eventually) shapefile bundles missing a .prj sidecar.
//
// The full EPSG database is ~6000 entries. We ship a curated list of CRSs
// that cover almost all real wind / utility-scale BESS work in AU + a few
// common international ones, plus all 60 generic UTM zones (north & south).
// Anyone whose CRS isn't in the list can still type / paste a proj4 string
// via the "Custom proj4" entry — the registry is open at runtime via
// `registerCustomEpsg`.
//
// Convention: throughout BESSTY, "lat/lng" always means EPSG:4326 (WGS84
// geographic). Projected coords are stored in their CRS' native units —
// metres for UTM/MGA, metres for British National Grid, etc. The two
// transforms below are the only place that's allowed to cross that line.

import proj4 from 'proj4';

export interface EpsgPreset {
  /// Numeric EPSG code (e.g. 4326).
  code: number;
  /// Human-readable label shown in dropdowns.
  label: string;
  /// Bucket for grouping in the picker UI ("Geographic", "Australia (MGA)", …).
  group: string;
  /// proj4 definition string. Already registered with proj4 on module load.
  defn: string;
}

// --- Geographic CRSs (lat/lng) ---
const GEOGRAPHIC: EpsgPreset[] = [
  { code: 4326, group: 'Geographic', label: 'WGS84 (EPSG:4326)',
    defn: '+proj=longlat +datum=WGS84 +no_defs' },
  { code: 4283, group: 'Geographic', label: 'GDA94 (EPSG:4283)',
    defn: '+proj=longlat +ellps=GRS80 +no_defs' },
  { code: 7844, group: 'Geographic', label: 'GDA2020 (EPSG:7844)',
    defn: '+proj=longlat +ellps=GRS80 +no_defs' },
  { code: 4269, group: 'Geographic', label: 'NAD83 (EPSG:4269)',
    defn: '+proj=longlat +ellps=GRS80 +no_defs' },
  { code: 4322, group: 'Geographic', label: 'WGS72 (EPSG:4322)',
    defn: '+proj=longlat +ellps=WGS72 +no_defs' },
];

// --- Web Mercator (tile-grid CRS used by Leaflet & friends) ---
const WEB_MERCATOR: EpsgPreset[] = [
  { code: 3857, group: 'Web', label: 'Web Mercator (EPSG:3857)',
    defn: '+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +nadgrids=@null +no_defs' },
];

// --- Australia: MGA94 (zones 49–56), MGA2020 (zones 49–56) ---
// MGA = Map Grid of Australia — UTM with the GDA94/GDA2020 datum.
const MGA94: EpsgPreset[] = [49, 50, 51, 52, 53, 54, 55, 56].map((zone) => ({
  code: 28300 + zone,
  group: 'Australia · MGA94',
  label: `MGA94 zone ${zone} (EPSG:${28300 + zone})`,
  defn: `+proj=utm +zone=${zone} +south +ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs`,
}));
const MGA2020: EpsgPreset[] = [49, 50, 51, 52, 53, 54, 55, 56].map((zone) => ({
  code: 7849 + (zone - 49),
  group: 'Australia · MGA2020',
  label: `MGA2020 zone ${zone} (EPSG:${7849 + (zone - 49)})`,
  // GDA2020 datum (no datum shift, GDA2020 is essentially ITRF2014 at epoch 2020.0).
  defn: `+proj=utm +zone=${zone} +south +ellps=GRS80 +units=m +no_defs`,
}));

// --- New Zealand Transverse Mercator ---
const NZ: EpsgPreset[] = [
  { code: 2193, group: 'New Zealand', label: 'NZTM2000 (EPSG:2193)',
    defn: '+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 +ellps=GRS80 +units=m +no_defs' },
];

// --- United Kingdom ---
const UK: EpsgPreset[] = [
  { code: 27700, group: 'United Kingdom', label: 'British National Grid (EPSG:27700)',
    defn: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy ' +
          '+towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs' },
];

// --- Generic UTM zones 1..60, both hemispheres (WGS84 datum). ---
// EPSG codes: WGS84 N = 32600 + zone; WGS84 S = 32700 + zone.
const UTM_WGS84: EpsgPreset[] = [];
for (let zone = 1; zone <= 60; zone++) {
  UTM_WGS84.push({
    code: 32600 + zone,
    group: 'UTM (WGS84) · Northern Hemisphere',
    label: `UTM zone ${zone}N / WGS84 (EPSG:${32600 + zone})`,
    defn: `+proj=utm +zone=${zone} +datum=WGS84 +units=m +no_defs`,
  });
  UTM_WGS84.push({
    code: 32700 + zone,
    group: 'UTM (WGS84) · Southern Hemisphere',
    label: `UTM zone ${zone}S / WGS84 (EPSG:${32700 + zone})`,
    defn: `+proj=utm +zone=${zone} +south +datum=WGS84 +units=m +no_defs`,
  });
}

const ALL_PRESETS: EpsgPreset[] = [
  ...GEOGRAPHIC,
  ...WEB_MERCATOR,
  ...MGA94,
  ...MGA2020,
  ...NZ,
  ...UK,
  ...UTM_WGS84,
];

// Register every preset with proj4 on module load, indexed as both `EPSG:N`
// and the bare numeric form — both styles appear in the wild.
for (const p of ALL_PRESETS) {
  proj4.defs(`EPSG:${p.code}`, p.defn);
  proj4.defs(`${p.code}`, p.defn);
}

const PRESET_BY_CODE: Map<number, EpsgPreset> = new Map(
  ALL_PRESETS.map((p) => [p.code, p]),
);

/// Returns the curated preset list, in the order they should appear in
/// dropdowns (WGS84 first, then projected systems most relevant to AU/NZ
/// users, then the long UTM tail).
export function listEpsgPresets(): EpsgPreset[] {
  return ALL_PRESETS;
}

/// Group by `group` field for `<optgroup>` rendering.
export function groupedEpsgPresets(): Array<{ group: string; presets: EpsgPreset[] }> {
  const seen = new Map<string, EpsgPreset[]>();
  for (const p of ALL_PRESETS) {
    const list = seen.get(p.group) ?? [];
    list.push(p);
    seen.set(p.group, list);
  }
  return Array.from(seen.entries()).map(([group, presets]) => ({ group, presets }));
}

export function presetForEpsg(code: number): EpsgPreset | null {
  return PRESET_BY_CODE.get(code) ?? null;
}

/// Register a runtime-supplied proj4 string under a numeric code. Useful
/// when a user pastes a definition from epsg.io for a CRS we don't ship.
/// No-op if the code is already known.
export function registerCustomEpsg(code: number, defn: string, label?: string) {
  if (PRESET_BY_CODE.has(code)) return;
  proj4.defs(`EPSG:${code}`, defn);
  proj4.defs(`${code}`, defn);
  const preset: EpsgPreset = {
    code, defn,
    group: 'Custom',
    label: label ?? `Custom (EPSG:${code})`,
  };
  ALL_PRESETS.push(preset);
  PRESET_BY_CODE.set(code, preset);
}

/// Transform a coordinate from the given source CRS into WGS84 (lat, lng).
/// Throws if `epsg` isn't registered (caller should have validated via
/// `presetForEpsg`).
export function toWgs84(epsg: number, x: number, y: number): [number, number] {
  if (epsg === 4326) return [y, x]; // proj4 input order is (x, y) = (lng, lat).
  const def = `EPSG:${epsg}`;
  // proj4 returns [lng, lat] for geographic targets.
  const [lng, lat] = proj4(def, 'EPSG:4326', [x, y]);
  return [lat, lng];
}

/// Inverse of `toWgs84`. Returns native CRS units (typically metres).
export function fromWgs84(epsg: number, lat: number, lng: number): [number, number] {
  if (epsg === 4326) return [lng, lat];
  const def = `EPSG:${epsg}`;
  const [x, y] = proj4('EPSG:4326', def, [lng, lat]);
  return [x, y];
}

/// Best-effort check: is this CRS one we can transform between? True for
/// any registered preset (or anything previously passed through
/// `registerCustomEpsg`).
export function isSupportedEpsg(code: number): boolean {
  return PRESET_BY_CODE.has(code);
}

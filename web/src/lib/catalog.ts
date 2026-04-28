// Catalog data layer.
//
// Two databases of source models live alongside each other:
//
//   - **Global catalog** — stored in `localStorage['beesty.catalog.global']`,
//     shared across every project on this device. Eventually backed by
//     Firestore so multiple users share the same set of vendor models.
//
//   - **Local catalog** — stored on the project document itself
//     (`project.localCatalog`). Per-project, isolated from anything else.
//
// The two are deliberately independent: an entry can live in either, both,
// or just one, with no automatic syncing. UI affordances let users copy
// global → local (and the catalog screen lets them edit either or both).
// Sources reference an entry by `{ catalogScope, modelId }`.

import type { CatalogEntry, Project, Source, SourceKind } from './types';
import { SEED_CATALOG } from './seedCatalog';

const GLOBAL_CATALOG_KEY = 'beesty.catalog.global';

// ---------- Global catalog ----------

/// Read the global catalog. On first call (empty localStorage) seeds with
/// the bundled `SEED_CATALOG`.
export function loadGlobalCatalog(): CatalogEntry[] {
  try {
    const raw = localStorage.getItem(GLOBAL_CATALOG_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as CatalogEntry[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    /* fallthrough to seed */
  }
  saveGlobalCatalog(SEED_CATALOG);
  return SEED_CATALOG.slice();
}

export function saveGlobalCatalog(entries: CatalogEntry[]) {
  localStorage.setItem(GLOBAL_CATALOG_KEY, JSON.stringify(entries));
}

export function upsertGlobalEntry(entry: CatalogEntry) {
  const all = loadGlobalCatalog();
  const idx = all.findIndex((e) => e.id === entry.id);
  if (idx >= 0) all[idx] = entry; else all.push(entry);
  saveGlobalCatalog(all);
}

export function deleteGlobalEntry(id: string) {
  saveGlobalCatalog(loadGlobalCatalog().filter((e) => e.id !== id));
}

// ---------- Local catalog (lives on a project) ----------

export function localCatalogOf(project: Project): CatalogEntry[] {
  return project.localCatalog ?? [];
}

export function withLocalEntry(project: Project, entry: CatalogEntry): Project {
  const existing = localCatalogOf(project);
  const idx = existing.findIndex((e) => e.id === entry.id);
  const next = idx >= 0
    ? existing.map((e, i) => (i === idx ? entry : e))
    : [...existing, entry];
  return { ...project, localCatalog: next };
}

export function withoutLocalEntry(project: Project, id: string): Project {
  return { ...project, localCatalog: localCatalogOf(project).filter((e) => e.id !== id) };
}

// ---------- Cross-scope lookup ----------

/// Resolve a source's catalog entry by scope + id. Returns null if the
/// referenced entry has been deleted.
export function lookupEntry(project: Project, source: Source): CatalogEntry | null {
  if (source.catalogScope === 'local') {
    return localCatalogOf(project).find((e) => e.id === source.modelId) ?? null;
  }
  return loadGlobalCatalog().find((e) => e.id === source.modelId) ?? null;
}

/// All catalog entries available to a project (local first, then global,
/// dedup'd by id with local winning).
export function allEntriesFor(project: Project): Array<CatalogEntry & { _scope: 'local' | 'global' }> {
  const local = localCatalogOf(project).map((e) => ({ ...e, _scope: 'local' as const }));
  const localIds = new Set(local.map((e) => e.id));
  const global = loadGlobalCatalog()
    .filter((e) => !localIds.has(e.id))
    .map((e) => ({ ...e, _scope: 'global' as const }));
  return [...local, ...global];
}

export function listEntriesByKind(
  project: Project,
  kind: SourceKind,
): Array<CatalogEntry & { _scope: 'local' | 'global' }> {
  return allEntriesFor(project).filter((e) => e.kind === kind);
}

// ---------- Helpers used by Source pickers ----------

/// Derive an octave-band Lw spectrum from a catalog entry + mode + project
/// wind speed, projecting the catalog's native bands onto the solver's
/// 8-band octave system (63 Hz – 8 kHz). Bands outside that range are
/// preserved energetically: third-octaves get summed into their parent
/// octave; out-of-range data is dropped.
///
/// Per the user's spec ("If only one-third octave is provided, then
/// calculate octave from that"): a third-octave catalog entry feeds the
/// octave solver via energy summation across each octave's three child
/// third-octaves.
export function octaveSpectrumFor(
  entry: CatalogEntry,
  modeName: string,
  windSpeed: number,
): Float64Array {
  const mode = entry.modes.find((m) => m.name === modeName) ?? entry.modes[0];
  if (!mode) return new Float64Array(8);

  const sourceLevels = pickWindSpeed(mode, windSpeed);
  // Sum third-octaves into octaves; pass through if already octave.
  return foldToOctave(mode.frequencies, sourceLevels);
}

/// Linear-interpolate (in dB) the spectrum at the requested wind speed.
function pickWindSpeed(mode: { spectra: Record<string, number[]>; windSpeeds?: number[] }, ws: number): number[] {
  if (!mode.windSpeeds || mode.windSpeeds.length === 0) {
    // Wind-independent (BESS / Aux): single 'broadband' key.
    const k = Object.keys(mode.spectra)[0];
    return mode.spectra[k] ?? [];
  }
  const sorted = mode.windSpeeds.slice().sort((a, b) => a - b);
  if (ws <= sorted[0]) return mode.spectra[String(sorted[0])] ?? [];
  if (ws >= sorted[sorted.length - 1]) return mode.spectra[String(sorted[sorted.length - 1])] ?? [];
  for (let i = 1; i < sorted.length; i++) {
    if (ws <= sorted[i]) {
      const lo = sorted[i - 1];
      const hi = sorted[i];
      const t = (ws - lo) / (hi - lo);
      const a = mode.spectra[String(lo)] ?? [];
      const b = mode.spectra[String(hi)] ?? [];
      const out: number[] = [];
      for (let j = 0; j < a.length; j++) out.push(a[j] + (b[j] - a[j]) * t);
      return out;
    }
  }
  return [];
}

/// 10 octave-band centres matching the solver (16 Hz – 8 kHz).
const OCTAVE_CENTRES = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];

function inOctaveBand(f: number, centre: number): boolean {
  const lo = centre / Math.SQRT2;
  const hi = centre * Math.SQRT2;
  return f >= lo && f < hi;
}

function foldToOctave(frequencies: number[], levels: number[]): Float64Array {
  const out = new Float64Array(OCTAVE_CENTRES.length);
  for (let oct = 0; oct < OCTAVE_CENTRES.length; oct++) {
    let energy = 0;
    let any = false;
    for (let i = 0; i < frequencies.length; i++) {
      if (!inOctaveBand(frequencies[i], OCTAVE_CENTRES[oct])) continue;
      const lp = levels[i];
      if (lp == null || !isFinite(lp) || lp <= 0) continue;
      energy += Math.pow(10, lp / 10);
      any = true;
    }
    out[oct] = any && energy > 0 ? 10 * Math.log10(energy) : 0;
  }
  return out;
}

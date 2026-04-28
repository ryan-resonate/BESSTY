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
import { SEED_CATALOG } from './seedCatalog';
const GLOBAL_CATALOG_KEY = 'beesty.catalog.global';
// ---------- Global catalog ----------
/// Read the global catalog. On first call (empty localStorage) seeds with
/// the bundled `SEED_CATALOG`.
export function loadGlobalCatalog() {
    try {
        const raw = localStorage.getItem(GLOBAL_CATALOG_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed) && parsed.length > 0)
                return parsed;
        }
    }
    catch {
        /* fallthrough to seed */
    }
    saveGlobalCatalog(SEED_CATALOG);
    return SEED_CATALOG.slice();
}
export function saveGlobalCatalog(entries) {
    localStorage.setItem(GLOBAL_CATALOG_KEY, JSON.stringify(entries));
}
export function upsertGlobalEntry(entry) {
    const all = loadGlobalCatalog();
    const idx = all.findIndex((e) => e.id === entry.id);
    if (idx >= 0)
        all[idx] = entry;
    else
        all.push(entry);
    saveGlobalCatalog(all);
}
export function deleteGlobalEntry(id) {
    saveGlobalCatalog(loadGlobalCatalog().filter((e) => e.id !== id));
}
// ---------- Local catalog (lives on a project) ----------
export function localCatalogOf(project) {
    return project.localCatalog ?? [];
}
export function withLocalEntry(project, entry) {
    const existing = localCatalogOf(project);
    const idx = existing.findIndex((e) => e.id === entry.id);
    const next = idx >= 0
        ? existing.map((e, i) => (i === idx ? entry : e))
        : [...existing, entry];
    return { ...project, localCatalog: next };
}
export function withoutLocalEntry(project, id) {
    return { ...project, localCatalog: localCatalogOf(project).filter((e) => e.id !== id) };
}
// ---------- Cross-scope lookup ----------
/// Resolve a source's catalog entry by scope + id. Returns null if the
/// referenced entry has been deleted.
export function lookupEntry(project, source) {
    if (source.catalogScope === 'local') {
        return localCatalogOf(project).find((e) => e.id === source.modelId) ?? null;
    }
    return loadGlobalCatalog().find((e) => e.id === source.modelId) ?? null;
}
/// All catalog entries available to a project (local first, then global,
/// dedup'd by id with local winning).
export function allEntriesFor(project) {
    const local = localCatalogOf(project).map((e) => ({ ...e, _scope: 'local' }));
    const localIds = new Set(local.map((e) => e.id));
    const global = loadGlobalCatalog()
        .filter((e) => !localIds.has(e.id))
        .map((e) => ({ ...e, _scope: 'global' }));
    return [...local, ...global];
}
export function listEntriesByKind(project, kind) {
    return allEntriesFor(project).filter((e) => e.kind === kind);
}
// ---------- Helpers used by Source pickers ----------
/// Derive a per-band Lw spectrum from a catalog entry + mode + project wind
/// speed, projecting onto the solver's chosen band system.
///
///   - octave + octave source             → energy-snap to standard octave centres
///   - octave + third-octave source       → sum each octave's 3 child thirds
///   - third-octave + third-octave source → energy-snap to standard 1/3-oct centres
///   - third-octave + octave source       → distribute each octave's energy
///                                          equally across its 3 children
///                                          (lp_third = lp_oct − 10 log10(3))
export function spectrumFor(entry, modeName, windSpeed, bandSystem) {
    const mode = entry.modes.find((m) => m.name === modeName) ?? entry.modes[0];
    if (!mode)
        return new Float64Array(bandSystem === 'octave' ? OCTAVE_CENTRES.length : THIRD_OCT_CENTRES.length);
    const sourceLevels = pickWindSpeed(mode, windSpeed);
    if (bandSystem === 'octave') {
        if (mode.bandSystem === 'octave') {
            return snapToCentres(mode.frequencies, sourceLevels, OCTAVE_CENTRES, octaveBand);
        }
        return foldThirdsToOctave(mode.frequencies, sourceLevels);
    }
    if (mode.bandSystem === 'oneThirdOctave') {
        return snapToCentres(mode.frequencies, sourceLevels, THIRD_OCT_CENTRES, thirdOctaveBand);
    }
    return distributeOctavesToThirds(mode.frequencies, sourceLevels);
}
/// Backwards-compatible alias for the original octave-only API.
export function octaveSpectrumFor(entry, modeName, windSpeed) {
    return spectrumFor(entry, modeName, windSpeed, 'octave');
}
/// Linear-interpolate (in dB) the spectrum at the requested wind speed.
function pickWindSpeed(mode, ws) {
    if (!mode.windSpeeds || mode.windSpeeds.length === 0) {
        // Wind-independent (BESS / Aux): single 'broadband' key.
        const k = Object.keys(mode.spectra)[0];
        return mode.spectra[k] ?? [];
    }
    const sorted = mode.windSpeeds.slice().sort((a, b) => a - b);
    if (ws <= sorted[0])
        return mode.spectra[String(sorted[0])] ?? [];
    if (ws >= sorted[sorted.length - 1])
        return mode.spectra[String(sorted[sorted.length - 1])] ?? [];
    for (let i = 1; i < sorted.length; i++) {
        if (ws <= sorted[i]) {
            const lo = sorted[i - 1];
            const hi = sorted[i];
            const t = (ws - lo) / (hi - lo);
            const a = mode.spectra[String(lo)] ?? [];
            const b = mode.spectra[String(hi)] ?? [];
            const out = [];
            for (let j = 0; j < a.length; j++)
                out.push(a[j] + (b[j] - a[j]) * t);
            return out;
        }
    }
    return [];
}
/// 10 octave-band centres matching the solver (16 Hz – 8 kHz).
const OCTAVE_CENTRES = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];
/// 31 one-third octave centres (10 Hz – 10 kHz).
const THIRD_OCT_CENTRES = [
    10, 12.5, 16, 20, 25, 31.5, 40,
    50, 63, 80, 100, 125, 160, 200, 250, 315, 400,
    500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150,
    4000, 5000, 6300, 8000, 10000,
];
function octaveBand(f, centre) {
    const lo = centre / Math.SQRT2;
    const hi = centre * Math.SQRT2;
    return f >= lo && f < hi;
}
function thirdOctaveBand(f, centre) {
    // ratio is 10^(1/20) ≈ 1.122 each side of centre.
    const lo = centre / Math.pow(10, 1 / 20);
    const hi = centre * Math.pow(10, 1 / 20);
    return f >= lo && f < hi;
}
function snapToCentres(frequencies, levels, centres, inBand) {
    const out = new Float64Array(centres.length);
    for (let i = 0; i < centres.length; i++) {
        let energy = 0;
        for (let j = 0; j < frequencies.length; j++) {
            if (!inBand(frequencies[j], centres[i]))
                continue;
            const lp = levels[j];
            if (lp == null || !isFinite(lp) || lp <= 0)
                continue;
            energy += Math.pow(10, lp / 10);
        }
        out[i] = energy > 0 ? 10 * Math.log10(energy) : 0;
    }
    return out;
}
function foldThirdsToOctave(frequencies, levels) {
    return snapToCentres(frequencies, levels, OCTAVE_CENTRES, octaveBand);
}
/// Octave-band Lw distributed equally (in linear energy) across each octave's
/// three child third-octaves: each child receives `lw - 10·log10(3)` ≈ lw − 4.77 dB.
function distributeOctavesToThirds(frequencies, levels) {
    const out = new Float64Array(THIRD_OCT_CENTRES.length);
    const split = -10 * Math.log10(3);
    for (let i = 0; i < THIRD_OCT_CENTRES.length; i++) {
        const t = THIRD_OCT_CENTRES[i];
        // Find the source octave that contains this third-octave.
        let energy = 0;
        for (let j = 0; j < frequencies.length; j++) {
            if (!octaveBand(t, frequencies[j]))
                continue;
            const lp = levels[j];
            if (lp == null || !isFinite(lp) || lp <= 0)
                continue;
            energy += Math.pow(10, (lp + split) / 10);
        }
        out[i] = energy > 0 ? 10 * Math.log10(energy) : 0;
    }
    return out;
}

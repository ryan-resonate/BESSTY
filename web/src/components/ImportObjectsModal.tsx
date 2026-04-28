// One modal for importing receiver / source location lists from any of:
// CSV, KML, or shapefile bundles. The user picks the file, picks the
// **kind** (Receivers / WTGs / BESS / Auxiliary), maps attributes,
// optionally picks a CRS (CSV always; shapefile if no .prj sidecar),
// and commits.

import { useState } from 'react';
import {
  guessLocationMapping,
  parseLocations,
  reprojectShapefileFeature,
  type ImportFormat,
  type ImportResult,
} from '../lib/locationImport';
import { listEntriesByKind } from '../lib/catalog';
import { toWgs84 } from '../lib/projections';
import { EpsgPicker } from './EpsgPicker';
import { ModalBackdrop } from './ModalBackdrop';
import { NumericInput } from './NumericInput';
import type { Project, Receiver, Source, SourceKind } from '../lib/types';

type Kind = 'receiver' | 'wtg' | 'bess' | 'auxiliary';

interface Props {
  project: Project;
  setProject(p: Project): void;
  /// Initial selection in the kind dropdown. Defaults to 'receiver'.
  initialKind?: Kind;
  onClose(): void;
  /// Called after a successful import with the WGS84 bounding box of the
  /// just-added items. Lets the parent recentre / fit the map.
  onAfterImport?(bounds: { sw: [number, number]; ne: [number, number] }): void;
}

let nextId = 7000;
function newId(prefix: string) { nextId += 1; return `${prefix}-${nextId}`; }

/// Coerce an arbitrary import value into a finite number, or fall back to
/// the default. Anything that becomes NaN/±Infinity (blanks, text, garbled
/// columns) is replaced — keeps NaN out of the project state, where it
/// otherwise crashes inputs and produces "no result" rows downstream.
function safeNum(raw: unknown, fallback: number): number {
  if (raw == null) return fallback;
  const s = String(raw).trim();
  // `+""` and `+"   "` both equal 0, which is finite but very rarely the
  // intended value for a height / limit. Treat empty cells as missing and
  // use the user-configured default instead.
  if (s === '') return fallback;
  const n = +s;
  return Number.isFinite(n) ? n : fallback;
}

const KIND_LABEL: Record<Kind, string> = {
  receiver: 'Receivers',
  wtg: 'Wind turbines',
  bess: 'BESS',
  auxiliary: 'Auxiliary equipment',
};

export function ImportObjectsModal({ project, setProject, initialKind = 'receiver', onClose, onAfterImport }: Props) {
  const [parsed, setParsed] = useState<ImportResult | null>(null);
  const [kind, setKind] = useState<Kind>(initialKind);
  // initialKind defaults the model/mode pickers below — populated lazily
  // via the dropdown's first option. No useEffect needed because we treat
  // an empty defaultModelKey as "use the first candidate".
  const [mapping, setMapping] = useState<Record<string, string | null>>({});
  /// CRS the user has selected for the imported coords. Defaults to WGS84.
  /// For CSV → applied to (X, Y) columns. For shapefile-without-prj →
  /// applied to native (x, y) stored on each feature. KML always 4326.
  const [crsEpsg, setCrsEpsg] = useState(4326);

  const [defaultLimitDay, setDefaultLimitDay] = useState(50);
  const [defaultLimitEvening, setDefaultLimitEvening] = useState(45);
  const [defaultLimitNight, setDefaultLimitNight] = useState(40);
  const [defaultHeight, setDefaultHeight] = useState(1.5);
  const [defaultHubHeight, setDefaultHubHeight] = useState(100);
  /// Default catalog entry to use when the row has no model column (or
  /// the value doesn't match any entry). Held as `${scope}:${id}` so the
  /// dropdown can disambiguate global vs local entries with the same id.
  const [defaultModelKey, setDefaultModelKey] = useState<string>('');
  /// Default mode for the chosen default model. Empty = use the entry's
  /// own defaultMode.
  const [defaultMode, setDefaultMode] = useState<string>('');
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // For source kinds, surface the list of catalog entries up-front so the
  // user can pick a sensible default model before the import runs.
  const sourceCandidates = kind !== 'receiver'
    ? listEntriesByKind(project, kind as SourceKind)
    : [];
  const defaultEntry = (() => {
    if (kind === 'receiver') return null;
    if (defaultModelKey) {
      const [scope, ...rest] = defaultModelKey.split(':');
      const id = rest.join(':');
      const found = sourceCandidates.find((c) => c._scope === scope && c.id === id);
      if (found) return found;
    }
    return sourceCandidates[0] ?? null;
  })();

  function objectKindToImportKind(k: Kind): 'source' | 'receiver' {
    return k === 'receiver' ? 'receiver' : 'source';
  }

  async function handleFile(f: File) {
    setError(null);
    setParsing(true);
    try {
      const result = await parseLocations(f);
      setParsed(result);
      setMapping(guessLocationMapping(result.attributeNames, objectKindToImportKind(kind), result.format));
      setDefaultHeight(kind === 'receiver' ? 1.5 : 100);
      // Initialise the CRS picker from whatever the parser inferred.
      // KML → 4326 (locked); shapefile w/ prj → 4326 (locked); else WGS84
      // as a sensible default the user can change.
      setCrsEpsg(result.nativeEpsg ?? 4326);
    } catch (e) {
      setError(String(e));
    }
    setParsing(false);
  }

  // When the user changes the target kind after parsing, refresh defaults.
  function onKindChange(k: Kind) {
    setKind(k);
    if (parsed) {
      setMapping(guessLocationMapping(parsed.attributeNames, objectKindToImportKind(k), parsed.format));
    }
    setDefaultHeight(k === 'receiver' ? 1.5 : 100);
    // Pick the first available model of the new kind as the default.
    if (k !== 'receiver') {
      const list = listEntriesByKind(project, k as SourceKind);
      if (list.length > 0) {
        setDefaultModelKey(`${list[0]._scope}:${list[0].id}`);
        setDefaultMode(list[0].defaultMode);
      } else {
        setDefaultModelKey('');
        setDefaultMode('');
      }
    } else {
      setDefaultModelKey('');
      setDefaultMode('');
    }
  }

  function applyImport() {
    if (!parsed) return;
    const ik = objectKindToImportKind(kind);
    const isCsv = parsed.format === 'csv';
    const isShapefileNoPrj = parsed.format === 'shapefile' && parsed.nativeEpsg !== 4326;
    if (isCsv && (!mapping.x || !mapping.y)) {
      alert('CSV import needs columns assigned to X (longitude / easting) and Y (latitude / northing).');
      return;
    }

    const xCol = mapping.x;
    const yCol = mapping.y;
    const nameCol = mapping.name;

    function latLngFor(f: ImportResult['features'][number]): [number, number] | null {
      if (isCsv) {
        const x = parseFloat(String(f.properties[xCol!]));
        const y = parseFloat(String(f.properties[yCol!]));
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (crsEpsg === 4326) return [y, x];
        try { return toWgs84(crsEpsg, x, y); } catch { return null; }
      }
      if (isShapefileNoPrj) {
        try {
          const ll = reprojectShapefileFeature(f, crsEpsg);
          return ll;
        } catch { return null; }
      }
      // KML / shapefile-with-prj — geometry already in WGS84.
      return Number.isFinite(f.latLng[0]) && Number.isFinite(f.latLng[1]) ? f.latLng : null;
    }

    if (ik === 'receiver') {
      const limDay = mapping.limitDayDbA;
      const limEve = mapping.limitEveningDbA;
      const limNight = mapping.limitNightDbA;
      const hCol = mapping.heightAboveGroundM;
      const newReceivers: Receiver[] = parsed.features.flatMap((f) => {
        const ll = latLngFor(f);
        if (!ll) return [];
        // Skip any feature whose final WGS84 coords aren't usable. Belt-and-
        // braces — `latLngFor` already rejects NaN, but cheap to double-check
        // (Inf is rare but possible from a bad reprojection).
        if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return [];
        const id = newId('R');
        return [{
          id,
          name: nameCol ? String(f.properties[nameCol] || id) : id,
          latLng: ll,
          heightAboveGroundM: hCol ? safeNum(f.properties[hCol], defaultHeight) : defaultHeight,
          limitDayDbA: limDay ? safeNum(f.properties[limDay], defaultLimitDay) : defaultLimitDay,
          limitEveningDbA: limEve ? safeNum(f.properties[limEve], defaultLimitEvening) : defaultLimitEvening,
          limitNightDbA: limNight ? safeNum(f.properties[limNight], defaultLimitNight) : defaultLimitNight,
        }];
      });
      setProject({ ...project, receivers: [...project.receivers, ...newReceivers] });
      emitImportBounds(newReceivers.map((r) => r.latLng));
    } else {
      const sk = kind as SourceKind;
      const candidates = listEntriesByKind(project, sk);
      if (candidates.length === 0) {
        alert(`No ${sk} catalog entries available — add one before importing sources of this kind.`);
        return;
      }
      // Order of precedence for the per-feature model:
      //   1. The row's `modelId` column, if it matches a catalog entry.
      //   2. The user-picked default model in the modal.
      //   3. The first available catalog entry of this kind.
      const fallback = defaultEntry ?? candidates[0];
      const modelCol = mapping.modelId;
      const modeCol = mapping.mode;
      const hubCol = mapping.hubHeight;
      const newSources: Source[] = parsed.features.flatMap((f) => {
        const ll = latLngFor(f);
        if (!ll) return [];
        if (!Number.isFinite(ll[0]) || !Number.isFinite(ll[1])) return [];
        const id = newId(sk.toUpperCase());
        let chosen = fallback;
        if (modelCol && f.properties[modelCol] != null) {
          const want = String(f.properties[modelCol]).toLowerCase();
          const match = candidates.find((c) =>
            c.id.toLowerCase() === want
            || c.displayName.toLowerCase() === want
            || c.displayName.toLowerCase().includes(want),
          );
          if (match) chosen = match;
        }
        // Mode resolution mirrors the model: row first, modal default
        // second, entry's own defaultMode last.
        const fallbackMode = (chosen === defaultEntry && defaultMode) ? defaultMode : chosen.defaultMode;
        const modeName = modeCol && f.properties[modeCol] != null
          ? (chosen.modes.find((m) => m.name.toLowerCase() === String(f.properties[modeCol]).toLowerCase())?.name ?? fallbackMode)
          : fallbackMode;
        const base: Source = {
          id, kind: sk,
          catalogScope: chosen._scope,
          name: nameCol ? String(f.properties[nameCol] || id) : id,
          latLng: ll,
          modelId: chosen.id,
          modeOverride: modeName,
        };
        if (sk === 'wtg') {
          base.hubHeight = hubCol ? safeNum(f.properties[hubCol], defaultHubHeight) : defaultHubHeight;
        } else {
          base.elevationOffset = 0;
        }
        return [base];
      });
      setProject({ ...project, sources: [...project.sources, ...newSources] });
      emitImportBounds(newSources.map((s) => s.latLng));
    }
    onClose();
  }

  /// Compute the bbox of just-added items and notify the parent so it can
  /// recentre / fit the map. Skipped when nothing was actually added (e.g.
  /// every row had bad coords).
  function emitImportBounds(coords: Array<[number, number]>) {
    if (!onAfterImport || coords.length === 0) return;
    let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    for (const [lat, lng] of coords) {
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    }
    if (Number.isFinite(minLat) && Number.isFinite(minLng)) {
      onAfterImport({ sw: [minLat, minLng], ne: [maxLat, maxLng] });
    }
  }

  // Field set per kind. CSV has X/Y; KML and shapefile already carry geometry,
  // so X/Y rows are hidden for those formats.
  const fieldsFor = (k: Kind, fmt: ImportFormat | null): Array<{ key: string; label: string; required?: boolean }> => {
    const xy = (fmt === 'csv') ? [
      { key: 'x', label: 'X column (longitude / easting)', required: true },
      { key: 'y', label: 'Y column (latitude / northing)', required: true },
    ] : [];
    if (k === 'receiver') {
      return [
        { key: 'name', label: 'Name attribute' },
        ...xy,
        { key: 'heightAboveGroundM', label: 'Height above ground (m)' },
        { key: 'limitDayDbA', label: 'Day limit dB(A)' },
        { key: 'limitEveningDbA', label: 'Evening limit dB(A)' },
        { key: 'limitNightDbA', label: 'Night limit dB(A)' },
      ];
    }
    return [
      { key: 'name', label: 'Name attribute' },
      ...xy,
      { key: 'modelId', label: 'Catalog model attribute' },
      { key: 'mode', label: 'Mode attribute' },
      { key: 'hubHeight', label: 'Hub height (WTG only)' },
    ];
  };

  // CRS picker is shown for CSV (always) and shapefile-without-prj. KML
  // and shapefile-with-prj are locked to WGS84.
  const showCrsPicker = parsed != null && (
    parsed.format === 'csv'
    || (parsed.format === 'shapefile' && parsed.nativeEpsg !== 4326)
  );
  const crsLockedNote = parsed?.format === 'kml'
    ? 'KML is always WGS84 (EPSG:4326).'
    : (parsed?.format === 'shapefile' && parsed.shapefileHadPrj)
      ? 'Shapefile reprojected from .prj to WGS84.'
      : null;

  return (
    <ModalBackdrop onClose={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 720 }}>
        <div className="modal-header">
          <h2>Import objects</h2>
          <button className="x-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-body">
          <section className="settings-section">
            <div className="grid-2">
              <label className="fld">
                <span>Import as</span>
                <select value={kind} onChange={(e) => onKindChange(e.target.value as Kind)}>
                  {(['receiver', 'wtg', 'bess', 'auxiliary'] as Kind[]).map((k) => (
                    <option key={k} value={k}>{KIND_LABEL[k]}</option>
                  ))}
                </select>
              </label>
              <label className="fld">
                <span>File</span>
                <input
                  type="file"
                  accept=".csv,.txt,.kml,.zip,.shp"
                  disabled={parsing}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    if (f) handleFile(f);
                  }}
                />
              </label>
            </div>
            <div className="hint">
              Accepts <b>.csv</b>, <b>.kml</b>, or a <b>.zip</b> containing a
              shapefile bundle (.shp + .dbf + .prj). CSV defaults to WGS84 lat/lng
              but accepts any registered projected CRS (UTM, MGA, NZTM, …). KML is
              always WGS84. Shapefiles auto-reproject from the .prj sidecar when
              present; otherwise pick a CRS below.
            </div>
            {parsing && <div className="hint">Parsing…</div>}
            {error && <div className="hint" style={{ color: 'var(--red)' }}>Error: {error}</div>}
          </section>

          {parsed && (
            <>
              {showCrsPicker && (
                <section className="settings-section">
                  <h3>Coordinate system</h3>
                  <EpsgPicker
                    value={crsEpsg}
                    onChange={setCrsEpsg}
                    label="Source CRS"
                    hint={parsed.format === 'csv'
                      ? 'Pick the CRS the X / Y columns are in. BEESTY reprojects to WGS84 on import.'
                      : 'Shapefile lacks a usable .prj — pick the CRS its coordinates are in.'}
                  />
                </section>
              )}
              {crsLockedNote && (
                <section className="settings-section">
                  <div className="hint">{crsLockedNote}</div>
                </section>
              )}

              <section className="settings-section">
                <h3>Map attributes</h3>
                <div className="hint">
                  {parsed.features.length} feature{parsed.features.length === 1 ? '' : 's'}
                  {' · '}
                  {parsed.attributeNames.length} attribute{parsed.attributeNames.length === 1 ? '' : 's'}
                  {' · '}
                  {parsed.format}
                </div>
                {parsed.warnings.map((w, i) => (
                  <div key={i} className="hint" style={{ color: 'var(--amber)' }}>⚠ {w}</div>
                ))}
                {fieldsFor(kind, parsed.format).map((f) => (
                  <label key={f.key} className="fld">
                    <span>{f.label}{f.required ? ' *' : ''}</span>
                    <select
                      value={mapping[f.key] ?? ''}
                      onChange={(e) => setMapping({ ...mapping, [f.key]: e.target.value || null })}
                    >
                      <option value="">— none —</option>
                      {parsed.attributeNames.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </label>
                ))}
              </section>

              {kind === 'receiver' && (
                <section className="settings-section">
                  <h3>Defaults (used when the attribute is unmapped or blank)</h3>
                  <div className="grid-2">
                    <label className="fld">
                      <span>Height (m)</span>
                      <NumericInput min={0} max={300} step={0.5}
                        value={defaultHeight} fallback={1.5}
                        onChange={setDefaultHeight} />
                    </label>
                    <label className="fld">
                      <span>Day limit dB(A)</span>
                      <NumericInput min={20} max={80}
                        value={defaultLimitDay} fallback={50}
                        onChange={setDefaultLimitDay} />
                    </label>
                  </div>
                  <div className="grid-2">
                    <label className="fld">
                      <span>Evening limit dB(A)</span>
                      <NumericInput min={20} max={80}
                        value={defaultLimitEvening} fallback={45}
                        onChange={setDefaultLimitEvening} />
                    </label>
                    <label className="fld">
                      <span>Night limit dB(A)</span>
                      <NumericInput min={20} max={80}
                        value={defaultLimitNight} fallback={40}
                        onChange={setDefaultLimitNight} />
                    </label>
                  </div>
                </section>
              )}

              {kind !== 'receiver' && sourceCandidates.length > 0 && (
                <section className="settings-section">
                  <h3>Defaults (used when the row's column is unmapped or unmatched)</h3>
                  <label className="fld">
                    <span>Default model</span>
                    <select
                      value={defaultModelKey}
                      onChange={(e) => {
                        setDefaultModelKey(e.target.value);
                        const [scope, ...rest] = e.target.value.split(':');
                        const id = rest.join(':');
                        const picked = sourceCandidates.find((c) => c._scope === scope && c.id === id);
                        setDefaultMode(picked?.defaultMode ?? '');
                      }}
                    >
                      {sourceCandidates.map((c) => (
                        <option key={`${c._scope}:${c.id}`} value={`${c._scope}:${c.id}`}>
                          {c.displayName}{c._scope === 'local' ? ' · local' : ''}
                        </option>
                      ))}
                    </select>
                  </label>
                  {defaultEntry && defaultEntry.modes.length > 0 && (
                    <label className="fld">
                      <span>Default mode</span>
                      <select
                        value={defaultMode || defaultEntry.defaultMode}
                        onChange={(e) => setDefaultMode(e.target.value)}
                      >
                        {defaultEntry.modes.map((m) => (
                          <option key={m.name} value={m.name}>{m.name}</option>
                        ))}
                      </select>
                    </label>
                  )}
                  {kind === 'wtg' && (
                    <label className="fld">
                      <span>Hub height (m, when not in file)</span>
                      <NumericInput min={50} max={250}
                        value={defaultHubHeight} fallback={100}
                        onChange={setDefaultHubHeight} />
                    </label>
                  )}
                </section>
              )}

              <section className="settings-section">
                <h3>Preview (first 5 features)</h3>
                <div style={{ overflowX: 'auto' }}>
                  <table className="catalog-table" style={{ fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                    <thead>
                      <tr>
                        <th>lat</th><th>lng</th>
                        {parsed.attributeNames.map((h) => <th key={h}>{h}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {parsed.features.slice(0, 5).map((f, i) => (
                        <tr key={i}>
                          <td>{Number.isFinite(f.latLng[0]) ? f.latLng[0].toFixed(5) : '—'}</td>
                          <td>{Number.isFinite(f.latLng[1]) ? f.latLng[1].toFixed(5) : '—'}</td>
                          {parsed.attributeNames.map((h) => <td key={h}>{String(f.properties[h] ?? '')}</td>)}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button
            className="btn primary"
            disabled={!parsed || (parsed.format === 'csv' && (!mapping.x || !mapping.y))}
            onClick={applyImport}
          >
            Import {parsed ? `${parsed.features.length} ${KIND_LABEL[kind].toLowerCase()}` : ''}
          </button>
        </div>
      </div>
    </ModalBackdrop>
  );
}

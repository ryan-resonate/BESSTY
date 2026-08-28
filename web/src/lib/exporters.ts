// Project result exporters. Each function builds an in-memory file (Blob
// or ArrayBuffer) and returns it; the UI layer triggers the download via
// `triggerDownload`. Five formats covered:
//
//   1. Receiver totals  — CSV / XLSX  (id, name, lat, lng, dB(A), pass/fail per period)
//   2. Per-source contribution at each receiver — CSV / XLSX, totals only
//   3. Per-band spectra at each receiver        — CSV / XLSX (10 octave or 31 third-oct)
//   4. Contour lines    — KML  + Esri Shapefile (polylines, one feature per dB threshold)
//   5. Grid raster      — GeoTIFF (Float32, lat/lng, single band Lp dB(A))
//   6. Curtailment schedule — XLSX (turbine × wind speed, one sheet per period)
//   7. Wind-speed sweep — XLSX (receivers) + SHP / KML / GeoTIFF zip (grids),
//      every feature tagged with the wind speed and period that produced it
//
// Design notes:
//   - XLSX uses SheetJS which is already a dep (catalog import).
//   - SHP uses @mapbox/shp-write for the lat/lng polyline pack.
//   - GeoTIFF: hand-rolled minimal writer (~100 LOC) since the `geotiff`
//     package we pull in is read-only. WGS84 lat/lng coords (EPSG:4326).

import * as XLSX from 'xlsx';
import { buildPolylineShapefile, buildPointShapefile, buildZip } from './shapefileWriter';
import type { Period, Project } from './types';
import { projectDOmegaDb } from './types';
import { weightedTotal, weightingFor, weightingLabel, weightsFor, type Weighting } from './weighting';
import { assessedLevel, exceedsLimit, limitComparisonFor, limitFor } from './limits';
import { describeTonalBands, tonalitySettingsFor } from './tonality';
import {
  MODE_OFF_LABEL, PERIODS, PERIOD_LABEL, describeModes, groupPeriodsBySolve,
  modeForPeriod, modeLabel,
} from './modes';
import { windSpeedLimitsEnabled } from './limitTable';
import { describeWindFrom } from './directivity';
import type { CurtailmentResult } from './curtailment';
import type { GridResult, PeriodResults, ReceiverResult } from './solver';
import type { ContourLineSet } from './contourLines';
import type { SweepContourLayer, SweepReceiverRow, SweepResult } from './windSweep';
import { sweepPeriods, sweepReceiverRows, sweepSpeeds } from './windSweep';

// ---------- Trigger download from a Blob ----------

/// Drop the given Blob to the user's downloads folder via a short-lived
/// hidden anchor. Works in every browser we target (Chromium, Firefox,
/// Safari) without any third-party.
export function triggerDownload(filename: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 0);
}

// ---------- 1. Receiver totals + compliance ----------

interface ReceiverRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  heightAboveGroundM: number;
  totalDbA: number | null;
  /// dB(C) − dB(A) at the receiver. The standard low-frequency screening
  /// indicator, so it is exported whatever the assessment weighting is: a
  /// large value says the spectrum is LF-dominated and may need a separate
  /// look, and it costs one extra sum over a spectrum already in hand.
  cMinusA: number | null;
  /// Tonality screen: 'yes' / 'no' / 'n/a' at octave resolution, the bands it
  /// flagged, and what was added to the level (0 unless the penalty is on).
  tonal: 'yes' | 'no' | 'n/a';
  tonalBands: string;
  tonalityPenaltyDb: number;
  assessedDbA: number | null;
  /// Solved level per period. With per-period modes these are three different
  /// solves; without them, three copies of one number — which is exactly what
  /// this export always showed.
  levelDay: number | null;
  levelEvening: number | null;
  levelNight: number | null;
  /// Assessed level per period — that period's solved level plus that period's
  /// own tonality penalty. This is the number each pass/fail verdict actually
  /// compares against its limit, and it is exported so the verdict is always
  /// explainable from the row: a night solve that turns tonal can fail below
  /// its limit, and without this column that fail looks like an export bug.
  /// (The single tonal/penalty columns describe the ACTIVE period's spectrum.)
  assessedDay: number | null;
  assessedEvening: number | null;
  assessedNight: number | null;
  limitDayDbA: number;
  limitEveningDbA: number;
  limitNightDbA: number;
  passDay: 'pass' | 'fail' | '—';
  passEvening: 'pass' | 'fail' | '—';
  passNight: 'pass' | 'fail' | '—';
}

/// Results as the exporters take them: one set (the active period, broadcast to
/// all three columns) or one set per period.
export type ExportResults = ReceiverResult[] | PeriodResults | null;

function isPeriodResults(r: ExportResults): r is PeriodResults {
  return r != null && !Array.isArray(r);
}

/// Results for the period being reported. A plain array is the same solve
/// whatever period is asked for.
function resultsFor(r: ExportResults, period: Period): ReceiverResult[] | null {
  if (r == null) return null;
  return isPeriodResults(r) ? r[period] : r;
}

function receiverRows(project: Project, results: ExportResults): ReceiverRow[] {
  const bs = project.scenario.bandSystem;
  const dOmega = projectDOmegaDb(project);
  const active = project.scenario.period;
  const mode = limitComparisonFor(project);
  const byPeriod = {
    day: resultsFor(results, 'day'),
    evening: resultsFor(results, 'evening'),
    night: resultsFor(results, 'night'),
  };
  return project.receivers.map((r) => {
    const result = resultsFor(results, active)?.find((x) => x.receiverId === r.id);
    const total = result && Number.isFinite(result.totalDbA) ? result.totalDbA : null;
    const assessed = assessedLevel(result);

    /// The level to judge a period on: that period's own solve, assessed (level
    /// plus any tonality penalty). Judging all three against the active period's
    /// number would report night compliance from a daytime solve.
    const forPeriod = (p: Period) => {
      const res = byPeriod[p]?.find((x) => x.receiverId === r.id);
      const lvl = res && Number.isFinite(res.totalDbA) ? res.totalDbA : null;
      return { level: lvl, assessed: assessedLevel(res) };
    };
    const verdict = (p: Period, limit: number): 'pass' | 'fail' | '—' => {
      const a = forPeriod(p).assessed;
      if (a == null) return '—';
      return exceedsLimit(a, limit, mode) ? 'fail' : 'pass';
    };
    let cMinusA: number | null = null;
    if (result?.perBandLp) {
      const c = weightedTotalFor(result.perBandLp, bs, 'C', dOmega);
      const a = weightedTotalFor(result.perBandLp, bs, 'A', dOmega);
      if (Number.isFinite(c) && Number.isFinite(a)) cMinusA = c - a;
    }
    return {
      id: r.id,
      name: r.name,
      lat: r.latLng[0],
      lng: r.latLng[1],
      heightAboveGroundM: r.heightAboveGroundM,
      totalDbA: total,
      cMinusA,
      tonal: result?.tonality
        ? (result.tonality.assessable ? (result.tonality.tonal ? 'yes' : 'no') : 'n/a')
        : 'n/a',
      tonalBands: describeTonalBands(result?.tonality?.bands ?? []),
      tonalityPenaltyDb: result?.tonalityPenaltyDb ?? 0,
      assessedDbA: assessed,
      levelDay: forPeriod('day').level,
      levelEvening: forPeriod('evening').level,
      levelNight: forPeriod('night').level,
      assessedDay: forPeriod('day').assessed,
      assessedEvening: forPeriod('evening').assessed,
      assessedNight: forPeriod('night').assessed,
      // Through the resolver, not off the scalar fields: with wind-speed
      // limits on, the applicable limit comes from the receiver's table at the
      // scenario wind speed, and an export printing the scalar beside a verdict
      // computed from the table would contradict itself in its own row.
      limitDayDbA: limitFor(project, r, 'day'),
      limitEveningDbA: limitFor(project, r, 'evening'),
      limitNightDbA: limitFor(project, r, 'night'),
      passDay: verdict('day', limitFor(project, r, 'day')),
      passEvening: verdict('evening', limitFor(project, r, 'evening')),
      passNight: verdict('night', limitFor(project, r, 'night')),
    };
  });
}

/// Column names carry the weighting actually used, so a dB(C) export cannot be
/// mistaken for a dB(A) one by anyone reading the file later.
function rxHeaders(weighting: Weighting): string[] {
  const w = weighting.toLowerCase();
  return [
    'id', 'name', 'lat', 'lng', 'height_above_ground_m',
    `total_db${w}`, 'dbc_minus_dba',
    'tonal', 'tonal_bands', 'tonality_penalty_db', `assessed_db${w}`,
    `level_day_db${w}`, `level_evening_db${w}`, `level_night_db${w}`,
    `assessed_day_db${w}`, `assessed_evening_db${w}`, `assessed_night_db${w}`,
    `limit_day_db${w}`, `limit_evening_db${w}`, `limit_night_db${w}`,
    'pass_day', 'pass_evening', 'pass_night',
  ];
}

function rxRowAsArray(r: ReceiverRow): Array<string | number> {
  return [
    r.id, r.name, r.lat, r.lng, r.heightAboveGroundM,
    r.totalDbA == null ? '' : r.totalDbA,
    r.cMinusA == null ? '' : Number(r.cMinusA.toFixed(1)),
    r.tonal, r.tonalBands, r.tonalityPenaltyDb,
    r.assessedDbA == null ? '' : Number(r.assessedDbA.toFixed(2)),
    r.levelDay == null ? '' : Number(r.levelDay.toFixed(2)),
    r.levelEvening == null ? '' : Number(r.levelEvening.toFixed(2)),
    r.levelNight == null ? '' : Number(r.levelNight.toFixed(2)),
    r.assessedDay == null ? '' : Number(r.assessedDay.toFixed(2)),
    r.assessedEvening == null ? '' : Number(r.assessedEvening.toFixed(2)),
    r.assessedNight == null ? '' : Number(r.assessedNight.toFixed(2)),
    r.limitDayDbA, r.limitEveningDbA, r.limitNightDbA,
    r.passDay, r.passEvening, r.passNight,
  ];
}

export function exportReceiversCsv(project: Project, results: ExportResults): Blob {
  const rows = receiverRows(project, results);
  const csv = toCsv([rxHeaders(weightingFor(project)), ...rows.map(rxRowAsArray)]);
  return new Blob([csv], { type: 'text/csv;charset=utf-8' });
}

export function exportReceiversXlsx(project: Project, results: ExportResults): Blob {
  const rows = receiverRows(project, results);
  const ws = XLSX.utils.aoa_to_sheet([rxHeaders(weightingFor(project)), ...rows.map(rxRowAsArray)]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Receivers');
  // Add a small "info" sheet with the scenario context — useful when the
  // workbook gets passed around in a project review.
  const info: Array<Array<string | number>> = [
    ['Project', project.name],
    ['Description', project.description],
    ['Scenario period (active)', project.scenario.period],
    ['Wind speed (m/s @ 10 m)', project.scenario.windSpeed],
    ['Band system', project.scenario.bandSystem],
    ['Assessment weighting', weightingLabel(weightingFor(project))],
    // Whether the three level columns are three solves or three copies of one.
    ['Periods solved separately', groupPeriodsBySolve(project).length > 1 ? 'yes — the sources run different modes in different periods' : 'no — one solve serves all three'],
    ['Generated', new Date().toISOString()],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Info');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- 2. Per-source contribution at each receiver (totals only) ----------

interface ContribRow {
  receiverId: string;
  receiverName: string;
  sourceId: string;
  sourceName: string;
  contribDbA: number;
}

/// Sum a Z-weighted spectrum into a total in the project's assessment
/// weighting.
///
/// This module used to carry its own copy of the A-weighting table, on the
/// grounds that it is pure JS and must not depend on WASM init — true, but
/// `lib/weighting.ts` is pure JS too. The copy had drifted: it weighted the
/// 16 Hz band at the NOMINAL 16 Hz (-56.4 dB) while the solver used the exact
/// band centre of 15.85 Hz (-56.7 dB), so an exported per-source contribution
/// disagreed slightly with the receiver total it was supposed to break down.
function weightedTotalFor(
  perBandLp: Float64Array,
  bandSystem: 'octave' | 'oneThirdOctave',
  weighting: Weighting,
  dOmegaDb: number = 0,
): number {
  return weightedTotal(perBandLp, weightsFor(bandSystem, weighting), dOmegaDb);
}

function perSourceContribRows(
  project: Project,
  results: ReceiverResult[] | null,
): ContribRow[] {
  const rows: ContribRow[] = [];
  if (!results) return rows;
  const sourceLabel = (id: string): string => {
    if (id.startsWith('cluster-')) return `[cluster] ${id}`;
    return project.sources.find((s) => s.id === id)?.name ?? id;
  };
  for (const rxResult of results) {
    const rx = project.receivers.find((r) => r.id === rxResult.receiverId);
    if (!rx) continue;
    for (const ps of rxResult.perSource) {
      const dbA = weightedTotalFor(
        ps.perBandLp, project.scenario.bandSystem, weightingFor(project), projectDOmegaDb(project),
      );
      rows.push({
        receiverId: rxResult.receiverId,
        receiverName: rx.name,
        sourceId: ps.sourceId,
        sourceName: sourceLabel(ps.sourceId),
        contribDbA: dbA,
      });
    }
  }
  return rows;
}

/// Built per export rather than a constant: the last column carries the
/// project's weighting, and a `contribution_dba` header over C-weighted
/// numbers is the same lie the visible labels were fixed for. The sweep's
/// regex only looks for `dB(A)`, so lowercase `dba` slipped past it.
/// `period` leads because it qualifies the whole row and is the same in all of
/// them: this file is the ACTIVE period only. Tripling it would triple a
/// diagnostic sheet that is already the longest in the workbook, and with
/// per-period modes an unlabelled contribution table is unreadable — a source
/// contributing nothing might be off, or might just be distant.
const contribHeaders = (weighting: Weighting) => [
  'period', 'receiver_id', 'receiver_name', 'source_id', 'source_name',
  `contribution_db${weighting.toLowerCase()}`,
];

export function exportPerSourceContribCsv(project: Project, results: ReceiverResult[] | null): Blob {
  const rows = perSourceContribRows(project, results);
  const period = project.scenario.period;
  const data = [
    contribHeaders(weightingFor(project)),
    ...rows.map((r) => [period, r.receiverId, r.receiverName, r.sourceId, r.sourceName, Number.isFinite(r.contribDbA) ? r.contribDbA : '']),
  ];
  return new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' });
}

export function exportPerSourceContribXlsx(project: Project, results: ReceiverResult[] | null): Blob {
  const rows = perSourceContribRows(project, results);
  const period = project.scenario.period;
  const data = [
    contribHeaders(weightingFor(project)),
    ...rows.map((r) => [period, r.receiverId, r.receiverName, r.sourceId, r.sourceName, Number.isFinite(r.contribDbA) ? r.contribDbA : '']),
  ];
  const ws = XLSX.utils.aoa_to_sheet(data);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Per-source contributions');
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- 3. Per-band spectra per receiver ----------

const OCTAVE_CENTRES = [16, 31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000];
const THIRD_OCTAVE_CENTRES = [
  10, 12.5, 16, 20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250,
  315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000,
  6300, 8000, 10000,
];

function spectrumRows(project: Project, results: ReceiverResult[] | null): { headers: Array<string | number>; rows: Array<Array<string | number>> } {
  // Headers come from the DATA, not from the project setting. Taking them from
  // the setting produced 31 third-octave columns over a 10-band octave result
  // — 21 empty columns and no clue that the results were stale — whenever a
  // band-system change had not been re-solved yet.
  const solvedBands = results?.[0]?.perBandLp.length;
  const centres = solvedBands === THIRD_OCTAVE_CENTRES.length ? THIRD_OCTAVE_CENTRES
    : solvedBands === OCTAVE_CENTRES.length ? OCTAVE_CENTRES
      : project.scenario.bandSystem === 'oneThirdOctave' ? THIRD_OCTAVE_CENTRES : OCTAVE_CENTRES;
  // Active period only, and labelled — see the note on `contribHeaders`. The
  // column leads so it can't be mistaken for a band.
  const headers: Array<string | number> = [
    'period', 'receiver_id', 'receiver_name', ...centres.map((c) => `${c} Hz`),
  ];
  const rows: Array<Array<string | number>> = [];
  if (!results) return { headers, rows };
  for (const rxResult of results) {
    const rx = project.receivers.find((r) => r.id === rxResult.receiverId);
    if (!rx) continue;
    const cells: Array<string | number> = [project.scenario.period, rxResult.receiverId, rx.name];
    for (let i = 0; i < centres.length; i++) {
      const v = rxResult.perBandLp[i];
      cells.push(Number.isFinite(v) ? v : '');
    }
    rows.push(cells);
  }
  return { headers, rows };
}

export function exportSpectraCsv(project: Project, results: ReceiverResult[] | null): Blob {
  const { headers, rows } = spectrumRows(project, results);
  return new Blob([toCsv([headers, ...rows])], { type: 'text/csv;charset=utf-8' });
}

export function exportSpectraXlsx(project: Project, results: ReceiverResult[] | null): Blob {
  const { headers, rows } = spectrumRows(project, results);
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, `Per-band ${project.scenario.bandSystem === 'oneThirdOctave' ? '⅓ oct' : 'octave'}`);
  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- 4. Contour lines: KML + SHP ----------

/// Write contour lines as KML LineStrings, one Placemark per (threshold,
/// segment). KML accepts arbitrary attributes via ExtendedData — we tag
/// each line with its dB threshold so the consumer can colour-code.
export function exportContoursKml(project: Project, contours: ContourLineSet[]): Blob {
  const xmlEscape = (s: string) => s.replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]!));
  const placemarks: string[] = [];
  for (const set of contours) {
    for (let segIdx = 0; segIdx < set.lines.length; segIdx++) {
      const seg = set.lines[segIdx];
      const coords = seg.map(([lat, lng]) => `${lng},${lat},0`).join(' ');
      // A named custom line leads with its name; a stepped contour has only
      // its level to identify it.
      const title = set.label
        ? `${set.label} (${set.threshold} dB) — line ${segIdx + 1}`
        : `${set.threshold} ${weightingLabel(weightingFor(project))} — line ${segIdx + 1}`;
      placemarks.push(
        `<Placemark><name>${xmlEscape(title)}</name>` +
        `<ExtendedData><Data name="threshold_db"><value>${set.threshold}</value></Data>` +
        (set.label ? `<Data name="label"><value>${xmlEscape(set.label)}</value></Data>` : '') +
        `</ExtendedData>` +
        `<LineString><coordinates>${coords}</coordinates></LineString></Placemark>`,
      );
    }
  }
  const xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<kml xmlns="http://www.opengis.net/kml/2.2"><Document>` +
    `<name>${xmlEscape(project.name)} — noise contours</name>` +
    placemarks.join('') +
    `</Document></kml>`;
  return new Blob([xml], { type: 'application/vnd.google-earth.kml+xml' });
}

/// Write contour lines as a zipped Esri shapefile bundle (.shp/.shx/.dbf
/// + .prj). One LineString feature per contour segment, with the dB
/// threshold stored as the `THRESH_DB` attribute, in the project's assessment
/// weighting. Returns a Blob ready
/// to download.
///
/// Hand-rolled writer (see `shapefileWriter.ts`) — replaces an earlier
/// `@mapbox/shp-write` integration that mis-quantised numeric DBF fields
/// and ended up writing every record's threshold as the first feature's
/// value (everything was "25.0" regardless of the line's actual dB).
export function exportContoursShp(_project: Project, contours: ContourLineSet[]): Blob {
  // `LABEL` carries a custom line's name and is empty for stepped contours, so
  // one export can hold both and GIS consumers can filter on it.
  const fields = [
    // Neutral name: the value follows the project's assessment weighting, and
    // a DBF field called THRESH_DBA holding dB(C) is a trap for whoever opens
    // it in GIS six months later.
    { name: 'THRESH_DB', type: 'N' as const, width: 8, decimals: 2 },
    { name: 'LABEL', type: 'C' as const, width: 40 },
  ];
  const features: { coords: Array<[number, number]>; properties: Record<string, number | string> }[] = [];
  for (const set of contours) {
    for (const seg of set.lines) {
      features.push({
        // Shapefile coords are (lng, lat) — same as GeoJSON Position.
        coords: seg.map(([lat, lng]) => [lng, lat] as [number, number]),
        properties: { THRESH_DB: set.threshold, LABEL: set.label ?? '' },
      });
    }
  }
  if (features.length === 0) {
    // Build a valid (but empty) bundle so the user gets feedback rather
    // than a crash when the grid hasn't crossed any threshold yet.
    const bundle = buildPolylineShapefile([], fields);
    return buildZip([
      { name: 'noise_contours.shp', bytes: new Uint8Array(bundle.shp) },
      { name: 'noise_contours.shx', bytes: new Uint8Array(bundle.shx) },
      { name: 'noise_contours.dbf', bytes: new Uint8Array(bundle.dbf) },
      { name: 'noise_contours.prj', bytes: new TextEncoder().encode(bundle.prj) },
    ]);
  }
  const bundle = buildPolylineShapefile(features, fields);
  return buildZip([
    { name: 'noise_contours.shp', bytes: new Uint8Array(bundle.shp) },
    { name: 'noise_contours.shx', bytes: new Uint8Array(bundle.shx) },
    { name: 'noise_contours.dbf', bytes: new Uint8Array(bundle.dbf) },
    { name: 'noise_contours.prj', bytes: new TextEncoder().encode(bundle.prj) },
  ]);
}

// ---------- 4b. Source locations as a point shapefile ----------

/// Export EVERY source object as a point in an Esri shapefile (WGS84),
/// capturing its location, name, and properties. BESS-group members are
/// materialised into `project.sources` as individual objects (each with its
/// own `groupId`/`slotKey`), so iterating `project.sources` already yields the
/// individual units — the group as a whole is intentionally NOT a feature.
export function exportSourcesShp(project: Project): Blob {
  const features: { coord: [number, number]; properties: Record<string, number | string> }[] = [];
  const period = project.scenario.period;
  // Modes may differ by period, so one column can't tell the whole story. MODE
  // is what this source is doing in the period being assessed — the same thing
  // the map is showing — and MODE_DEN spells out all three, so the file still
  // says which period it came from once it's been passed around.
  //
  // The catalog is deliberately not consulted: importing it would drag Firebase
  // into a module whose whole job is writing files. An inherited mode shows as
  // "(default)" rather than being resolved to a name.
  const INHERITED = '(default)';
  for (const s of project.sources) {
    if (!Number.isFinite(s.latLng[0]) || !Number.isFinite(s.latLng[1])) continue;
    features.push({
      // Shapefile points are (lng, lat).
      coord: [s.latLng[1], s.latLng[0]],
      properties: {
        SRC_ID: s.id,
        NAME: s.name ?? '',
        KIND: s.kind,
        MODEL_ID: s.modelId ?? '',
        SCOPE: s.catalogScope ?? '',
        HUB_HT_M: s.hubHeight ?? NaN,        // NaN → blank in the .dbf
        ROTOR_M: s.rotorDiameterM ?? NaN,
        ELEV_OFF: s.elevationOffset ?? NaN,
        YAW_DEG: s.yawDeg ?? NaN,
        MODE: modeLabel(modeForPeriod(s.modeOverride, period), INHERITED),
        MODE_DEN: describeModes(s.modeOverride, INHERITED),
        GROUP_ID: s.groupId ?? '',          // empty for standalone sources
        SLOT_KEY: s.slotKey ?? '',
        LAT: s.latLng[0],
        LNG: s.latLng[1],
      },
    });
  }
  // MODE_DEN is three catalog mode names joined with ' / ', and mode names have
  // no length cap — a fixed width silently truncates the night label mid-name,
  // so GIS would show a mode that doesn't exist. DBF fields are fixed-width per
  // FILE, not per row, so size it to this export's longest value (254 is the
  // dBASE hard ceiling; beyond that truncation is unavoidable).
  // MODE is sized from the data for the same reason — a name long enough to be
  // truncated is a mode that does not exist, presented as one that does.
  const widthOf = (field: string, floor: number) => Math.min(254, features.reduce(
    (m, f) => Math.max(m, String(f.properties[field]).length), floor));
  const denWidth = widthOf('MODE_DEN', 80);
  const modeWidth = widthOf('MODE', 40);
  const bundle = buildPointShapefile(features, [
    { name: 'SRC_ID', type: 'C', width: 36 },
    { name: 'NAME', type: 'C', width: 80 },
    { name: 'KIND', type: 'C', width: 12 },
    { name: 'MODEL_ID', type: 'C', width: 40 },
    { name: 'SCOPE', type: 'C', width: 10 },
    { name: 'HUB_HT_M', type: 'N', width: 8, decimals: 1 },
    { name: 'ROTOR_M', type: 'N', width: 8, decimals: 1 },
    { name: 'ELEV_OFF', type: 'N', width: 8, decimals: 1 },
    { name: 'YAW_DEG', type: 'N', width: 7, decimals: 1 },
    { name: 'MODE', type: 'C', width: modeWidth },
    { name: 'MODE_DEN', type: 'C', width: denWidth },
    { name: 'GROUP_ID', type: 'C', width: 36 },
    { name: 'SLOT_KEY', type: 'C', width: 44 },
    { name: 'LAT', type: 'N', width: 13, decimals: 8 },
    { name: 'LNG', type: 'N', width: 13, decimals: 8 },
  ]);
  return buildZip([
    { name: 'sources.shp', bytes: new Uint8Array(bundle.shp) },
    { name: 'sources.shx', bytes: new Uint8Array(bundle.shx) },
    { name: 'sources.dbf', bytes: new Uint8Array(bundle.dbf) },
    { name: 'sources.prj', bytes: new TextEncoder().encode(bundle.prj) },
  ]);
}

// ---------- 5. GeoTIFF grid raster ----------

/// Write the grid's per-cell dB(A) as a single-band Float32 GeoTIFF in
/// EPSG:4326 (WGS84 lat/lng). Hand-rolled minimal writer:
///   - Little-endian
///   - One IFD with the required tags
///   - ModelPixelScale + ModelTiepoint + GeoKeyDirectory for georeferencing
///
/// Spec ref: TIFF 6.0 + GeoTIFF 1.0 (https://docs.ogc.org/is/19-008r4/19-008r4.html).
/// Verified to open in QGIS / ArcGIS / gdalinfo.
export function exportGridGeoTiff(grid: GridResult): Blob {
  return new Blob([gridGeoTiffBytes(grid)], { type: 'image/tiff' });
}

/// The GeoTIFF as raw bytes, so the wind sweep can pack N of them into one zip
/// without round-tripping each through a Blob.
function gridGeoTiffBytes(grid: GridResult): ArrayBuffer {
  const { cols, rows, bounds, dbA } = grid;
  const pixelCount = cols * rows;

  // Pixel data is row-major, north-row-first (GeoTIFF convention).
  // GridResult.dbA is south-row-first → flip rows on the way in.
  const pixels = new Float32Array(pixelCount);
  for (let row = 0; row < rows; row++) {
    const srcRow = rows - 1 - row;
    for (let col = 0; col < cols; col++) {
      pixels[row * cols + col] = dbA[srcRow * cols + col];
    }
  }
  const stripByteCount = pixelCount * 4;     // Float32 = 4 bytes

  // Pixel size in degrees per cell.
  const pxLngDeg = (bounds.ne[1] - bounds.sw[1]) / cols;
  const pxLatDeg = (bounds.ne[0] - bounds.sw[0]) / rows;

  // ---- Tag table (12 IFD entries) ----
  // Layout:
  //   0..7        : TIFF header  (II 42 ifdOffset)
  //   8..start+12 : pixel data
  //   ifdOffset.. : IFD entries (12 × 12 bytes + 2 + 4) + tag data

  // Order matters: tags must be ascending by tag ID.
  // Tag IDs:
  //   256 ImageWidth          SHORT/LONG
  //   257 ImageLength         SHORT/LONG
  //   258 BitsPerSample       SHORT  (32 for Float32)
  //   259 Compression         SHORT  (1 = none)
  //   262 PhotometricInterp.  SHORT  (1 = BlackIsZero — closest valid for grayscale float)
  //   273 StripOffsets        LONG
  //   277 SamplesPerPixel     SHORT  (1)
  //   278 RowsPerStrip        SHORT/LONG
  //   279 StripByteCounts     LONG
  //   339 SampleFormat        SHORT  (3 = IEEE float)
  //   33550 ModelPixelScale   DOUBLE × 3 (sx, sy, sz)
  //   33922 ModelTiepoint     DOUBLE × 6 (i, j, k, x, y, z)
  //   34735 GeoKeyDirectory   SHORT  (header + keys)
  // Optional but harmless:
  //   42113 GDAL_NODATA       ASCII  ("nan\0")

  // Buffers for variable-length tag values held outside the IFD entry.
  const tagDataBuf: Uint8Array[] = [];
  const enqueueTagData = (bytes: Uint8Array): number => {
    // Returns the offset where this blob will end up — filled in later.
    tagDataBuf.push(bytes);
    return tagDataBuf.length - 1;     // index, not offset (resolved at write)
  };

  const modelPixelScale = new Float64Array([Math.abs(pxLngDeg), Math.abs(pxLatDeg), 0]);
  const modelTiepoint = new Float64Array([
    0, 0, 0,                  // raster-space tiepoint (top-left pixel)
    bounds.sw[1],             // X (lng) of top-left
    bounds.ne[0],             // Y (lat) of top-left
    0,
  ]);
  // GeoKeyDirectory: 1 header (4 SHORTs) + 3 keys (4 SHORTs each).
  // Header: KeyDirectoryVersion=1, KeyRevision=1, MinorRevision=0, NumberOfKeys=3
  // Key 1: GTModelTypeGeoKey (1024) = 2 (geographic latitude/longitude)
  // Key 2: GTRasterTypeGeoKey (1025) = 1 (RasterPixelIsArea)
  // Key 3: GeographicTypeGeoKey (2048) = 4326 (WGS84)
  const geoKeyDir = new Uint16Array([
    1, 1, 0, 3,
    1024, 0, 1, 2,
    1025, 0, 1, 1,
    2048, 0, 1, 4326,
  ]);

  const tagDataPxScaleIx = enqueueTagData(new Uint8Array(modelPixelScale.buffer));
  const tagDataTiepointIx = enqueueTagData(new Uint8Array(modelTiepoint.buffer));
  const tagDataGeoKeyIx = enqueueTagData(new Uint8Array(geoKeyDir.buffer));
  const tagDataNodataIx = enqueueTagData(new TextEncoder().encode('nan\0'));

  // ---- Compute byte offsets ----
  const HEADER_SIZE = 8;
  const TAG_COUNT = 13;     // 12 standard + GDAL_NODATA
  const IFD_SIZE = 2 + TAG_COUNT * 12 + 4;
  const stripOffset = HEADER_SIZE;
  const ifdOffset = HEADER_SIZE + stripByteCount;
  const tagDataStart = ifdOffset + IFD_SIZE;
  // Resolve each enqueued tag-data blob's actual offset.
  const tagDataOffsets: number[] = [];
  let cursor = tagDataStart;
  for (const b of tagDataBuf) {
    tagDataOffsets.push(cursor);
    cursor += b.length;
  }
  const totalSize = cursor;

  // ---- Write ----
  const out = new ArrayBuffer(totalSize);
  const u8 = new Uint8Array(out);
  const dv = new DataView(out);
  let p = 0;

  // 1. TIFF header (little-endian).
  u8[p++] = 0x49; u8[p++] = 0x49;       // 'II'
  dv.setUint16(p, 42, true); p += 2;     // magic 42
  dv.setUint32(p, ifdOffset, true); p += 4;

  // 2. Pixel data immediately after header (StripOffsets points here).
  new Uint8Array(out, stripOffset, stripByteCount).set(new Uint8Array(pixels.buffer));
  p = ifdOffset;

  // 3. IFD: count + entries + next-IFD pointer (0).
  dv.setUint16(p, TAG_COUNT, true); p += 2;

  // Helpers for writing IFD entries.
  // Each entry: tag (SHORT), type (SHORT), count (LONG), value/offset (LONG)
  function writeShortValueEntry(tag: number, value: number) {
    dv.setUint16(p, tag, true);             p += 2;
    dv.setUint16(p, 3, true);               p += 2;     // type = SHORT
    dv.setUint32(p, 1, true);               p += 4;     // count = 1
    dv.setUint16(p, value, true);           p += 2;     // value (low half)
    dv.setUint16(p, 0, true);               p += 2;     // padding
  }
  function writeLongValueEntry(tag: number, value: number) {
    dv.setUint16(p, tag, true);             p += 2;
    dv.setUint16(p, 4, true);               p += 2;     // type = LONG
    dv.setUint32(p, 1, true);               p += 4;
    dv.setUint32(p, value, true);           p += 4;
  }
  function writeOffsetEntry(tag: number, type: number, count: number, dataIndex: number) {
    dv.setUint16(p, tag, true);             p += 2;
    dv.setUint16(p, type, true);            p += 2;
    dv.setUint32(p, count, true);           p += 4;
    dv.setUint32(p, tagDataOffsets[dataIndex], true); p += 4;
  }

  writeLongValueEntry(256, cols);                                    // ImageWidth
  writeLongValueEntry(257, rows);                                    // ImageLength
  writeShortValueEntry(258, 32);                                     // BitsPerSample
  writeShortValueEntry(259, 1);                                      // Compression: none
  writeShortValueEntry(262, 1);                                      // BlackIsZero
  writeLongValueEntry(273, stripOffset);                             // StripOffsets
  writeShortValueEntry(277, 1);                                      // SamplesPerPixel
  writeLongValueEntry(278, rows);                                    // RowsPerStrip = full image
  writeLongValueEntry(279, stripByteCount);                          // StripByteCounts
  writeShortValueEntry(339, 3);                                      // SampleFormat = IEEE float
  writeOffsetEntry(33550, 12, 3, tagDataPxScaleIx);                  // ModelPixelScaleTag (DOUBLE × 3)
  writeOffsetEntry(33922, 12, 6, tagDataTiepointIx);                 // ModelTiepointTag (DOUBLE × 6)
  writeOffsetEntry(34735, 3, geoKeyDir.length, tagDataGeoKeyIx);     // GeoKeyDirectoryTag (SHORT × 16)
  writeOffsetEntry(42113, 2, 4, tagDataNodataIx);                    // GDAL_NODATA = "nan"

  dv.setUint32(p, 0, true); p += 4;                                  // next IFD offset = 0

  // 4. Variable-length tag data.
  for (let i = 0; i < tagDataBuf.length; i++) {
    new Uint8Array(out, tagDataOffsets[i], tagDataBuf[i].length).set(tagDataBuf[i]);
  }

  return out;
}

// ---------- CSV helper ----------

function toCsv(rows: Array<Array<string | number>>): string {
  const escape = (cell: string | number): string => {
    const s = cell == null ? '' : String(cell);
    // Quote-wrap if the cell contains a comma, quote, or newline.
    if (/[,"\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return rows.map((r) => r.map(escape).join(',')).join('\n');
}

// ---------- Tiny convenience wrapper: filename-decorated Blob ----------

/// Build a sensible default filename stem for a given project and time.
export function defaultFilenameStem(project: Project, suffix: string): string {
  const slug = (project.name || 'bessty')
    .toLowerCase()
    .replace(/[^\w]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || 'bessty';
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return `${slug}_${suffix}_${ts}`;
}


/// What a stopped turbine reads as in the reduction legend. Not a real level —
/// a floor far below any operating mode, so the legend's scale still sorts and
/// a reader sees at a glance that Off is not a quiet mode but no mode.
const OFF_REDUCTION_DB = -200;

// ---------- 6. Curtailment schedule ----------

/// One sheet per period: turbine rows × wind-speed columns of mode names, then
/// the rows that let a reader check the schedule rather than take it on trust —
/// generation given up, which receiver is binding, and how much headroom is
/// left at it. A settings sheet records what the run assumed.
/// The margin comes off the RESULT, not from the caller. It used to be passed
/// in from the study window's live input, which can be edited after a run
/// without invalidating the table — so a study run at 0 dB could be exported
/// with a settings sheet claiming 3 dB of margin it never had.
export function exportCurtailmentXlsx(
  project: Project,
  result: CurtailmentResult,
): Blob {
  const wb = XLSX.utils.book_new();
  const periods = PERIODS.filter((p) => result.cells.some((c) => c.period === p));

  // Wind directions that were actually swept. Empty for a non-directional run,
  // where every receiver was treated as downwind.
  const directions = [...new Set(result.cells.map((c) => c.windDirectionDeg))]
    .filter((d): d is number => d !== undefined)
    .sort((a, b) => a - b);
  const dirKeys: Array<number | undefined> = directions.length > 0 ? directions : [undefined];

  // Model display name per turbine, from the legend the run carried.
  const modelOf = new Map<string, string>();
  for (const t of result.turbines) modelOf.set(t.id, result.legend[0]?.modelName ?? '');

  for (const period of periods) {
    const speeds = [...new Set(
      result.cells.filter((c) => c.period === period).map((c) => c.windSpeed),
    )].sort((a, b) => a - b);
    const rows: Array<Array<string | number>> = [];
    const speedHeads = speeds.map((w) => `${w} m/s`);

    // Legend first, matching how these schedules are normally issued: what each
    // mode gives up in sound power, per wind speed, with the un-curtailed mode
    // reading zero. A table of mode names without it is a set of labels nobody
    // downstream can check.
    for (const legend of result.legend) {
      rows.push([
        result.legend.length > 1
          ? `Sound Power Level Reduction dB(A) — ${legend.modelName}`
          : 'Sound Power Level Reduction dB(A)',
        ...speedHeads,
      ]);
      for (const m of legend.modes) {
        rows.push([
          m.name,
          ...speeds.map((w) => {
            const i = legend.windSpeeds.indexOf(w);
            return i >= 0 ? m.reductionDb[i] : '';
          }),
        ]);
      }
      // The stopped state belongs in the legend as the floor of the same scale.
      rows.push([MODE_OFF_LABEL, ...speeds.map(() => OFF_REDUCTION_DB)]);
      rows.push([]);
    }

    rows.push(['Turbine Modes']);
    // A "Wind from" column only when there is something to put in it, so a
    // non-directional export keeps exactly the shape it had.
    const lead = directions.length > 0
      ? ['Wind from', 'Turbine', 'Turbine Type', 'Latitude', 'Longitude']
      : ['Turbine', 'Turbine Type', 'Latitude', 'Longitude'];
    rows.push([...lead, ...speedHeads]);

    for (const dir of dirKeys) {
      const cells = speeds.map((w) => result.cells.find(
        (c) => c.period === period && c.windSpeed === w && c.windDirectionDeg === dir,
      ));
      const label = dir === undefined ? [] : [describeWindFrom(dir)];
      for (const t of result.turbines) {
        const src = project.sources.find((s) => s.id === t.id);
        rows.push([
          ...label, t.name,
          modelOf.get(t.id) ?? '',
          src ? Number(src.latLng[0].toFixed(6)) : '',
          src ? Number(src.latLng[1].toFixed(6)) : '',
          // An infeasible cell prescribes nothing; a blank would read as "no
          // curtailment needed", which is the opposite of what it means.
          ...cells.map((c) => (c?.status === 'optimal' ? modeLabel(c.modes[t.id], '') : 'n/a')),
        ]);
      }
      // The summary rows sit under the mode columns, so they need padding for
      // the identity columns the turbine rows carry.
      const pad = dir === undefined ? ['', '', ''] : ['', '', '', ''];
      rows.push([
        'Lost kW', ...pad,
        ...cells.map((c) => (c?.status === 'optimal' ? Number(c.lostKw.toFixed(1)) : 'n/a')),
      ]);
      rows.push(['Binding receiver', ...pad, ...cells.map((c) => c?.bindingReceiverName ?? '')]);
      rows.push([
        'Headroom dB', ...pad,
        ...cells.map((c) => (c?.marginAtBindingDb == null ? '' : Number(c.marginAtBindingDb.toFixed(2)))),
      ]);
      rows.push(['Status', ...pad, ...cells.map((c) => c?.status ?? '')]);
      rows.push(['Note', ...pad, ...cells.map((c) => c?.detail ?? '')]);
      rows.push([]);
    }
    XLSX.utils.book_append_sheet(
      wb, XLSX.utils.aoa_to_sheet(rows), PERIOD_LABEL[period],
    );
  }

  const info: Array<Array<string | number>> = [
    ['Project', project.name],
    ['Generated', new Date().toISOString()],
    ['Objective', 'Minimise generation lost, per wind speed and period, subject to every receiver complying'],
    ['Solver', 'HiGHS (MILP) — each cell solved to a proven global optimum'],
    ['Margin below limit (dB)', result.marginDb],
    ['Assessment weighting', weightingLabel(weightingFor(project))],
    ['Limit comparison', limitComparisonFor(project)],
    ['Wind-speed limits', windSpeedLimitsEnabled(project) ? 'on' : 'off (scalar per-period limits)'],
    ['Wind direction', directions.length > 0
      ? `${directions.length} directions swept`
      : 'not modelled — every receiver treated as downwind (ISO 9613-2)'],
    ...(directions.length > 0 ? [[
      'Note',
      'Within ±60° of downwind no adjustment; −2 dB elsewhere. Approximate, applied to '
      + 'WIND TURBINES ONLY, and only for this optimisation — a BESS or substation is '
      + 'never adjusted, and every level BESSTY reports still treats every receiver as '
      + 'downwind. Reported levels will therefore read higher than a directional cell '
      + 'assumed.',
    ]] : []),
    ['Band system', project.scenario.bandSystem],
    ['DOmega (dB)', projectDOmegaDb(project)],
    ['Standard', `ISO 9613-2:${project.settings?.standard ?? '2024'}`],
  ];
  const tonality = tonalitySettingsFor(project);
  if (tonality.enabled && tonality.applyPenalty) {
    info.push([
      'Tonality penalty (dB)', tonality.penaltyDb,
    ], [
      'Note',
      'The penalty was subtracted from every cap before optimising. It depends on the '
      + 'spectrum, which depends on the schedule, so it cannot be known in advance; '
      + 'assuming it always applies may curtail more than strictly necessary.',
    ]);
  }
  if (result.warnings.length > 0) {
    info.push([], ['Warnings']);
    for (const w of result.warnings) info.push([w]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Settings');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

// ---------- 7. Wind-speed sweep ----------

/// Per period: three stacked blocks of receiver rows × wind-speed columns —
/// level, limit, margin — then a summary block naming each receiver's worst wind
/// speed and where it fails.
///
/// Stacked blocks rather than the colour-coded single table the plan sketched,
/// because SheetJS's community build writes no cell styling: a "conditional
/// format" here would have to be a formula whose inputs the reader cannot see.
/// Three explicit blocks say the same thing in numbers that can be checked, and
/// they solve a problem colour could not — with limit tables in use the LIMIT
/// varies along the row too, and a single table has nowhere to show it.
export function exportWindSweepXlsx(project: Project, sweep: SweepResult): Blob {
  const wb = XLSX.utils.book_new();
  const speeds = sweepSpeeds(sweep, 'receivers');
  const periods = sweepPeriods(sweep, 'receivers');
  const wLabel = weightingLabel(weightingFor(project));

  for (const period of periods) {
    const rows = sweepReceiverRows(project, sweep, period);
    const aoa: Array<Array<string | number>> = [];
    const header = (title: string) => {
      aoa.push([title, ...speeds.map((w) => `${w} m/s`)]);
    };
    // Two decimals, because the verdict is computed UNROUNDED. At one decimal a
    // level of 40.04 against a 40 dB limit printed "40 / 40 / 0 / fail" — a row
    // contradicting its own margin caption, with the 0.04 dB that decided it
    // nowhere in the file. The single-run receiver export already uses 2 dp.
    const num = (v: number | null | undefined, dp = 2) => (v == null ? '' : Number(v.toFixed(dp)));

    aoa.push([`${PERIOD_LABEL[period]} — ${wLabel}`]);
    aoa.push([]);
    header(`Level at receiver (${wLabel})`);
    for (const r of rows) aoa.push([r.name, ...r.cells.map((c) => num(c.levelDb))]);
    aoa.push([]);

    header('Limit');
    for (const r of rows) aoa.push([r.name, ...r.cells.map((c) => num(c.limitDb))]);
    aoa.push([]);

    header('Margin (limit − level; negative is over)');
    for (const r of rows) aoa.push([r.name, ...r.cells.map((c) => num(c.marginDb))]);
    aoa.push([]);

    aoa.push([
      'Receiver', 'Latitude', 'Longitude', 'Height (m)',
      'Worst wind speed (m/s)', 'Level there', 'Limit there', 'Margin there',
      'Verdict', 'Fails at (m/s)', 'Limit read from',
    ]);
    for (const r of rows) {
      aoa.push([
        r.name, r.lat, r.lng, r.heightAboveGroundM,
        r.worst?.windSpeed ?? '', num(r.worst?.levelDb), num(r.worst?.limitDb),
        num(r.worst?.marginDb),
        // The verdict is over the WHOLE sweep: complying at the wind speed that
        // happens to be on screen says nothing about the one next to it, and a
        // sweep exists precisely because those differ.
        //
        // "No level" is NOT "pass". `exceedsLimit` answers false for a null
        // level — correctly, since absence is not exceedance — so a receiver
        // that never solved has an empty `failsAt` and used to fall through to
        // "pass" with every other cell in its row blank. A receiver dropped for
        // non-finite coordinates, or added after the run, was certified
        // compliant in a planning submission on the strength of no data at all.
        // The single-run receiver export has always answered '—' here.
        r.cells.some((c) => c.levelDb != null)
          ? (r.failsAt.length > 0 ? 'fail' : 'pass')
          : '—',
        r.failsAt.join(', '),
        limitBasis(r),
      ]);
    }
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), PERIOD_LABEL[period]);
  }

  const info: Array<Array<string | number>> = [
    ['Project', project.name],
    ['Generated', new Date().toISOString()],
    ['What this is', 'One full solve per wind speed — not an extrapolation from a single run'],
    ['Wind speeds (m/s)', speeds.join(', ')],
    ['Periods', periods.map((p) => PERIOD_LABEL[p]).join(', ')],
    ['Solves run', sweep.states.length],
    ['Elapsed (s)', Number((sweep.elapsedMs / 1000).toFixed(1))],
    ['Receivers solved', sweep.config.receivers ? 'yes' : 'no'],
    ['Contour grids solved', sweep.config.grids ? 'yes' : 'no'],
    ...(sweep.gridSpacingM != null ? [['Grid spacing (m)', sweep.gridSpacingM]] : []),
    ...(sweep.receiverHeightM != null ? [['Receiver height (m)', sweep.receiverHeightM]] : []),
    ['Assessment weighting', wLabel],
    ['Limit comparison', limitComparisonFor(project)],
    ['Wind-speed limits', windSpeedLimitsEnabled(project)
      ? 'on — the limit is read per wind speed from each receiver’s table'
      : 'off — one scalar limit per period, the same at every wind speed'],
    ['Levels are', 'assessed levels: the solved level plus any tonality penalty, i.e. the '
      + 'number each pass/fail verdict is made on'],
    ['Wind direction', 'not modelled — every receiver is treated as downwind of every source, '
      + 'as ISO 9613-2 does'],
    ['Band system', project.scenario.bandSystem],
    ['DOmega (dB)', projectDOmegaDb(project)],
    ['Standard', `ISO 9613-2:${project.settings?.standard ?? '2024'}`],
  ];
  if (sweep.warnings.length > 0) {
    info.push([], ['Notes']);
    for (const w of sweep.warnings) info.push([w]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(info), 'Settings');

  const buf = XLSX.write(wb, { bookType: 'xlsx', type: 'array' }) as ArrayBuffer;
  return new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

/// Where a receiver's limits came from across the sweep. `'clamped'` is the one
/// worth naming: it means a wind speed fell off the end of that receiver's table
/// and the nearest entered column was used — a reading the author of the table
/// never explicitly made.
function limitBasis(row: SweepReceiverRow): string {
  const kinds = new Set(row.cells.map((c) => c.limitSource));
  if (kinds.size === 0) return '';
  if (kinds.has('clamped')) {
    const off = row.cells.filter((c) => c.limitSource === 'clamped').map((c) => c.windSpeed);
    return `table (nearest column used at ${off.join(', ')} m/s)`;
  }
  return kinds.has('table') ? 'table' : 'scalar per-period limit';
}

/// Every swept contour in ONE zipped shapefile, each feature carrying the wind
/// speed and period that produced it.
///
/// One bundle rather than one per state on purpose: the consultant wants to open
/// the sweep, filter to `WS_MS = 10 AND PERIOD = 'night'`, and style it. Forty
/// separate shapefiles hold the same data arranged so that comparing them is
/// manual work.
export function exportWindSweepContoursShp(
  _project: Project,
  layers: readonly SweepContourLayer[],
): Blob {
  const fields = [
    { name: 'WS_MS', type: 'N' as const, width: 6, decimals: 1 },
    { name: 'PERIOD', type: 'C' as const, width: 8 },
    // Neutral name: the value follows the project's assessment weighting, and a
    // DBF field called THRESH_DBA holding dB(C) is a trap for whoever opens it
    // in GIS six months later.
    { name: 'THRESH_DB', type: 'N' as const, width: 8, decimals: 2 },
    { name: 'LABEL', type: 'C' as const, width: 40 },
  ];
  const features: { coords: Array<[number, number]>; properties: Record<string, number | string> }[] = [];
  for (const layer of layers) {
    for (const set of layer.sets) {
      for (const seg of set.lines) {
        features.push({
          // Shapefile coords are (lng, lat) — same as GeoJSON Position.
          coords: seg.map(([lat, lng]) => [lng, lat] as [number, number]),
          properties: {
            WS_MS: layer.windSpeed,
            PERIOD: layer.period,
            THRESH_DB: set.threshold,
            LABEL: set.label ?? '',
          },
        });
      }
    }
  }
  // An empty bundle is still a valid bundle — the user gets a file that says
  // "no contour crossed a display level" rather than a crash.
  const bundle = buildPolylineShapefile(features, fields);
  return buildZip([
    { name: 'wind_sweep_contours.shp', bytes: new Uint8Array(bundle.shp) },
    { name: 'wind_sweep_contours.shx', bytes: new Uint8Array(bundle.shx) },
    { name: 'wind_sweep_contours.dbf', bytes: new Uint8Array(bundle.dbf) },
    { name: 'wind_sweep_contours.prj', bytes: new TextEncoder().encode(bundle.prj) },
  ]);
}

/// The KML sibling: one Folder per (period, wind speed), so Google Earth's tree
/// gives the layer switching that the shapefile gets from an attribute filter.
/// Every folder after the first is hidden — forty contour sets drawn on top of
/// one another is not a map.
export function exportWindSweepContoursKml(
  project: Project,
  layers: readonly SweepContourLayer[],
): Blob {
  const folders: string[] = [];
  layers.forEach((layer, i) => {
    const placemarks: string[] = [];
    for (const set of layer.sets) {
      for (let segIdx = 0; segIdx < set.lines.length; segIdx++) {
        const coords = set.lines[segIdx].map(([lat, lng]) => `${lng},${lat},0`).join(' ');
        const title = set.label
          ? `${set.label} (${set.threshold} dB)`
          : `${set.threshold} ${weightingLabel(weightingFor(project))}`;
        placemarks.push(
          `<Placemark><name>${kmlEscape(`${title} — line ${segIdx + 1}`)}</name>`
          + '<ExtendedData>'
          + `<Data name="wind_speed_ms"><value>${layer.windSpeed}</value></Data>`
          + `<Data name="period"><value>${layer.period}</value></Data>`
          + `<Data name="threshold_db"><value>${set.threshold}</value></Data>`
          + (set.label ? `<Data name="label"><value>${kmlEscape(set.label)}</value></Data>` : '')
          + '</ExtendedData>'
          + `<LineString><coordinates>${coords}</coordinates></LineString></Placemark>`,
        );
      }
    }
    folders.push(
      `<Folder><name>${kmlEscape(`${PERIOD_LABEL[layer.period]} — ${layer.windSpeed} m/s`)}</name>`
      + `<open>0</open><visibility>${i === 0 ? 1 : 0}</visibility>`
      + placemarks.join('')
      + '</Folder>',
    );
  });
  const xml =
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    + '<kml xmlns="http://www.opengis.net/kml/2.2"><Document>'
    + `<name>${kmlEscape(project.name)} — wind-speed sweep</name>`
    + folders.join('')
    + '</Document></kml>';
  return new Blob([xml], { type: 'application/vnd.google-earth.kml+xml' });
}

function kmlEscape(s: string): string {
  return s.replace(/[<>&'"]/g, (c) => ({
    '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;',
  }[c]!));
}

/// One GeoTIFF per solved state, zipped: `grid_ws08_night.tif`.
///
/// The wind speed is zero-padded so the files sort in wind-speed order in every
/// file manager and in the zip's own listing — `ws10` before `ws8` is exactly
/// the small wrongness that makes a reader doubt the rest of the export.
///
/// Periods that shared a solve share a raster, so their files are byte-identical.
/// They are still written separately: the user asked for those periods, and a
/// missing file reads as a failed solve rather than as "these two are the same".
export function exportWindSweepGeoTiffZip(sweep: SweepResult): Blob {
  const entries = sweep.states
    .filter((s) => s.grid != null)
    .map((s) => ({
      name: `grid_ws${String(s.windSpeed).padStart(2, '0')}_${s.period}.tif`,
      bytes: new Uint8Array(gridGeoTiffBytes(s.grid!)),
    }));
  return buildZip(entries);
}

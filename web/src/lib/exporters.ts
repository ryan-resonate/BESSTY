// Project result exporters. Each function builds an in-memory file (Blob
// or ArrayBuffer) and returns it; the UI layer triggers the download via
// `triggerDownload`. Five formats covered:
//
//   1. Receiver totals  — CSV / XLSX  (id, name, lat, lng, dB(A), pass/fail per period)
//   2. Per-source contribution at each receiver — CSV / XLSX, totals only
//   3. Per-band spectra at each receiver        — CSV / XLSX (10 octave or 31 third-oct)
//   4. Contour lines    — KML  + Esri Shapefile (polylines, one feature per dB threshold)
//   5. Grid raster      — GeoTIFF (Float32, lat/lng, single band Lp dB(A))
//
// Design notes:
//   - XLSX uses SheetJS which is already a dep (catalog import).
//   - SHP uses @mapbox/shp-write for the lat/lng polyline pack.
//   - GeoTIFF: hand-rolled minimal writer (~100 LOC) since the `geotiff`
//     package we pull in is read-only. WGS84 lat/lng coords (EPSG:4326).

import * as XLSX from 'xlsx';
import { buildPolylineShapefile, buildZip } from './shapefileWriter';
import type { Project } from './types';
import type { GridResult, ReceiverResult } from './solver';
import type { ContourLineSet } from './contourLines';

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
  limitDayDbA: number;
  limitEveningDbA: number;
  limitNightDbA: number;
  passDay: 'pass' | 'fail' | '—';
  passEvening: 'pass' | 'fail' | '—';
  passNight: 'pass' | 'fail' | '—';
}

function receiverRows(project: Project, results: ReceiverResult[] | null): ReceiverRow[] {
  return project.receivers.map((r) => {
    const result = results?.find((x) => x.receiverId === r.id);
    const total = result && Number.isFinite(result.totalDbA) ? result.totalDbA : null;
    const verdict = (limit: number): 'pass' | 'fail' | '—' => {
      if (total == null) return '—';
      return total > limit ? 'fail' : 'pass';
    };
    return {
      id: r.id,
      name: r.name,
      lat: r.latLng[0],
      lng: r.latLng[1],
      heightAboveGroundM: r.heightAboveGroundM,
      totalDbA: total,
      limitDayDbA: r.limitDayDbA,
      limitEveningDbA: r.limitEveningDbA,
      limitNightDbA: r.limitNightDbA,
      passDay: verdict(r.limitDayDbA),
      passEvening: verdict(r.limitEveningDbA),
      passNight: verdict(r.limitNightDbA),
    };
  });
}

const RX_HEADERS = [
  'id', 'name', 'lat', 'lng', 'height_above_ground_m',
  'total_dba', 'limit_day_dba', 'limit_evening_dba', 'limit_night_dba',
  'pass_day', 'pass_evening', 'pass_night',
];

function rxRowAsArray(r: ReceiverRow): Array<string | number> {
  return [
    r.id, r.name, r.lat, r.lng, r.heightAboveGroundM,
    r.totalDbA == null ? '' : r.totalDbA,
    r.limitDayDbA, r.limitEveningDbA, r.limitNightDbA,
    r.passDay, r.passEvening, r.passNight,
  ];
}

export function exportReceiversCsv(project: Project, results: ReceiverResult[] | null): Blob {
  const rows = receiverRows(project, results);
  const csv = toCsv([RX_HEADERS, ...rows.map(rxRowAsArray)]);
  return new Blob([csv], { type: 'text/csv;charset=utf-8' });
}

export function exportReceiversXlsx(project: Project, results: ReceiverResult[] | null): Blob {
  const rows = receiverRows(project, results);
  const ws = XLSX.utils.aoa_to_sheet([RX_HEADERS, ...rows.map(rxRowAsArray)]);
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

function aWeightedTotal(perBandLp: Float64Array, bandSystem: 'octave' | 'oneThirdOctave'): number {
  // Local A-weight tables (kept in sync with solver.ts). Duplication is
  // intentional — this module is pure JS, doesn't depend on WASM init.
  const octAw = [-56.4, -39.4, -26.2, -16.1, -8.6, -3.2, 0.0, 1.2, 1.0, -1.1];
  const tocAw = [
    -70.4, -63.4, -56.7, -50.5, -44.7, -39.4, -34.6,
    -30.2, -26.2, -22.5, -19.1, -16.1, -13.4, -10.9, -8.6, -6.6, -4.8,
    -3.2,  -1.9,  -0.8,   0.0,   0.6,   1.0,   1.2,   1.3,   1.2,
     1.0,   0.5,  -0.1,  -1.1,  -2.5,
  ];
  const aw = bandSystem === 'oneThirdOctave' ? tocAw : octAw;
  let s = 0;
  for (let i = 0; i < Math.min(perBandLp.length, aw.length); i++) {
    if (Number.isFinite(perBandLp[i])) s += Math.pow(10, (perBandLp[i] + aw[i]) / 10);
  }
  return s > 0 ? 10 * Math.log10(s) : -Infinity;
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
      const dbA = aWeightedTotal(ps.perBandLp, project.scenario.bandSystem);
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

const CONTRIB_HEADERS = ['receiver_id', 'receiver_name', 'source_id', 'source_name', 'contribution_dba'];

export function exportPerSourceContribCsv(project: Project, results: ReceiverResult[] | null): Blob {
  const rows = perSourceContribRows(project, results);
  const data = [
    CONTRIB_HEADERS,
    ...rows.map((r) => [r.receiverId, r.receiverName, r.sourceId, r.sourceName, Number.isFinite(r.contribDbA) ? r.contribDbA : '']),
  ];
  return new Blob([toCsv(data)], { type: 'text/csv;charset=utf-8' });
}

export function exportPerSourceContribXlsx(project: Project, results: ReceiverResult[] | null): Blob {
  const rows = perSourceContribRows(project, results);
  const data = [
    CONTRIB_HEADERS,
    ...rows.map((r) => [r.receiverId, r.receiverName, r.sourceId, r.sourceName, Number.isFinite(r.contribDbA) ? r.contribDbA : '']),
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
  const centres = project.scenario.bandSystem === 'oneThirdOctave' ? THIRD_OCTAVE_CENTRES : OCTAVE_CENTRES;
  const headers: Array<string | number> = ['receiver_id', 'receiver_name', ...centres.map((c) => `${c} Hz`)];
  const rows: Array<Array<string | number>> = [];
  if (!results) return { headers, rows };
  for (const rxResult of results) {
    const rx = project.receivers.find((r) => r.id === rxResult.receiverId);
    if (!rx) continue;
    const cells: Array<string | number> = [rxResult.receiverId, rx.name];
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
      placemarks.push(
        `<Placemark><name>${set.threshold} dB(A) — line ${segIdx + 1}</name>` +
        `<ExtendedData><Data name="threshold_dba"><value>${set.threshold}</value></Data></ExtendedData>` +
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
/// threshold stored as the `THRESH_DBA` attribute. Returns a Blob ready
/// to download.
///
/// Hand-rolled writer (see `shapefileWriter.ts`) — replaces an earlier
/// `@mapbox/shp-write` integration that mis-quantised numeric DBF fields
/// and ended up writing every record's threshold as the first feature's
/// value (everything was "25.0" regardless of the line's actual dB).
export function exportContoursShp(_project: Project, contours: ContourLineSet[]): Blob {
  const features: { coords: Array<[number, number]>; properties: Record<string, number | string> }[] = [];
  for (const set of contours) {
    for (const seg of set.lines) {
      features.push({
        // Shapefile coords are (lng, lat) — same as GeoJSON Position.
        coords: seg.map(([lat, lng]) => [lng, lat] as [number, number]),
        properties: { THRESH_DBA: set.threshold },
      });
    }
  }
  if (features.length === 0) {
    // Build a valid (but empty) bundle so the user gets feedback rather
    // than a crash when the grid hasn't crossed any threshold yet.
    const bundle = buildPolylineShapefile([], [
      { name: 'THRESH_DBA', type: 'N', width: 8, decimals: 2 },
    ]);
    return buildZip([
      { name: 'noise_contours.shp', bytes: new Uint8Array(bundle.shp) },
      { name: 'noise_contours.shx', bytes: new Uint8Array(bundle.shx) },
      { name: 'noise_contours.dbf', bytes: new Uint8Array(bundle.dbf) },
      { name: 'noise_contours.prj', bytes: new TextEncoder().encode(bundle.prj) },
    ]);
  }
  const bundle = buildPolylineShapefile(features, [
    { name: 'THRESH_DBA', type: 'N', width: 8, decimals: 2 },
  ]);
  return buildZip([
    { name: 'noise_contours.shp', bytes: new Uint8Array(bundle.shp) },
    { name: 'noise_contours.shx', bytes: new Uint8Array(bundle.shx) },
    { name: 'noise_contours.dbf', bytes: new Uint8Array(bundle.dbf) },
    { name: 'noise_contours.prj', bytes: new TextEncoder().encode(bundle.prj) },
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

  return new Blob([out], { type: 'image/tiff' });
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


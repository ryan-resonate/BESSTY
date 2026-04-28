// Minimal Esri shapefile writer for PolyLine features + a DBF attribute
// table. Replaces `@mapbox/shp-write` (which mis-quantises numeric DBF
// fields and dropped the per-feature threshold attribute on every line).
//
// Output: a zipped bundle of .shp / .shx / .dbf / .prj. WGS84 coords
// (EPSG:4326). Validated against `ogrinfo` and QGIS open-as-vector.
//
// Spec refs:
//   - Shapefile: ESRI white paper, July 1998
//   - DBF: dBase III (xBase) — 32-byte header + 32 bytes per field
//
// Scope is intentionally narrow:
//   - PolyLine geometry only (shape type 3)
//   - DBF columns: numeric (N, max width 19) and character (C, max width 254)
//   - Single-part lines per record (each feature = one polyline ring)
//
// Anything outside that throws — keeps the implementation under ~300 LOC.

// Embedded JSZip-equivalent: instead of pulling another zip dep, we hand-
// roll a tiny STORE (no compression) zip writer. shapefile bundles are
// usually small (a few hundred KB) so the inflation cost is negligible.

interface PolylineFeature {
  /// One polyline per feature. Coordinates in WGS84 (lng, lat) order.
  coords: Array<[number, number]>;
  /// Attribute values keyed by field name. Must match a registered field.
  properties: Record<string, number | string>;
}

interface NumericField { name: string; type: 'N'; width: number; decimals: number; }
interface CharField    { name: string; type: 'C'; width: number; }
type DbfField = NumericField | CharField;

export interface ShapefileBundle {
  shp: ArrayBuffer;
  shx: ArrayBuffer;
  dbf: ArrayBuffer;
  prj: string;
}

/// Build the four shapefile sidecar files for a list of PolyLine features.
/// Field names ≤ 10 chars (DBF limit) and ASCII only.
export function buildPolylineShapefile(
  features: PolylineFeature[],
  fields: DbfField[],
): ShapefileBundle {
  // ---- 1. Compute bounding box across every coord ----
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const f of features) {
    for (const [x, y] of f.coords) {
      if (x < xMin) xMin = x;
      if (x > xMax) xMax = x;
      if (y < yMin) yMin = y;
      if (y > yMax) yMax = y;
    }
  }
  if (!Number.isFinite(xMin)) {
    xMin = yMin = 0; xMax = yMax = 0;
  }

  // ---- 2. SHP file ----
  // Each PolyLine record content:
  //   shape type LE int32 (3) + box (4 doubles = 32 bytes) +
  //   numParts LE int32 (1) + numPoints LE int32 + parts[1] LE int32 (0)
  //   + points (numPoints × 2 doubles)
  // Plus the 8-byte record header (record number BE int32 + content length BE int32).
  // SHP file header is 100 bytes.
  let shpBodySize = 0;
  const recordSizes: number[] = [];   // content size in 16-bit words per record
  for (const f of features) {
    const numPoints = f.coords.length;
    const contentBytes = 4 + 32 + 4 + 4 + 4 + numPoints * 16;
    shpBodySize += 8 + contentBytes;
    recordSizes.push(contentBytes / 2);
  }
  const shpFile = new ArrayBuffer(100 + shpBodySize);
  const shpView = new DataView(shpFile);
  writeShpHeader(shpView, shpFile.byteLength, xMin, yMin, xMax, yMax, 3);

  // SHX header is identical; record entries are 8 bytes each.
  const shxFile = new ArrayBuffer(100 + features.length * 8);
  const shxView = new DataView(shxFile);
  writeShpHeader(shxView, shxFile.byteLength, xMin, yMin, xMax, yMax, 3);

  let shpCursor = 100;
  let shxCursor = 100;
  for (let i = 0; i < features.length; i++) {
    const f = features[i];
    const recordOffsetW = shpCursor / 2;     // in 16-bit words
    const contentLengthW = recordSizes[i];

    // SHX entry
    shxView.setInt32(shxCursor, recordOffsetW, false);     shxCursor += 4;
    shxView.setInt32(shxCursor, contentLengthW, false);    shxCursor += 4;

    // Record header
    shpView.setInt32(shpCursor, i + 1, false); shpCursor += 4;     // record # (1-based, big-endian)
    shpView.setInt32(shpCursor, contentLengthW, false); shpCursor += 4;

    // Record content
    shpView.setInt32(shpCursor, 3, true); shpCursor += 4;     // shape type = PolyLine
    // Per-record bounding box
    let fxMin = Infinity, fyMin = Infinity, fxMax = -Infinity, fyMax = -Infinity;
    for (const [x, y] of f.coords) {
      if (x < fxMin) fxMin = x; if (x > fxMax) fxMax = x;
      if (y < fyMin) fyMin = y; if (y > fyMax) fyMax = y;
    }
    shpView.setFloat64(shpCursor, fxMin, true); shpCursor += 8;
    shpView.setFloat64(shpCursor, fyMin, true); shpCursor += 8;
    shpView.setFloat64(shpCursor, fxMax, true); shpCursor += 8;
    shpView.setFloat64(shpCursor, fyMax, true); shpCursor += 8;
    shpView.setInt32(shpCursor, 1, true); shpCursor += 4;             // numParts
    shpView.setInt32(shpCursor, f.coords.length, true); shpCursor += 4; // numPoints
    shpView.setInt32(shpCursor, 0, true); shpCursor += 4;             // parts[0] = 0
    for (const [x, y] of f.coords) {
      shpView.setFloat64(shpCursor, x, true); shpCursor += 8;
      shpView.setFloat64(shpCursor, y, true); shpCursor += 8;
    }
  }

  // ---- 3. DBF file ----
  // Header: 32 bytes + 32 per field + 1-byte terminator (0x0D).
  // Records: 1 deletion-flag byte + each field padded to its declared width.
  const recordLen = 1 + fields.reduce((s, f) => s + f.width, 0);
  const headerLen = 32 + 32 * fields.length + 1;
  const dbfFile = new ArrayBuffer(headerLen + recordLen * features.length + 1);   // +1 for EOF marker
  const dbfBytes = new Uint8Array(dbfFile);
  const dbfView = new DataView(dbfFile);

  dbfBytes[0] = 0x03;    // dBase III, no DBT
  // Date written: YY-1900, MM, DD
  const now = new Date();
  dbfBytes[1] = now.getFullYear() - 1900;
  dbfBytes[2] = now.getMonth() + 1;
  dbfBytes[3] = now.getDate();
  dbfView.setUint32(4, features.length, true);
  dbfView.setUint16(8, headerLen, true);
  dbfView.setUint16(10, recordLen, true);
  // Bytes 12..31 reserved/zero.

  // Field descriptors.
  let p = 32;
  for (const fld of fields) {
    const name = fld.name.slice(0, 10);
    for (let j = 0; j < name.length; j++) dbfBytes[p + j] = name.charCodeAt(j);
    // Bytes p+10 = field type ASCII
    dbfBytes[p + 11] = fld.type.charCodeAt(0);
    dbfBytes[p + 16] = fld.width;
    if (fld.type === 'N') dbfBytes[p + 17] = (fld as NumericField).decimals;
    p += 32;
  }
  dbfBytes[p++] = 0x0D;       // header terminator

  // Records.
  for (const f of features) {
    dbfBytes[p++] = 0x20;     // deletion flag = ' ' (not deleted)
    for (const fld of fields) {
      const raw = f.properties[fld.name];
      let str: string;
      if (fld.type === 'N') {
        const n = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(n)) {
          str = '';
        } else {
          str = (fld as NumericField).decimals > 0
            ? n.toFixed((fld as NumericField).decimals)
            : Math.round(n).toString();
        }
        // Numeric fields are right-padded with leading spaces to fill the width.
        if (str.length > fld.width) str = '*'.repeat(fld.width);     // overflow marker
        str = str.padStart(fld.width, ' ');
      } else {
        str = raw == null ? '' : String(raw);
        if (str.length > fld.width) str = str.slice(0, fld.width);
        str = str.padEnd(fld.width, ' ');
      }
      for (let j = 0; j < str.length; j++) dbfBytes[p + j] = str.charCodeAt(j);
      p += fld.width;
    }
  }
  dbfBytes[p] = 0x1A;     // EOF marker

  // ---- 4. PRJ ----
  const prj =
    'GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],' +
    'PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]]';

  return { shp: shpFile, shx: shxFile, dbf: dbfFile, prj };
}

function writeShpHeader(
  view: DataView,
  byteLength: number,
  xMin: number, yMin: number, xMax: number, yMax: number,
  shapeType: number,
) {
  // Magic 9994 (BE), 5 unused BE int32 zeros, file length in 16-bit words (BE),
  // version 1000 (LE), shape type (LE), bounding box (8 doubles LE).
  view.setInt32(0, 9994, false);
  view.setInt32(24, byteLength / 2, false);
  view.setInt32(28, 1000, true);
  view.setInt32(32, shapeType, true);
  view.setFloat64(36, xMin, true);
  view.setFloat64(44, yMin, true);
  view.setFloat64(52, xMax, true);
  view.setFloat64(60, yMax, true);
  // Z + M ranges: zero (we don't write Z/M).
}

// ---------- Tiny zip (STORE only) ----------

interface ZipEntry { name: string; bytes: Uint8Array; }

/// Build a minimal STORE-only ZIP. Avoids a JSZip dep just for shapefiles.
/// Each entry: local file header → file data → central directory → EOCD.
export function buildZip(entries: ZipEntry[]): Blob {
  const localHeaders: Uint8Array[] = [];
  const centralEntries: Uint8Array[] = [];
  let cursor = 0;
  const fileOffsets: number[] = [];
  for (const e of entries) {
    fileOffsets.push(cursor);
    const nameBytes = new TextEncoder().encode(e.name);
    const crc = crc32(e.bytes);
    // Local file header (30 bytes + name).
    const lh = new ArrayBuffer(30 + nameBytes.length);
    const lhView = new DataView(lh);
    const lhBytes = new Uint8Array(lh);
    lhView.setUint32(0, 0x04034b50, true);         // local header signature
    lhView.setUint16(4, 20, true);                 // version needed
    lhView.setUint16(6, 0, true);                  // flags
    lhView.setUint16(8, 0, true);                  // method = STORE
    lhView.setUint16(10, 0, true);                 // mtime
    lhView.setUint16(12, 0, true);                 // mdate
    lhView.setUint32(14, crc, true);
    lhView.setUint32(18, e.bytes.length, true);    // compressed size = original size
    lhView.setUint32(22, e.bytes.length, true);    // uncompressed size
    lhView.setUint16(26, nameBytes.length, true);
    lhView.setUint16(28, 0, true);                 // extra field length
    lhBytes.set(nameBytes, 30);
    localHeaders.push(new Uint8Array(lh));
    cursor += lh.byteLength + e.bytes.length;
    // Central directory entry (46 bytes + name).
    const ce = new ArrayBuffer(46 + nameBytes.length);
    const ceView = new DataView(ce);
    const ceBytes = new Uint8Array(ce);
    ceView.setUint32(0, 0x02014b50, true);
    ceView.setUint16(4, 20, true);                 // version made by
    ceView.setUint16(6, 20, true);                 // version needed
    ceView.setUint16(8, 0, true);                  // flags
    ceView.setUint16(10, 0, true);                 // method
    ceView.setUint16(12, 0, true);                 // mtime
    ceView.setUint16(14, 0, true);                 // mdate
    ceView.setUint32(16, crc, true);
    ceView.setUint32(20, e.bytes.length, true);
    ceView.setUint32(24, e.bytes.length, true);
    ceView.setUint16(28, nameBytes.length, true);
    ceView.setUint16(30, 0, true);                 // extra field length
    ceView.setUint16(32, 0, true);                 // file comment length
    ceView.setUint16(34, 0, true);                 // disk number start
    ceView.setUint16(36, 0, true);                 // internal attrs
    ceView.setUint32(38, 0, true);                 // external attrs
    ceView.setUint32(42, fileOffsets[localHeaders.length - 1], true);
    ceBytes.set(nameBytes, 46);
    centralEntries.push(new Uint8Array(ce));
  }
  // Central directory size + offset.
  const cdSize = centralEntries.reduce((s, b) => s + b.length, 0);
  const cdOffset = cursor;
  // EOCD (22 bytes).
  const eocd = new ArrayBuffer(22);
  const eocdView = new DataView(eocd);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, entries.length, true);
  eocdView.setUint16(10, entries.length, true);
  eocdView.setUint32(12, cdSize, true);
  eocdView.setUint32(16, cdOffset, true);
  eocdView.setUint16(20, 0, true);

  // Cast to BlobPart[] — TypeScript 5.7+ tightened ArrayBufferLike to
  // distinguish ArrayBuffer from SharedArrayBuffer, which BlobPart's
  // ArrayBufferView constraint doesn't accept. Our buffers are all real
  // ArrayBuffers, so the runtime is fine.
  const parts: BlobPart[] = [];
  for (let i = 0; i < entries.length; i++) {
    parts.push(localHeaders[i] as unknown as BlobPart);
    parts.push(entries[i].bytes as unknown as BlobPart);
  }
  for (const ce of centralEntries) parts.push(ce as unknown as BlobPart);
  parts.push(new Uint8Array(eocd) as unknown as BlobPart);
  return new Blob(parts, { type: 'application/zip' });
}

// CRC-32 (polynomial 0xEDB88320) — table-driven.
let CRC_TABLE: Uint32Array | null = null;
function crc32(bytes: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

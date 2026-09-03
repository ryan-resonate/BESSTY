// Hand-built GeoTIFF fixtures. TEST-ONLY — nothing in the app imports this.
//
// Built by hand because geotiff.js's own `writeArrayBuffer` writes one BYTE per
// sample whatever it is handed (`encodeImage` sizes the strip at
// width·height·samplesPerPixel), so it cannot produce the float32 rasters the
// DEM path actually parses. Shared by the upload, snapshot and QLD tests so
// there is one statement of what a valid file looks like.

/// A minimal single-strip float32 GeoTIFF: tie point at the raster's NW corner,
/// `pixelDeg` square cells, EPSG:4326 geokeys.
///
/// `rasterType` is `GTRasterTypeGeoKey`: 1 = PixelIsArea (the GeoTIFF default —
/// the tie point names the pixel's outer corner), 2 = PixelIsPoint (it names the
/// pixel's centre).
export function floatGeoTiff(
  values: Float32Array,
  width: number,
  height: number,
  west: number,
  north: number,
  pixelDeg: number,
  rasterType: 1 | 2 = 1,
): ArrayBuffer {
  const align = (v: number, n: number) => Math.ceil(v / n) * n;
  const SIZE: Record<number, number> = { 3: 2, 4: 4, 12: 8 };  // SHORT, LONG, DOUBLE
  const STRIP_OFFSETS = 273;
  const entries: Array<[tag: number, type: number, values: number[]]> = [
    [256, 4, [width]],                        // ImageWidth
    [257, 4, [height]],                       // ImageLength
    [258, 3, [32]],                           // BitsPerSample
    [259, 3, [1]],                            // Compression: none
    [262, 3, [1]],                            // PhotometricInterpretation
    [STRIP_OFFSETS, 4, [0]],                  // patched below
    [277, 3, [1]],                            // SamplesPerPixel
    [278, 4, [height]],                       // RowsPerStrip: one strip
    [279, 4, [width * height * 4]],           // StripByteCounts
    [339, 3, [3]],                            // SampleFormat: IEEE float
    [33550, 12, [pixelDeg, pixelDeg, 0]],     // ModelPixelScale
    [33922, 12, [0, 0, 0, west, north, 0]],   // ModelTiepoint
    // GeoKeyDirectory: v1.1.0, 3 keys — geographic model, raster type, WGS 84.
    [34735, 3, [1, 1, 0, 3, 1024, 0, 1, 2, 1025, 0, 1, rasterType, 2048, 0, 1, 4326]],
  ];

  // Values longer than 4 bytes live after the IFD and are referenced by offset.
  let cursor = align(8 + 2 + entries.length * 12 + 4, 8);
  const offsets = new Map<number, number>();
  for (const [tag, type, vals] of entries) {
    if (SIZE[type] * vals.length <= 4) continue;
    cursor = align(cursor, SIZE[type]);
    offsets.set(tag, cursor);
    cursor += SIZE[type] * vals.length;
  }
  const dataOffset = align(cursor, 4);

  const dv = new DataView(new ArrayBuffer(dataOffset + width * height * 4));
  dv.setUint8(0, 0x49); dv.setUint8(1, 0x49);          // "II" — little endian
  dv.setUint16(2, 42, true);
  dv.setUint32(4, 8, true);                            // first IFD
  dv.setUint16(8, entries.length, true);
  entries.forEach(([tag, type, vals], i) => {
    const o = 10 + i * 12;
    const list = tag === STRIP_OFFSETS ? [dataOffset] : vals;
    dv.setUint16(o, tag, true);
    dv.setUint16(o + 2, type, true);
    dv.setUint32(o + 4, list.length, true);
    const inline = SIZE[type] * list.length <= 4;
    const at = inline ? o + 8 : offsets.get(tag)!;
    if (!inline) dv.setUint32(o + 8, at, true);
    list.forEach((v, k) => {
      const p = at + k * SIZE[type];
      if (type === 3) dv.setUint16(p, v, true);
      else if (type === 4) dv.setUint32(p, v, true);
      else dv.setFloat64(p, v, true);
    });
  });
  dv.setUint32(10 + entries.length * 12, 0, true);     // no second IFD
  for (let i = 0; i < values.length; i++) dv.setFloat32(dataOffset + i * 4, values[i], true);
  return dv.buffer;
}

export const RAMP_W = 5;
export const RAMP_H = 4;
export const RAMP_WEST = 153.0;
export const RAMP_NORTH = -27.40;
export const RAMP_PIXEL_DEG = 0.001;

/// A west→east ramp of 1 m per column, with the NW cell holding the QLD
/// service's no-data sentinel.
export function rampTiff(): ArrayBuffer {
  const values = new Float32Array(RAMP_W * RAMP_H);
  for (let j = 0; j < RAMP_H; j++) for (let i = 0; i < RAMP_W; i++) values[j * RAMP_W + i] = i;
  values[0] = -9999;
  return floatGeoTiff(values, RAMP_W, RAMP_H, RAMP_WEST, RAMP_NORTH, RAMP_PIXEL_DEG);
}

// Local ambient module declarations for @mapbox/shp-write — the package
// ships CommonJS without TypeScript types. We only use `.zip()`.

declare module '@mapbox/shp-write' {
  interface ZipOptions {
    /// Output type: 'blob' | 'arraybuffer' | 'base64' (default base64).
    outputType?: 'blob' | 'arraybuffer' | 'base64' | 'nodebuffer';
    /// JSZip-style compression option ('STORE' | 'DEFLATE').
    compression?: 'STORE' | 'DEFLATE';
    /// Per-geometry-type filename roots, e.g. { polyline: 'contours' }.
    types?: { point?: string; polyline?: string; polygon?: string };
  }
  function zip(
    geojson: GeoJSON.GeoJSON,
    options?: ZipOptions,
  ): Promise<Blob | ArrayBuffer | string>;
  const _default: { zip: typeof zip };
  export default _default;
  export { zip };
}

// Pure geographic helpers — no wasm, no firebase, no DOM.
//
// Split out of `gridCore.ts` so worker-safe, wasm-free modules (the scene
// builder, the terrain sampler, unit tests) can use them without dragging the
// solver bindings into their bundle.
//
// Equirectangular approximation about a project origin: exact enough over a
// project's few-kilometre extent and cheap enough to call per grid cell.

const EARTH_R_M = 6371008.8;

/// Local east/north metres of `latLng` relative to `origin`.
export function latLngToLocalMetres(
  latLng: [number, number],
  origin: [number, number],
): [number, number] {
  const lat0 = (origin[0] * Math.PI) / 180;
  const dLat = ((latLng[0] - origin[0]) * Math.PI) / 180;
  const dLng = ((latLng[1] - origin[1]) * Math.PI) / 180;
  return [EARTH_R_M * dLng * Math.cos(lat0), EARTH_R_M * dLat];
}

/// Inverse of [`latLngToLocalMetres`] — local east/north metres back to lat/lng.
export function localMetresToLatLng(
  en: [number, number],
  origin: [number, number],
): [number, number] {
  const lat0 = (origin[0] * Math.PI) / 180;
  const lat = origin[0] + (en[1] / EARTH_R_M) * (180 / Math.PI);
  const lng = origin[1] + (en[0] / (EARTH_R_M * Math.cos(lat0))) * (180 / Math.PI);
  return [lat, lng];
}

/// Great-circle distance (equirectangular approximation) in metres.
export function approxDistanceM(a: [number, number], b: [number, number]): number {
  const [e, n] = latLngToLocalMetres(b, a);
  return Math.hypot(e, n);
}

/// Corners of a (possibly rotated) calculation-area rectangle, in lat/lng,
/// ordered anticlockwise from the south-west of the UNROTATED box.
///
/// Lives here rather than beside its first caller because three unrelated
/// places need it — the PDF figure, the grid's cell generation, and the DEM
/// fetch bounds — and the third of those was quietly using width/height alone.
/// That describes the unrotated box, so a rotated area had corners outside the
/// downloaded tiles, where a DEM miss returns 0 m instead of erroring.
export function calcAreaCorners(
  ca: { centerLatLng: [number, number]; widthM: number; heightM: number; rotationDeg?: number },
): Array<[number, number]> {
  const [lat0, lng0] = ca.centerLatLng;
  const cosLat = Math.cos((lat0 * Math.PI) / 180);
  const th = ((ca.rotationDeg ?? 0) * Math.PI) / 180;
  const hw = ca.widthM / 2;
  const hh = ca.heightM / 2;
  return ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as Array<[number, number]>).map(([sx, sy]) => {
    const x = sx * hw;
    const y = sy * hh;
    const wx = x * Math.cos(th) - y * Math.sin(th);
    const wy = x * Math.sin(th) + y * Math.cos(th);
    return [
      lat0 + (-wy / EARTH_R_M) * (180 / Math.PI),
      lng0 + (wx / (EARTH_R_M * cosLat)) * (180 / Math.PI),
    ] as [number, number];
  });
}

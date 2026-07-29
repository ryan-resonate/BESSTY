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

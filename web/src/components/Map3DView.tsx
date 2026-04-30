// 3D map view powered by MapLibre GL JS. Shows the same project (sources +
// receivers + contour grid) draped over real terrain, drivable with the
// usual right-button-tilt / scroll-zoom controls.
//
// Design choices:
//   - Terrain: AWS Open-Data terrain-RGB tiles (already used by `lib/dem.ts`
//     for the elevation lookup, so no new third-party signup).
//   - Imagery basemap: Esri World Imagery for satellite (free, no token);
//     MapLibre's demotile for OSM. Both are vector-free raster sources, so
//     the bundle stays slim — no vector style dependencies.
//   - Sources and receivers render as fill-extrusion polygons that climb
//     from the local DEM ground up to (HAG × exaggeration). Without this,
//     a 150 m hub would draw on the ground next to a 1.5 m receiver and
//     look identical. The polygon is a tiny circle so it reads as a
//     vertical "stalk" at typical zoom levels.
//   - The contour grid is overlaid as a raster image source generated from
//     the same `GridResult.dbA` values via a tiny canvas paint pass, then
//     pinned to the grid's bounding box. Using the same colormap as 2D so
//     they match. Updates on every grid change.

import { useEffect, useRef, useState } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Project } from '../lib/types';
import type { GridResult } from '../lib/solver';
import type { DemRaster } from '../lib/dem';
import { makeBandsForRange, paletteCss, tForDb, type Palette } from '../lib/colormap';
import { buildContourPolygons } from '../lib/contourLines';

interface Props {
  project: Project;
  grid: GridResult | null;
  palette: Palette;
  dbDomain: { min: number; max: number };
  /// Underlying basemap kept consistent with the 2D Leaflet view.
  baseMap: 'satellite' | 'osm';
  /// DEM the project loaded for ground-elevation lookup at every
  /// source / receiver. When `null`, all extrusions sit at sea level —
  /// the relative heights still read correctly but they don't follow the
  /// terrain mesh.
  dem?: DemRaster | null;
  /// dB-band step (matches the 2D Layers tab → Contours → Step). Used
  /// to discretise the contour overlay into bands so the polygon overlay
  /// renders sensibly. Defaults to 5 dB if unset.
  contourStepDb?: number;
  onClose(): void;
}

/// Closed N-vertex polygon ring centred on (lat, lng), in [lng, lat]
/// order. Used both for slim "WTG line" stalks (small radius, few
/// vertices) and chunkier receiver / cluster stalks (larger radius,
/// more vertices).
function circleRing(lat: number, lng: number, radiusM: number, sides: number): Array<[number, number]> {
  const R = 6371008.8;
  const lat0 = (lat * Math.PI) / 180;
  const dLat = (radiusM / R) * (180 / Math.PI);
  const dLng = (radiusM / (R * Math.cos(lat0))) * (180 / Math.PI);
  const ring: Array<[number, number]> = [];
  for (let i = 0; i < sides; i++) {
    const th = (i / sides) * Math.PI * 2;
    ring.push([lng + dLng * Math.cos(th), lat + dLat * Math.sin(th)]);
  }
  ring.push(ring[0]);
  return ring;
}

/// Closed rectangle ring centred on (lat, lng), with width / height in
/// metres. `yawDeg` rotates the rectangle clockwise from north (0°
/// = long axis points north). Used for BESS / auxiliary cuboid footprints.
function rectRing(
  lat: number, lng: number,
  widthM: number, heightM: number,
  yawDeg: number = 0,
): Array<[number, number]> {
  const R = 6371008.8;
  const lat0Rad = (lat * Math.PI) / 180;
  const cosLat = Math.cos(lat0Rad);
  const halfW = widthM / 2;
  const halfH = heightM / 2;
  // Local-coords rectangle corners (east, north) before rotation.
  const local: Array<[number, number]> = [
    [-halfW, -halfH], [ halfW, -halfH], [ halfW,  halfH], [-halfW,  halfH],
  ];
  const yaw = (yawDeg * Math.PI) / 180;
  const cs = Math.cos(yaw);
  const sn = Math.sin(yaw);
  const ring: Array<[number, number]> = local.map(([x, y]) => {
    const xR =  x * cs + y * sn;
    const yR = -x * sn + y * cs;
    const dLat = (yR / R) * (180 / Math.PI);
    const dLng = (xR / (R * cosLat)) * (180 / Math.PI);
    return [lng + dLng, lat + dLat];
  });
  ring.push(ring[0]);
  return ring;
}

/// Render the GridResult.dbA into a CMA RGBA bitmap using the same palette
/// as the 2D Leaflet overlay. Returned ImageData lives in canvas pixel
/// (Previously: a canvas / image source rendered the contour grid as a
/// flat raster pinned to the grid's bounding box. Replaced by a polygon
/// fill layer in `installGrid` because MapLibre v4's image / canvas
/// sources have a known limitation where high-zoom terrain mesh tiles
/// miss UV samples from the source bitmap, leaving holes that vanish
/// only when zoomed back out. Polygons drape natively to the terrain
/// mesh and don't suffer from that.)

/// Build a MapLibre style with terrain + a basemap. Avoids any vector-style
/// dependency (those need a separate fonts/sprites server).
function makeStyle(baseMap: 'satellite' | 'osm'): maplibregl.StyleSpecification {
  const sources: maplibregl.StyleSpecification['sources'] = {
    'terrain-rgb': {
      type: 'raster-dem',
      // Same Mapbox/AWS terrain tiles the 2D DEM uses (terrarium encoding).
      tiles: ['https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png'],
      tileSize: 256,
      encoding: 'terrarium',
      maxzoom: 14,
    },
    'basemap': baseMap === 'satellite'
      ? {
          type: 'raster',
          tiles: ['https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}'],
          tileSize: 256,
          attribution: 'Tiles © Esri',
          // `maxzoom` here is the deepest level the source actually
          // serves. MapLibre upscales that tile when the camera zooms
          // past it, so the basemap stays visible (pixelated) instead
          // of vanishing when the user wants close-up inspection.
          maxzoom: 19,
        }
      : {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
          maxzoom: 19,
        },
  };
  return {
    version: 8,
    sources,
    layers: [
      { id: 'basemap-tiles', type: 'raster', source: 'basemap' },
    ],
    // Terrain exaggeration is controlled live via map.setTerrain — set a
    // sane default here that the slider then overrides as the user drags.
    terrain: { source: 'terrain-rgb', exaggeration: 1.0 },
    sky: {
      'sky-color': '#87ceeb',
      'sky-horizon-blend': 0.5,
      'horizon-color': '#ffffff',
      'horizon-fog-blend': 0.5,
      'fog-color': '#dcdcdc',
      'fog-ground-blend': 0.0,
    } as unknown as maplibregl.StyleSpecification['sky'],
    // Steeper default pitch makes hub-height stalks easier to see at a
    // glance — the user can drag back down with right-click if they want
    // a near-top-down view.
    pitch: 70,
    bearing: -20,
  };
}

export function Map3DView({ project, grid, palette, dbDomain, baseMap, dem, contourStepDb, onClose }: Props) {
  const stepDb = contourStepDb ?? 5;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  // Vertical exaggeration applied uniformly to BOTH the terrain mesh AND
  // the source / receiver stalks. 1× is true scale (default); cranking
  // up to ~3× makes a 100 m hub easier to distinguish from a 1.5 m
  // receiver next to it on flat terrain.
  const [verticalExaggeration, setVerticalExaggeration] = useState(1.0);

  // Init MapLibre once. Re-mount the dialog to swap basemap (cheap — no
  // dynamic style swap so we avoid a thousand subtle bugs around layer
  // re-registration).
  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const ca = project.calculationArea;
    const centre = ca?.centerLatLng
      ?? project.receivers[0]?.latLng
      ?? project.sources[0]?.latLng
      ?? [-33.595, 138.74];

    const map = new maplibregl.Map({
      container: containerRef.current,
      style: makeStyle(baseMap),
      center: [centre[1], centre[0]],
      zoom: 12.5,
      pitch: 70,
      bearing: -20,
      hash: false,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      installObjectsLayer(map, project, dem, verticalExaggeration);

      // Calc-area outline for orientation.
      if (ca) {
        const halfW = ca.widthM / 2;
        const halfH = ca.heightM / 2;
        const R = 6371008.8;
        const lat0 = (ca.centerLatLng[0] * Math.PI) / 180;
        const dLat = (halfH / R) * (180 / Math.PI);
        const dLng = (halfW / (R * Math.cos(lat0))) * (180 / Math.PI);
        const south = ca.centerLatLng[0] - dLat;
        const north = ca.centerLatLng[0] + dLat;
        const west = ca.centerLatLng[1] - dLng;
        const east = ca.centerLatLng[1] + dLng;
        map.addSource('calc-area', {
          type: 'geojson',
          data: {
            type: 'Feature', properties: {},
            geometry: {
              type: 'LineString',
              coordinates: [
                [west, south], [east, south], [east, north], [west, north], [west, south],
              ],
            },
          },
        });
        map.addLayer({
          id: 'calc-area-outline',
          type: 'line',
          source: 'calc-area',
          paint: {
            'line-color': '#F2CB00',
            'line-width': 2,
            'line-dasharray': [4, 3],
          },
        });
      }

      // Initial grid overlay — re-painted by the second effect below
      // whenever `grid` updates.
      if (grid) installGrid(map, grid, palette, dbDomain, stepDb);
    });

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [project, baseMap]);

  // Re-render the grid overlay (cheap canvas paint) when results change.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !grid || !map.isStyleLoaded()) return;
    installGrid(map, grid, palette, dbDomain, stepDb);
  }, [grid, palette, dbDomain, stepDb]);

  // Re-apply vertical exaggeration to BOTH the terrain mesh and the
  // object stalks. Terrain is a one-liner; objects need their GeoJSON
  // re-emitted because fill-extrusion-height reads off properties.
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !map.isStyleLoaded()) return;
    map.setTerrain({ source: 'terrain-rgb', exaggeration: verticalExaggeration });
    installObjectsLayer(map, project, dem, verticalExaggeration);
  }, [verticalExaggeration, project, dem]);

  return (
    <div className="modal-backdrop" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="modal" style={{ width: '92vw', height: '88vh', maxWidth: 'unset', padding: 0, overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ borderBottom: '1px solid var(--rule)' }}>
          <h2>3D view — terrain + sources</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <label
              style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: 'var(--ink-soft)' }}
              title="Multiply terrain exaggeration AND source / receiver heights uniformly. 1× = true scale."
            >
              <span>Vertical exaggeration</span>
              <input type="range" min={1} max={5} step={0.25}
                value={verticalExaggeration}
                onChange={(e) => setVerticalExaggeration(+e.target.value)}
                style={{ width: 120 }}
              />
              <span style={{ width: 32, fontVariantNumeric: 'tabular-nums' }}>{verticalExaggeration.toFixed(2)}×</span>
            </label>
            <button className="x-btn" onClick={onClose}>✕</button>
          </div>
        </div>
        <div ref={containerRef} style={{ flex: 1, height: 'calc(100% - 48px)', position: 'relative' }} />
      </div>
    </div>
  );
}

/// Rectangular footprint connecting two endpoints (a, b) at a given
/// width, oriented perpendicular to the segment. Used for noise-wall
/// extrusions: a thin strip running between the two endpoints, extruded
/// upward to the wall's top height. Returns a closed ring in [lng, lat]
/// order.
function strip(
  a: [number, number], b: [number, number], widthM: number,
): Array<[number, number]> {
  const R = 6371008.8;
  const lat0 = ((a[0] + b[0]) / 2 * Math.PI) / 180;
  const cosLat = Math.cos(lat0);
  // Direction vector in metres (east, north).
  const dx = (b[1] - a[1]) * (Math.PI / 180) * R * cosLat;
  const dy = (b[0] - a[0]) * (Math.PI / 180) * R;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) return [a, b, a];   // degenerate, defensive
  // Perpendicular unit vector × half-width.
  const px = -dy / len * widthM / 2;
  const py =  dx / len * widthM / 2;
  // Convert metre offsets back to lat/lng deltas.
  const dLat = (m: number) => (m / R) * (180 / Math.PI);
  const dLng = (m: number) => (m / (R * cosLat)) * (180 / Math.PI);
  // Four corners: (a − perp), (b − perp), (b + perp), (a + perp).
  const ring: Array<[number, number]> = [
    [a[1] - dLng(px), a[0] - dLat(py)],
    [b[1] - dLng(px), b[0] - dLat(py)],
    [b[1] + dLng(px), b[0] + dLat(py)],
    [a[1] + dLng(px), a[0] + dLat(py)],
  ];
  ring.push(ring[0]);
  return ring;
}

/// Build / refresh the source + receiver + barrier fill-extrusion
/// features. The fill-extrusion layer is configured with terrain
/// alignment (`fill-extrusion-base-alignment: 'terrain'`,
/// `fill-extrusion-height-alignment: 'terrain'`) so the per-feature
/// `base` and `top` properties are HEIGHTS ABOVE THE TERRAIN MESH at
/// each vertex, NOT absolute elevations. This guarantees the bottoms
/// sit flush on the ground regardless of any mismatch between MapLibre's
/// terrain-rgb tile elevations and our project DEM lookup.
///
/// Geometry per kind:
///   - WTG       — slim cylinder (~3 m radius) running ground → hub × ex
///   - WTG hub   — small disc at the top of the cylinder (yellow marker)
///   - BESS      — small cuboid (~12 m × 4 m × 3 m) sitting on the ground
///   - Auxiliary — small cuboid (~5 m × 3 m × 2 m) sitting on the ground
///   - Receiver  — small sphere (16-vertex polygon, ~5 m diameter)
///                 floating at HAG × ex above ground
///   - Barrier   — strip rectangle running between endpoints, extruded
///                 from ground to top height × ex
function installObjectsLayer(
  map: maplibregl.Map,
  project: Project,
  _dem: DemRaster | null | undefined,
  exaggeration: number,
) {
  const features: GeoJSON.Feature[] = [];

  for (const s of project.sources) {
    if (!Number.isFinite(s.latLng[0]) || !Number.isFinite(s.latLng[1])) continue;
    const yaw = s.yawDeg ?? 0;

    if (s.kind === 'wtg') {
      const hubHeight = s.hubHeight ?? 100;
      const top = hubHeight * exaggeration;
      // Slim cylinder ground → hub.
      features.push({
        type: 'Feature',
        properties: {
          kind: 'source', sub: 'wtg', name: s.name,
          base: 0,
          top,
        },
        geometry: {
          type: 'Polygon',
          coordinates: [circleRing(s.latLng[0], s.latLng[1], 3, 12)],
        },
      });
      // Yellow disc at the top so the hub reads at a glance.
      features.push({
        type: 'Feature',
        properties: {
          kind: 'source', sub: 'wtg-hub', name: s.name,
          base: top,
          top: top + Math.max(2, 4 * exaggeration),
        },
        geometry: {
          type: 'Polygon',
          coordinates: [circleRing(s.latLng[0], s.latLng[1], 8, 16)],
        },
      });
    } else if (s.kind === 'bess') {
      const base = Math.max(0, s.elevationOffset ?? 0) * exaggeration;
      features.push({
        type: 'Feature',
        properties: {
          kind: 'source', sub: 'bess', name: s.name,
          base, top: base + 3 * exaggeration,
        },
        geometry: { type: 'Polygon', coordinates: [rectRing(s.latLng[0], s.latLng[1], 12, 4, yaw)] },
      });
    } else {
      const base = Math.max(0, s.elevationOffset ?? 0) * exaggeration;
      features.push({
        type: 'Feature',
        properties: {
          kind: 'source', sub: 'auxiliary', name: s.name,
          base, top: base + 2.5 * exaggeration,
        },
        geometry: { type: 'Polygon', coordinates: [rectRing(s.latLng[0], s.latLng[1], 5, 3, yaw)] },
      });
    }
  }
  for (const rx of project.receivers) {
    if (!Number.isFinite(rx.latLng[0]) || !Number.isFinite(rx.latLng[1])) continue;
    // Sphere approximation: 16-sided polygon, ~10 m diameter, centred
    // at HAG × ex above the terrain. With terrain alignment we don't
    // need to query the ground elevation ourselves — MapLibre handles
    // it tile-by-tile during render.
    const SPHERE_R = 5;
    const hag = rx.heightAboveGroundM;
    const desiredCentre = hag * exaggeration;
    const base = Math.max(0.1, desiredCentre - SPHERE_R);
    features.push({
      type: 'Feature',
      properties: {
        kind: 'receiver', sub: 'receiver', name: rx.name,
        base, top: base + 2 * SPHERE_R,
      },
      geometry: {
        type: 'Polygon',
        coordinates: [circleRing(rx.latLng[0], rx.latLng[1], SPHERE_R, 16)],
      },
    });
  }
  for (const b of project.barriers) {
    if (b.polylineLatLng.length < 2) continue;
    const top = (b.topHeightsM[0] ?? 0) * exaggeration;
    const base = Math.max(0, b.baseFromGroundM ?? 0) * exaggeration;
    // v1 only handles 2-point segments — same as the 2D draw flow.
    // Future polyline barriers would emit one strip per segment.
    const a = b.polylineLatLng[0];
    const c = b.polylineLatLng[1];
    if (![a[0], a[1], c[0], c[1]].every(Number.isFinite)) continue;
    features.push({
      type: 'Feature',
      properties: {
        kind: 'barrier', sub: 'barrier', name: b.name,
        base, top,
      },
      geometry: { type: 'Polygon', coordinates: [strip(a, c, 1.0)] },
    });
  }

  const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };
  const existing = map.getSource('objects-3d');
  if (existing) {
    (existing as maplibregl.GeoJSONSource).setData(fc);
    return;
  }
  map.addSource('objects-3d', { type: 'geojson', data: fc });
  map.addLayer({
    id: 'objects-3d-extrude',
    type: 'fill-extrusion',
    source: 'objects-3d',
    paint: {
      'fill-extrusion-color': [
        'match', ['get', 'sub'],
        'wtg', '#1f2937',
        'wtg-hub', '#F2CB00',
        'bess', '#5e35b1',
        'auxiliary', '#1565c0',
        'barrier', '#374151',
        // receivers fall through to the default
        '#f5b400',
      ],
      'fill-extrusion-base': ['get', 'base'],
      'fill-extrusion-height': ['get', 'top'],
      'fill-extrusion-opacity': 0.95,
      // MapLibre v4 already interprets fill-extrusion base/height as
      // heights ABOVE the terrain mesh when `setTerrain` is enabled —
      // so we just emit base = 0 / top = hag and the extrusion sits
      // flush on the ground at every vertex. (The dedicated
      // `*-alignment: 'terrain'` properties only land in v5.)
    },
  });
}

/// Render the contour grid as draped GeoJSON polygons (one MultiPolygon
/// feature per dB band, stacked low-to-high). Polygons project onto the
/// terrain mesh natively — no UV-sampling hole artefacts at high zoom
/// like the previous `image` and `canvas` sources had.
///
/// Bands are derived from the same `min / max / step` controls the user
/// sets in the 2D Layers tab (passed in via `dbDomain` and an explicit
/// `step`). Each band carries its own colour as a feature property so a
/// single fill layer can colour them all via a `match` expression on
/// `threshold`.
function installGrid(
  map: maplibregl.Map,
  grid: GridResult,
  palette: Palette,
  dbDomain: { min: number; max: number },
  stepDb: number,
) {
  const bands = makeBandsForRange(dbDomain.min, dbDomain.max, stepDb);
  const thresholds = bands.map((b) => b.lo);
  const polys = buildContourPolygons(grid, thresholds);

  const features: GeoJSON.Feature[] = polys.map((p) => ({
    type: 'Feature',
    properties: {
      threshold: p.threshold,
      // Pre-compute the per-band fill colour so the layer paint
      // expression doesn't have to recompute a palette lookup per
      // feature on every draw.
      fill: paletteCss(palette, tForDb(p.threshold, dbDomain.min, dbDomain.max)),
    },
    geometry: { type: 'MultiPolygon', coordinates: p.polygon },
  }));
  const fc: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features };

  const existing = map.getSource('grid-overlay') as maplibregl.GeoJSONSource | undefined;
  if (existing) {
    existing.setData(fc);
    return;
  }
  map.addSource('grid-overlay', { type: 'geojson', data: fc });
  // Stack the polygon overlay below the 3D extrusions so the stalks /
  // walls / receivers read on top of the contour colours. Falls back
  // to top-of-stack if the extrusion layer hasn't been registered yet
  // (initial load races).
  const beforeId = map.getLayer('objects-3d-extrude') ? 'objects-3d-extrude' : undefined;
  map.addLayer({
    id: 'grid-overlay-layer',
    type: 'fill',
    source: 'grid-overlay',
    paint: {
      'fill-color': ['get', 'fill'],
      'fill-opacity': 0.7,
      'fill-antialias': false,    // soft edges between bands look cleaner
    },
  }, beforeId);
}

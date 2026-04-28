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
//   - Sources / receivers / cluster centroids render as 3D billboards via
//     a GeoJSON source + circle layer with `circle-pitch-alignment: 'map'`.
//     We don't try to extrude WTGs as proper meshes here — the 3D view is
//     for terrain context, not photoreal assets.
//   - The contour grid is overlaid as a raster image source generated from
//     the same `GridResult.dbA` values via a tiny canvas paint pass, then
//     pinned to the grid's bounding box. Using the same colormap as 2D so
//     they match. Updates on every grid change.

import { useEffect, useRef } from 'react';
import maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Project } from '../lib/types';
import type { GridResult } from '../lib/solver';
import { paletteRgb, tForDb, type Palette } from '../lib/colormap';

interface Props {
  project: Project;
  grid: GridResult | null;
  palette: Palette;
  dbDomain: { min: number; max: number };
  /// Underlying basemap kept consistent with the 2D Leaflet view.
  baseMap: 'satellite' | 'osm';
  onClose(): void;
}

/// Render the GridResult.dbA into a CMA RGBA bitmap using the same palette
/// as the 2D Leaflet overlay. Returned ImageData lives in canvas pixel
/// space — MapLibre stretches it to the grid's bounding box.
function paintGrid(grid: GridResult, palette: Palette, domain: { min: number; max: number }): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = grid.cols;
  c.height = grid.rows;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(grid.cols, grid.rows);
  for (let row = 0; row < grid.rows; row++) {
    for (let col = 0; col < grid.cols; col++) {
      // Flip vertically — MapLibre image sources expect north at row 0,
      // GridResult stores south at row 0.
      const src = (grid.rows - 1 - row) * grid.cols + col;
      const dst = (row * grid.cols + col) * 4;
      const db = grid.dbA[src];
      if (!Number.isFinite(db) || db < domain.min - 5) {
        img.data[dst] = 0; img.data[dst + 1] = 0; img.data[dst + 2] = 0; img.data[dst + 3] = 0;
        continue;
      }
      const t = tForDb(db, domain.min, domain.max);
      const [r, g, b] = paletteRgb(palette, t);
      img.data[dst] = r;
      img.data[dst + 1] = g;
      img.data[dst + 2] = b;
      img.data[dst + 3] = 180;     // ~70% alpha so terrain shading shows through
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

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
        }
      : {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          attribution: '© OpenStreetMap contributors',
        },
  };
  return {
    version: 8,
    sources,
    layers: [
      { id: 'basemap-tiles', type: 'raster', source: 'basemap' },
    ],
    terrain: { source: 'terrain-rgb', exaggeration: 1.4 },
    sky: {
      'sky-color': '#87ceeb',
      'sky-horizon-blend': 0.5,
      'horizon-color': '#ffffff',
      'horizon-fog-blend': 0.5,
      'fog-color': '#dcdcdc',
      'fog-ground-blend': 0.0,
    } as unknown as maplibregl.StyleSpecification['sky'],
    pitch: 60,
    bearing: -20,
  };
}

export function Map3DView({ project, grid, palette, dbDomain, baseMap, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);

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
      pitch: 60,
      bearing: -20,
      hash: false,
      attributionControl: false,
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true }));
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    mapRef.current = map;

    map.on('load', () => {
      // GeoJSON layer for sources + receivers + cluster centroids — coloured
      // by kind, sized in metres so they don't shrink as you zoom out.
      const fc: GeoJSON.FeatureCollection = {
        type: 'FeatureCollection',
        features: [
          ...project.sources
            .filter((s) => Number.isFinite(s.latLng[0]) && Number.isFinite(s.latLng[1]))
            .map((s): GeoJSON.Feature => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [s.latLng[1], s.latLng[0]] },
              properties: { kind: 'source', sub: s.kind, name: s.name },
            })),
          ...project.receivers
            .filter((r) => Number.isFinite(r.latLng[0]) && Number.isFinite(r.latLng[1]))
            .map((r): GeoJSON.Feature => ({
              type: 'Feature',
              geometry: { type: 'Point', coordinates: [r.latLng[1], r.latLng[0]] },
              properties: { kind: 'receiver', name: r.name },
            })),
        ],
      };
      map.addSource('points', { type: 'geojson', data: fc });
      map.addLayer({
        id: 'points-circle',
        type: 'circle',
        source: 'points',
        paint: {
          'circle-radius': [
            'match', ['get', 'kind'],
            'source', 9,
            'receiver', 7,
            6,
          ],
          'circle-color': [
            'match', ['get', 'sub'],
            'wtg', '#1f2937',
            'bess', '#5e35b1',
            'auxiliary', '#1565c0',
            // receivers fall through to the fallback
            '#f5b400',
          ],
          'circle-stroke-color': '#ffffff',
          'circle-stroke-width': 1.5,
          'circle-pitch-alignment': 'map',
        },
      });

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
      if (grid) installGrid(map, grid, palette, dbDomain);
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
    installGrid(map, grid, palette, dbDomain);
  }, [grid, palette, dbDomain]);

  return (
    <div className="modal-backdrop" style={{ background: 'rgba(0,0,0,0.5)' }}>
      <div className="modal" style={{ width: '92vw', height: '88vh', maxWidth: 'unset', padding: 0, overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}>
        <div className="modal-header" style={{ borderBottom: '1px solid var(--rule)' }}>
          <h2>3D view — terrain + sources</h2>
          <button className="x-btn" onClick={onClose}>✕</button>
        </div>
        <div ref={containerRef} style={{ flex: 1, height: 'calc(100% - 48px)', position: 'relative' }} />
      </div>
    </div>
  );
}

function installGrid(map: maplibregl.Map, grid: GridResult, palette: Palette, dbDomain: { min: number; max: number }) {
  const canvas = paintGrid(grid, palette, dbDomain);
  const dataUrl = canvas.toDataURL();
  const coords: [[number, number], [number, number], [number, number], [number, number]] = [
    [grid.bounds.sw[1], grid.bounds.ne[0]],   // top-left  (NW)
    [grid.bounds.ne[1], grid.bounds.ne[0]],   // top-right (NE)
    [grid.bounds.ne[1], grid.bounds.sw[0]],   // bot-right (SE)
    [grid.bounds.sw[1], grid.bounds.sw[0]],   // bot-left  (SW)
  ];
  const existing = map.getSource('grid-overlay');
  if (existing) {
    (existing as maplibregl.ImageSource).updateImage({ url: dataUrl, coordinates: coords });
    return;
  }
  map.addSource('grid-overlay', { type: 'image', url: dataUrl, coordinates: coords });
  map.addLayer({
    id: 'grid-overlay-layer',
    type: 'raster',
    source: 'grid-overlay',
    paint: { 'raster-opacity': 0.85, 'raster-fade-duration': 0 },
  }, 'points-circle');
}

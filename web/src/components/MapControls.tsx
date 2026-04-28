// Floating map controls — replaces Leaflet's default zoom widget with a
// richer panel: zoom, pan (4-way), home (fit calc area), layer toggle (drops
// a small popover), 3D placeholder.

import { useState } from 'react';
import type { Project } from '../lib/types';
import type { BaseMap } from './MapView';

interface Props {
  project: Project;
  baseMap: BaseMap;
  setBaseMap(b: BaseMap): void;
  onZoomIn(): void;
  onZoomOut(): void;
  onPan(dxPx: number, dyPx: number): void;
  /// Reset to a view that frames the calc area.
  onHome(): void;
  /// Switch to 3D — disabled placeholder for now.
  onToggle3D?(): void;
}

export function MapControls(props: Props) {
  const [layerOpen, setLayerOpen] = useState(false);
  return (
    <div className="map-controls">
      <div className="map-controls-group zoom">
        <button title="Zoom in" onClick={props.onZoomIn}>＋</button>
        <button title="Zoom out" onClick={props.onZoomOut}>−</button>
      </div>

      <div className="map-controls-group pan">
        <div /><button title="Pan north" onClick={() => props.onPan(0, -120)}>▲</button><div />
        <button title="Pan west" onClick={() => props.onPan(-120, 0)}>◀</button>
        <button title="Home (fit calc area)" onClick={props.onHome}>⌂</button>
        <button title="Pan east" onClick={() => props.onPan(120, 0)}>▶</button>
        <div /><button title="Pan south" onClick={() => props.onPan(0, 120)}>▼</button><div />
      </div>

      <div className="map-controls-group layers">
        <button title="Layers" onClick={() => setLayerOpen((v) => !v)}>≡</button>
        {layerOpen && (
          <div className="map-layer-popover map-chrome">
            <div className="chrome-title">Base map</div>
            <button
              className={`btn small block${props.baseMap === 'satellite' ? ' active' : ''}`}
              onClick={() => { props.setBaseMap('satellite'); setLayerOpen(false); }}
            >Satellite</button>
            <button
              className={`btn small block${props.baseMap === 'osm' ? ' active' : ''}`}
              onClick={() => { props.setBaseMap('osm'); setLayerOpen(false); }}
            >OpenStreetMap</button>
            <button className="btn small block" disabled title="3D view — coming next iteration">3D (TBD)</button>
          </div>
        )}
      </div>
    </div>
  );
}

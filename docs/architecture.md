# Architecture

## 1. Overview

BEESTY is a web-based outdoor noise predictor. The acoustic solver runs entirely in the browser. Firebase persists project state and serves DEM tiles. The interactive responsiveness target — sub-frame latency on source/barrier/receiver drag — drives every architectural choice below.

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Browser                                                                  │
│                                                                          │
│  ┌────────────────────────┐    ┌────────────────────────────────────┐   │
│  │  Main thread           │    │  Orchestrator Worker               │   │
│  │  - React UI            │◄───┤  - State of record (sources, etc.) │   │
│  │  - Leaflet map         │    │  - Cached SPL + gradient tensors   │   │
│  │  - Canvas/WebGL        │    │  - Drag-time Taylor extrapolation  │   │
│  │    contour render      │────►  - Error-driven recompute queue    │   │
│  │  - Reads SAB grid      │    │  - Discontinuity tripwires         │   │
│  └────────────────────────┘    └──────┬─────────────────────────────┘   │
│            ▲                          │                                  │
│            │                          ▼ work tickets                     │
│  ┌─────────┴──────┐    ┌───────────────────────────────────────┐        │
│  │ SharedArray-   │    │ Compute Workers × (cores − 2)          │        │
│  │ Buffer         │◄───┤ - Rust/WASM solver                     │        │
│  │ (results grid) │    │ - Forward-mode AD per ticket           │        │
│  └────────────────┘    └───────────────────────────────────────┘        │
│                                                                          │
└────────────┬─────────────────────────────────────────────────────────────┘
             │
             ▼
   ┌─────────────────────┐    ┌─────────────────────┐
   │ Firebase Firestore  │    │ Firebase Storage    │
   │ - Project documents │    │ - DEM tiles         │
   │ - Equipment catalog │    │ - User-uploaded     │
   │   (shared)          │    │   spectra / DEMs    │
   └─────────────────────┘    └─────────────────────┘
```

## 2. Why client-side compute

A full recompute over a 5×5 km site with 5 km receiver halo (15×15 km, 50 m base grid → 90 000 receivers, 30 sources, 8 octave bands) is ~22 M band-evaluations. Each evaluation is < 1 µs in Rust+SIMD. Server round-trips and Firebase Functions cold starts would dominate. Computing in-browser:

- Eliminates network latency on every drag.
- Removes per-user compute cost.
- Lets us share state (the SAB results grid) zero-copy with the renderer.
- Restricts the back end to small, structured documents — Firestore's sweet spot.

The trade-off: COOP/COEP headers on Firebase Hosting (required for SharedArrayBuffer), cold-start of WASM module (~50 ms), and a dependency on WebAssembly SIMD (Chrome / Edge / Firefox latest; Safari 16.4+).

## 3. Threading model

### 3.1 Main thread

Owns the React app, Leaflet basemap, and contour rendering (Canvas2D for v1; WebGL upgrade path open). The renderer reads from the shared results grid every animation frame. It never blocks on compute.

### 3.2 Orchestrator Worker

Single instance. Owns the canonical project state (sources, barriers, receivers, calc-area, settings). On any input change:

1. **Immediate**: applies first-order Taylor update to every receiver in the cached grid using the gradient tensor. Writes the extrapolated values into the SAB. Renderer picks them up next frame.
2. **Queue refresh**: enqueues exact-recompute work tickets, ordered by per-receiver predicted error.
3. **Tripwire check**: if the input change crosses a discontinuity threshold (ground region split, barrier zmin, Dz cap saturation, line-of-sight, DEM cell edge, concave-ground D.5 trigger) for any source-receiver pair, that pair jumps to the head of the queue.

The orchestrator never does heavy math itself. Its hot path is gradient × delta arithmetic (vectorized) and tripwire checks.

### 3.3 Compute Workers

`navigator.hardwareConcurrency − 2` instances (reserve one core for main, one for orchestrator). Each loads the same Rust/WASM module. They pull tickets from the orchestrator's queue (work-stealing, MPMC via `Atomics.wait` on a SAB control block).

A ticket is one of:
- **Exact recompute (s, r, bands)**: full ISO 9613-2 evaluation for source `s`, receiver `r`, all bands. Returns level + gradient w.r.t. all currently-tracked AD inputs.
- **Snapshot source (s)**: compute source `s`'s contribution to every receiver in the active grid, store separately so subsequent moves of `s` can subtract/add cleanly. Issued at the start of a drag.
- **Reflection sweep (s)**: enumerate image sources for `s` against active reflectors, queue (s_image, r) tickets for each.

Workers write results into the SAB at fixed offsets. No locks — each ticket owns a disjoint output slice.

### 3.4 Memory layout (SharedArrayBuffer)

```
[control block: 256 B]
  - queue head/tail atomics
  - generation counter (incremented on input change)
  - per-worker status flags

[receiver grid: N_rx × 8 bands × 4 bytes (f32)]
  Total dB per band, summed over all sources. Renderer reads this.

[per-source contributions: N_active_drag_sources × N_rx × 8 bands × 4 bytes]
  Lazily allocated when a drag starts. Lets us update one source without
  recomputing every other source's contribution.

[gradient tensor: N_rx × N_active_AD_inputs × 8 bands × 4 bytes]
  Sparse — only populated for receivers within active influence radius
  of inputs being dragged.
```

For 90 000 receivers × 8 bands × 4 B = 2.9 MB grid. Plus 2.9 MB per actively-dragged source. Plus gradient tensor (sparse): ~10 MB worst case for one drag of a source with ~3 inputs (x,y,z), full grid.

Total steady-state under interactive drag: ~25 MB. Fits comfortably.

## 4. Coordinate systems

- **Ingest / persistence**: WGS84 lat/lng. All Firestore documents store coordinates this way.
- **Solver internal**: project-local UTM (single zone chosen at project create from site centroid). All distances, heights, gradients in metres. Solver never sees lat/lng.
- **Render**: Leaflet handles WGS84 → screen pixels for the map base. Contour grids are computed in UTM, projected to Leaflet `LatLng` for overlay.

Conversion happens at two boundaries: ingest (WGS84 → UTM) and render (UTM → WGS84 → Leaflet pixel). Solver kernels take pure UTM.

## 5. Adaptive grid

Two levels:

- **Base grid**: rectangular, axis-aligned to the calculation area's local axes (which can be rotated). Default 50 m spacing, configurable per project (10 / 25 / 50 / 100 m).
- **Refinement zones**: 4× refined (12.5 m at default base) within:
  - 200 m of any source.
  - 100 m of any barrier edge in plan view.
  - The currently-visible map viewport, if zoomed below a threshold.

Refinement is computed by the orchestrator on calc-area or source/barrier change. Compute tickets are issued for refined cells with higher priority.

## 6. Firebase

### 6.1 Hosting

Serves the React bundle and the Rust/WASM module. Critical: **COOP and COEP headers must be set** for SharedArrayBuffer:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

This is configured in `firebase.json`. WASM file served with `Content-Type: application/wasm`.

### 6.2 Firestore

One document per project under `projects/{projectId}`. Subcollection `projects/{projectId}/results` for cached result rasters (large; one document per saved scenario).

Equipment catalog under `catalog/wtg/{modelId}`, `catalog/bess/{modelId}`, etc. — read-only for v1, populated from a seed script.

See `docs/firestore-schema.md` for full document layout.

### 6.3 Cloud Storage

Two buckets:

- `dem-tiles/`: pre-tiled DEM in GeoTIFF (Cloud-Optimized GeoTIFF format), keyed by tile coordinates. Service-fetched defaults plus user uploads.
- `user-uploads/{projectId}/`: user-supplied DEMs, custom spectra, and other large blobs.

## 7. Project list flow

1. App mounts → Firestore query `projects/` (no auth, single bucket).
2. Project list screen shows all projects. Click → load.
3. On load: hydrate project document, kick off orchestrator with state, kick off DEM tile fetches for the calc-area extent, render UI immediately. Solver runs first-pass on all receivers in background, populates contours as they complete.
4. Cached `results/{latest}` document, if present, paints the contour immediately while fresh compute runs — gives sub-second perceived load.

## 8. Settings surface

Global per-project settings live under a header `Settings` button (modal or full page). Includes:

- Reflection: order cap (default 3), max search radius (20 km), max reflection-receiver distance (200 m), max source-reflector distance (50 m), tolerance (0.3 dB).
- Atmosphere: temperature (10 °C), humidity (70 %) — fixed at ISO reference but exposed for documentation.
- Ground: default G (0.5 for WT calcs per Annex D; 0.0–1.0 elsewhere).
- Annex D: terrain-screening Abar cap (default 3 dB, adjustable), elevated-source toggle (default on, uses tip height = hub + rotor radius).
- Grid: base spacing, refinement factor, refinement triggers.
- Receiver heights: WT calculation default 4 m, general 1.5 m.

All settings persist on the project document.

## 9. UI guidance vs hard requirements

The `Front end mock up/` folder is layout reference only. Specific names ("Mt Brown WF"), coordinates (Goyder, SA), and reference data (placeholder LwA-only spectra) are illustrative. The header logo (`assets/ResonateLogo.svg`) is incorporated as the canonical brand.

The mockup layouts to take forward:
- Header: Resonate logo + app title + project breadcrumb + nav (Map / Calculation / Reports / Settings) + save/help/account.
- Side panel "two-level tabs" layout (Sources / Calc area / Receivers / Barriers / Import / Results / Layers).
- Map controls top-right (zoom, pan, 2D/3D, layers), legend bottom-left, draw tools centre-bottom.
- Project-wide wind-speed selector lives in the header or a "Scenario" strip beneath it.

## 10. What v1 does *not* need to do

- No user authentication. Single shared Firestore bucket. We add Firebase Auth later.
- No Cmet / LAT(LT). Short-term downwind only.
- No Annex A (foliage, industrial, housing) or Annex B (chimney Dc).
- No buildings as discrete objects. Reflectors are derived from barrier vertical faces internally.
- No third-octave native solving. Third-octave on import is summed to octaves before solving.
- No mobile/tablet support. Desktop browser, 1280 px wide minimum.

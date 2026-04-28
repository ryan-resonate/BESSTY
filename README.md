# BEESTY — Wind Farm + BESS Noise Modeller

Interactive web tool for predicting outdoor sound pressure levels from wind turbines and BESS sites per **ISO 9613-2:2024** (including Annex D). Designed for sub-frame-latency feedback while dragging sources, barriers, and receivers.

## Goals

- **Responsive**: Any source/receiver/barrier drag updates the contour map within one frame using cached gradients (Taylor extrapolation), with exact recompute streaming in behind it.
- **Accurate**: Direct implementation of ISO 9613-2:2024 Clauses 6–8 plus Annex D, validated against hand-calculated reference cases.
- **Client-side**: Acoustic solver runs entirely in the browser (Rust → WebAssembly + Web Workers). Firebase only persists project state and DEM tiles.

## Repository layout

```
.
├── ISO_9613-2_2024(en).pdf       Source standard (reference only)
├── iso_9613-2.txt                Extracted text (reference only)
├── docs/
│   ├── architecture.md           System design, threading, data flow
│   ├── solver-design.md          Formula-by-formula mapping to code
│   ├── auto-diff-strategy.md     Forward-mode AD, error estimation, discontinuities
│   └── firestore-schema.md       Project document layout, Storage buckets
├── validation/
│   ├── README.md                 Case index + tolerance policy
│   ├── case-01-divergence-only.md
│   ├── case-02-flat-ground-general-method.md
│   ├── case-03-single-barrier.md
│   ├── case-04-multi-edge-barrier.md
│   ├── case-05-annex-d-wtg-flat.md
│   └── case-06-annex-d-wtg-concave.md
├── solver/                       Rust crate (compiles to native + WASM)
│   ├── Cargo.toml
│   ├── src/                      lib, dual numbers, spectrum, ISO 9613-2 modules
│   └── tests/case_01_divergence.rs
├── web/                          React + Vite front end
│   ├── package.json, vite.config.ts, tsconfig.json
│   ├── public/ResonateLogo.svg
│   └── src/                      App, screens, components, lib
├── firebase/                     (TBD) Firestore rules, Storage rules
└── Front end mock up/            Hand-sketched wireframe (reference only)
```

## Status

**v0.6 — full interactive workspace.**

- `solver/` — Rust crate implementing Adiv + Aatm + Agr (General method) + Abar (over-top single + multi edge) + Annex D wind-turbine rules. All 6 validation cases pass (49 tests). Compiled to WASM via `wasm-pack`.
- `web/` — React + Vite app:
  - Header with Resonate logo
  - Project list with localStorage persistence (create, delete)
  - Workspace with **satellite imagery** base, **auto-loaded DEM** (AWS Terrain Tiles), **draggable** sources / receivers (drag-end → solve + persist), **contour grid rendering** (Run grid → coloured raster overlay; Viridis default + 5 alternative palettes), **glass-chrome** layer panel + legend + status bar + results dock, and a **settings modal** for ground / Annex D / grid params.
  - Visual system: Inter UI font, JetBrains Mono with tabular numerals on measurements, slate neutrals + yellow accent.

To try it:
```bash
cd web
npm install
npm run build:wasm    # one-off (requires wasm-pack)
npm run dev
# open http://localhost:5173
```

The project list shows a pre-seeded "Mt Brown" demo project on first launch. Click into it, then:
- Drag any WTG, BESS, or receiver — point dB(A) updates in <100 ms on drag-end.
- Click "+ WTG / BESS / Inv / Tx / Recv" then click on the map to add new objects.
- Adjust project wind speed; auto-recompute fires.
- Click "Run grid" (in the bottom-right Results dock) for a contour raster.
- Toggle between satellite and OSM in the layer panel; switch palettes; adjust opacity.
- Cog icon in side panel → Settings modal for solver/grid configuration.

Next deliverables: lateral diffraction (Eq 25); reflections (engine-only); Web Worker for the grid pass; barrier drawing tool on the map; Firestore persistence (mechanical swap from localStorage); two-level tabs IA refactor.

## Reading order

1. `docs/architecture.md` — start here for the big picture.
2. `docs/solver-design.md` — how the standard maps to code.
3. `docs/auto-diff-strategy.md` — the responsiveness mechanism.
4. `docs/firestore-schema.md` — what gets persisted.
5. `validation/README.md` — verification plan.

## Scope (v1)

**In scope:** Adiv, Aatm, Agr (General method 7.3.1), Abar (vertical + lateral diffraction), reflections (image-source method, order ≤ N), Annex D (WT-specific rules: G≤0.5, 4 m receiver minimum, terrain-screening Abar cap, concave-ground correction). DEM ingestion (GeoTIFF + ASCII grid) and service-fetched defaults. Adaptive grid contours and named point receivers. Project list, project edit. No auth (single anonymous bucket).

**Out of scope (v1):** Annex A (foliage, industrial, housing), Annex B (chimney directivity), Annex C (advanced C0), Cmet / long-term LAT(LT), simplified ground method 7.3.2, building geometry as discrete objects (reflectors come from barrier vertical faces only), multi-user editing/auth.

**Bands:** Solver runs natively in either octave (8 bands, 63 Hz–8 kHz) or one-third octave (typ. 24 bands, 50 Hz–10 kHz). Default ingestion is octave; users importing third-octave data run the solver in third-octave mode end-to-end. No down-folding before the solve.

## Tech stack

- **Solver:** Rust + `wasm-bindgen` + `wasm32-simd128`. Forward-mode dual numbers (hand-rolled).
- **Front end:** React + Vite. Leaflet for map base. Canvas/WebGL for contours.
- **Threading:** Main (UI/render) + Orchestrator Worker + N Compute Workers, all sharing a `SharedArrayBuffer` results grid.
- **Backend:** Firebase Hosting (must serve COOP/COEP for SharedArrayBuffer), Firestore (project documents), Cloud Storage (DEM tiles, large user-uploaded spectra).

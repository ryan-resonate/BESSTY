# Roadmap

Pick-up notes after v0.7 (snapshot + Taylor extrapolation working end-to-end).

## Where we are

- Solver: Adiv, Aatm, Agr (General), Abar (over-top single + multi-edge), Annex D (D.2/D.3/D.4/D.5). Forward-mode AD plumbed through every kernel. 49 native tests pass; all 6 validation cases match hand calcs.
- WASM bindings: exact + gradient variants for both general and WTG sources.
- Web app: project list with localStorage persistence; workspace with satellite/OSM base, auto-loaded DEM, draggable sources/receivers, contour grid overlay (Viridis default + 5 alt palettes, auto/fixed domain), legend with band counts, results dock, status bar, settings modal, measure-tape tool, two-level tabs side panel (Sources / Area / Receivers / Import / Results / Layers).
- Drag pipeline: source moves trigger Taylor extrapolation for both point receivers and contour grid (sub-frame). Structural changes trigger debounced exact re-snapshot.

---

## Tomorrow — first thing

1. **Get real WTG + BESS data from Ryan.** We need:
   - 2–3 representative WTG models with octave-band sound power per wind speed (and per noise mode if applicable). Prefer values straight off IEC 61400-11 datasheets so we can verify against published levels.
   - 2–3 BESS / inverter / transformer entries with octave-band Lw per operating mode.
   - One or two known reference scenarios (turbine layout + receiver point + measured/published Lp(A)) to use as end-to-end validation cases — confirms the whole pipeline (DEM, ground, atmosphere, energy sum, A-weighting) lines up with what practitioners expect.

2. **Build the global source manager.** Out of scope for the project workspace — this is a *catalog* screen at the application level.
   - New header nav item: "Catalog" alongside Projects.
   - List view: WTG models, BESS models, Auxiliary (inverter/transformer) models. Each entry: name, manufacturer, hub heights / footprint, mode list, per-mode/per-wind-speed octave spectrum.
   - Add / edit / duplicate / delete actions.
   - Backed by localStorage initially (key `beesty.catalog`); same schema we'll later move to Firestore `catalog/{kind}/{modelId}` documents.
   - Project source picker reads from this catalog instead of the in-code stub.
   - Import: paste/upload CSV of `windSpeed,band63,band125,...,band8000`.

---

## Extrapolation quality — items raised today

### 1. Cap gradient-driven changes to avoid false jumps

When a Taylor extrapolation predicts an unrealistic jump, the error bar on the prediction has clearly exceeded the linear regime. Today we accept whatever Taylor produces; tomorrow we should:

- Track per-pair `|Lp_extrapolated − Lp_snapshot|`. If the change exceeds a threshold (proposal: 6 dB across any band, or 3 dB on the A-weighted total), force an exact re-snapshot for that pair before showing the value.
- Threshold should be project-configurable in the Settings modal (default 3 dB(A)).
- Optionally, *clamp* the displayed value to `snapshot ± threshold` while a re-snapshot is in flight, rather than showing a possibly-wrong number that flickers when the exact result lands.

Implementation sketch:
```
extrapolateLp(snapshot, srcAbsAtSnapshot, srcAbsNow):
  ...compute lp_new...
  for each band:
    delta = lp_new[band] - snapshot[band]
    if |delta| > limit:
      mark pair as needs-resnapshot
      lp_new[band] = snapshot[band] + sign(delta) * limit  // clamp
  return lp_new + needsResnapshot flag
```

The orchestrator then queues the flagged pairs for exact re-eval (highest first), refreshing the snapshot in the background.

### 2. Error-ranked refresh queue (was deferred)

Per `docs/auto-diff-strategy.md` §4.2 — during a long drag, refresh ~5% of grid cells per 200 ms ordered by predicted error magnitude (`|grad · Δ|` is a cheap proxy). Catches DEM-cell crossings and other discontinuities that the linear gradient misses. The cap above feeds the same queue.

### 3. Second-order Taylor experiment

Forward-mode `Dual<3, 2>` (value + gradient + Hessian along each direction) would give us:
```
Lp_new ≈ Lp + ∇Lp · Δ + ½ Δᵀ H Δ
```

Costs roughly 2× the snapshot evaluation and 6× the per-frame extrapolation arithmetic (Hessian has 6 unique entries for 3 inputs). Worth a focused experiment:
- Add a `Dual2<3>` type alongside `Dual<3>` (or a `Hessian` extension trait).
- New WASM function `evaluate_*_with_hess_src_octave` returning `[8 Lp, 24 grad, 48 hess]` per pair (8 + 24 + 48 = 80 floats per pair).
- A/B test against first-order: at what drag distance does the 2nd-order term reduce error meaningfully?
- Likely diminishing returns past ~50 m source moves (where the gradient cap will kick in anyway).
- If marginal, leave as a `Dual2` module behind a feature flag and don't enable in production. If decisive, swap in for the production extrapolator.

---

## Contour rendering

### 4. Contour lines (in addition to or instead of filled bands)

Today: filled coloured raster only. Tomorrow:
- **Layers tab → Contours**: three-state segmented control — Filled / Lines / Both.
- Lines drawn at the band boundaries (5 dB or 10 dB depending on `makeBandsForRange`), labelled at one or two points per line with their dB value.
- Implementation: use `d3-contour` (small, well-tested) on the grid `dbA` Float32Array → list of GeoJSON MultiLineString features at each threshold → render via Leaflet's `L.geoJSON` with palette-coloured strokes.
- Labels: place every Nth segment (configurable), rotated to follow the line tangent.
- Performance: contour-line generation for 10k cells is ~50 ms. Same order as the canvas raster render.

---

## From earlier discussions — still TBD

Roughly ordered by user-visible value, with rough effort.

### Solver gaps (medium effort)

- **Lateral diffraction (Eq 25)** — combine over-top and around-side paths. Today only over-top. Hand-calc reference exists in `validation/case-04-multi-edge-barrier.md` (lateral sub-test). [~1 day]
- **Reflections (image-source method, Eqs 28–30)** — engine-only per v1 scope; reflectors auto-generated from barrier vertical faces. Per-project settings already in place (order cap, search radii, tolerance). [~1.5 days]
- **Polar directivity + yaw gradient AD** — for general sources only (Annex D.2 forbids it for WT). Single broadband polar table per source (per design decision). Yaw becomes a 4th dual-number input. [~1 day]
- **Receiver-side gradient** — extend snapshot to `Dual<6>` (3 src + 3 rx) so receiver drag also extrapolates instead of forcing re-snapshot. Cheap once we commit; current cache is fine for small receiver counts. [~half day]
- **Barrier-height gradient plumbed through** — Rust kernels handle it generically; just need a snapshot path that treats barrier-edge top z as the variable. Critical for the "drag a barrier height slider and watch contours update" workflow we discussed. [~1 day]
- **Annex D.5 concave correction wired through DEM** — solver accepts the flag, JS always passes `false`. Need to integrate `hm = ∫ height_above_ground / dp` along the source-receiver path against the loaded DEM, then evaluate the `hm ≥ 1.5·(hS+hR)/2` test per pair. [~half day]
- **Adaptive grid refinement** — base 100 m grid uniformly, refine to 25 m within 200 m of any source and 100 m of any barrier edge. Big perf win for large project areas. [~1 day]
- **Third-octave end-to-end through the UI** — solver supports both, web app hardcodes octave. Add band-system selector to the project scenario, plumb through. [~half day]

### Workspace gaps (medium effort)

- **Source manager (global catalog screen)** — see "Tomorrow — first thing" above.
- **Barrier drawing tool** — in Sources/Add panel: "+ Barrier" mode → click polyline points on map → set top heights. Persists into `project.barriers`, solver already handles. [~1 day]
- **Calc-area drag/rotate handles on the map** — corners + a rotation handle on the dashed yellow rectangle. Numeric inputs work today; visual editing makes debugging faster. [~half day]
- **Cursor lat/lng in the status bar** — currently always null. Easy: subscribe to map mousemove. [~30 min]
- **Reports** — pick a few receivers, generate a one-page PDF/HTML showing project setup, scenario, results table, contour map snapshot. [~1.5 days]
- **Tweaks panel from the original mockup** — promote a chosen layout/palette/symbol to project default; keep alternatives one click away. [~half day]

### Architecture / scaling (when needed)

- **Web Worker layer** — move heavy snapshot work into a worker, leave main thread free to render at 60 fps even while a 50 m grid is being computed. Required before SharedArrayBuffer becomes useful. [~1 day]
- **SharedArrayBuffer results grid** — zero-copy share of the result raster between worker and main. Re-enables COOP/COEP headers; need to either proxy tiles or use a tile provider that sends CORP. [~half day plus tile work]
- **Orchestrator** — work queue, tripwire detection (per `docs/solver-design.md` §5), error-driven recompute scheduling. The framework piece that makes the design's "self-healing during drag" real. [~2 days]

### Persistence (small effort, low priority)

- **Firestore swap** — `web/src/lib/storage.ts` is shaped to look like Firestore documents. Replace localStorage reads/writes with Firestore CRUD; rules already drafted. Matters when we need multi-device or sharing. [~half day]
- **DEM upload (GeoTIFF / ASCII grid)** — supplement the auto-loaded AWS Terrain Tiles with user-uploaded high-resolution DEMs (e.g. LiDAR for site work). Parse server-side or in browser via a tiny GeoTIFF reader. [~1 day]
- **Project import / export** — JSON download/upload of an entire project for backup or sharing. Trivial given the schema is already JSON. [~30 min]

### Validation (ongoing)

- **Get real WTG + BESS data from Ryan** — see top of file.
- **Reference comparison cases** — once we have real spectra, build 2–3 end-to-end test scenarios with measured/published Lp values and assert the solver matches within 1–2 dB.
- **Third-octave validation cases** — `validation/third-octave/` placeholder mentioned in `validation/README.md` — actually write the case files.
- **Cross-check against CadnaA / SoundPLAN / WindPRO** — run an identical geometry through both, compare per-receiver and contour band areas. The most credibility-building thing we can do.

---

## Discussion items still open

- **Adaptive grid refinement strategy** — refining-by-source is obvious; refining-by-barrier-shadow is harder (need to detect the shadow boundary from the rubber-band path). Talk through before building.
- **Tile-provider strategy when COOP/COEP comes back on** — proxy through Firebase Hosting? Switch to MapTiler / Mapbox with API keys? Self-host the tiles for an offline mode? Each has tradeoffs.
- **Long-term Cmet / LAT(LT)** — explicitly out of v1 scope. If we ever bring it in, decide whether C0 is project-input or computed from a wind-rose import.
- **Mobile/tablet** — explicitly out of v1 (desktop, 1280 px min). Worth re-checking after the v1 features land in case anything trivial changes that constraint.

---

## Quick reference — file map

```
solver/
  src/lib.rs                       WASM exports (now incl. *_with_grad_src_*)
  src/iso9613/{...}                ISO 9613-2 modules
  src/dual.rs                      forward-mode AD
  tests/case_01..06_*.rs           validation case mirrors

web/src/
  lib/solver.ts                    snapshotProject / extrapolateProject
                                   snapshotGrid / extrapolateGrid
  lib/colormap.ts                  viridis + bands + auto-domain
  lib/dem.ts                       AWS Terrain Tiles loader
  lib/storage.ts                   localStorage projects (Firestore-shaped)
  lib/catalog.ts                   in-code WTG/BESS/inverter/transformer stub
                                   ← replace with global Source Manager
  components/MapView.tsx           Leaflet, draggable, contours, measure
  components/SidePanel.tsx         two-level tabs (Sources/Area/Receivers/...)
  components/MapChrome.tsx         Legend, ResultsDock, StatusBar
  components/SettingsModal.tsx     project-scoped solver settings
  screens/ProjectScreen.tsx        snapshot/extrapolate orchestration
  wasm/                            compiled WASM module (gitignored later)

docs/
  architecture.md                  system overview, threading model
  solver-design.md                 formula → code mapping
  auto-diff-strategy.md            forward-mode AD rationale + drag lifecycle
  firestore-schema.md              project / catalog document layout
  roadmap.md                       this file
validation/                        hand-calc reference cases
```

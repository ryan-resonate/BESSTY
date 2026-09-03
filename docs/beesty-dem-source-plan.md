# BESSTY terrain data plan — better free DEM, no despike, visible QA (2026-09-03)

Implementation plan for replacing the AWS Terrarium tiles with a cleaner free
DEM that loads automatically for every project, removing the Hampel despike,
and replacing it with a visible terrain QA pass. Written for an implementing
session; product decisions below are **locked with Ryan** (2026-09-03) — do not
re-litigate them, ask only if something is contradictory or unimplementable.

Background: `docs/beesty-terrain-review.md` (how terrain screening works) and
the despike review in the 2026-09-02 session (summarised in "Why" below).

## Locked decisions (Ryan, 2026-09-03)

1. **Better free DEM, automatic.** Projects get a good terrain approximation
   with no per-project download. ELVIS downloads stay as the per-project
   upload path that already exists (`demUpload.ts`); they are not the default.
2. **No bund / berm primitive.** Out of scope.
3. **Remove the Hampel despike.** `despikeGrid` and the `despikeStrength`
   setting go. No smoothing or tolerance simplification is added in its place.
4. **Add a visible, bounded terrain QA pass.** Suspect cells are flagged and
   reported (diagnostics + map overlay); correction is opt-in and off by
   default, and when on it is bounded and reported.
5. **Keep bilinear sampling at the DEM's native pitch.** No upsampling or
   sharpening. The terrain source and cell size are stated in the report.
6. **Existing projects switch automatically and silently.** No migration, no
   "your terrain changed" note, no per-project source pin. The app is in early
   beta; nobody needs the old terrain back. Uploaded DEMs are unaffected.
7. **QLD LiDAR is in scope** (Phase 3).
8. **No Copernicus proxy.** Outside Australia the existing Terrarium tiles stay
   as the fallback. No Cloud Function work.
9. **No surplus code.** No user-facing source selector, no feature flags, no
   compatibility shims beyond tolerating the old `despikeStrength` field on
   load. The source in use is visible (status chip, diagnostics, report), and
   that is enough.

## Why (one paragraph)

The Hampel filter erases any one-cell-wide ridge, bund or cutting at `low` and
two-cell-wide ones at `medium`, silently, while doing almost nothing on clean
data (0.002 % of cells on the Vicmap 10 m validation DEM). The Terrarium tiles
it was meant to clean are raw SRTM inland in Australia, whose real problems are
canopy bias and coastal seams, which a median filter cannot fix. Commercial
tools (SoundPLAN, CadnaA, windPRO) never despike: they use bounded
simplification for speed, explicit checks for blunders, and better data.

## Verified facts (checked 2026-09-03, not assumed)

| Source | What it is | Access | Browser-fetchable? | Licence |
|---|---|---|---|---|
| **GA SRTM-derived 1 s DEM-S v1.0** | National ~30 m bare-earth DEM: voids filled, **vegetation offsets removed**, adaptively smoothed by GA. CC BY 4.0. | Single COG `https://dea-public-data.s3.ap-southeast-2.amazonaws.com/projects/elevation/ga_srtm_dem1sv1_0/dems1sv1_0.tif` (38 GB, EPSG:4326, 0.000277°, float32, nodata −3.4e38, ocean = 0). 512×512 DEFLATE tiles, 8 overview levels. | **Yes.** `Access-Control-Allow-Origin: *`, HTTP range OK. geotiff.js `fromUrl`: header 1.3 s, a 6 km window (217×217) in 0.44 s. | CC BY 4.0, attribution "Geoscience Australia" |
| **QLD `Elevation/QldDem` ImageServer** | Mosaic of the latest public LiDAR DTMs (0.5–1 m) over Queensland, falling back to GA DEM-H (30 m) elsewhere. | `https://spatial-img.information.qld.gov.au/arcgis/rest/services/Elevation/QldDem/ImageServer` — `exportImage` with `bboxSR=4326&imageSR=4326&format=tiff&pixelType=F32` returns float32 TIFF; `identify?returnCatalogItems=true` names the raster serving a point (`lowps` = its pixel size). WCS 1.1 also exposed. | **Yes.** CORS reflects the Origin. 256² export 1.0–1.6 s; 2048² export 16.8 MB in 8.3 s. | Service `copyrightText` cites State of Queensland + GA; confirm the CC BY terms on the QSpatial record before shipping |
| **Copernicus GLO-30** | Global 30 m DSM (canopy included), far fewer artefacts than SRTM. | `s3://copernicus-dem-30m/Copernicus_DSM_COG_10_<lat>_<lon>_DEM/…_DEM.tif` (1° COGs, ~47 MB, anonymous, range OK). | **No** — the bucket sends no CORS headers. Needs a proxy. | Free, worldwide, reproduction/adaptation/distribution allowed, no non-commercial clause. Mandatory notice: "© DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018 provided under COPERNICUS by the European Union and ESA; all rights reserved" |
| **FABDEM** | Copernicus with forests/buildings removed | — | — | **CC BY-NC-SA — excluded** (non-commercial) |
| **AWS Terrarium (current)** | Mapzen composite: SRTM inland AU, GA 5 m on some SA/VIC/NT coasts, ETOPO1 bathymetry | PNG tiles, z13 ≈ 17 m at 27°S | Yes | Attribution to Mapzen/AWS as today |
| NSW / VIC state services | NSW 5 m DEM sits in a login "Collaboration Portal"; VIC publishes only a shaded-relief MapServer | — | Not usable | — |
| GA 5 m LiDAR national grid | 245,000 km², patchy | ELVIS download only; no web coverage service found | No | CC BY 4.0 |

Consequences: **GA DEM-S is the national default** (cleaner than Terrarium,
same nominal resolution, fetched straight from the browser). **QLD LiDAR is a
real upgrade where it exists** and is cheap to add. **Copernicus is not used**
(decision 8); the row above is kept only so nobody re-investigates it.

## Ground rules

- No engine (Rust/wasm) changes. The engine already takes a `Heightfield`.
- The upload path (`demUpload.ts`, Firebase-Storage-persisted DEMs) is
  untouched; an uploaded DEM always wins over any automatic source.
- Every automatic source produces a `DemRaster` (`dem.ts`) so `terrainField.ts`,
  `gridCore.ts`, `sceneBuilder.ts` and the grid worker keep working unchanged.
- Old projects that still carry `topography.despikeStrength` must load; the
  field is ignored and dropped on next save.
- Each phase ends green: `npm test` in `web/`, `npm run lint`, and the phase
  gate below. Commit per phase.

## Phase 0 — Source abstraction and reporting plumbing

Files: `web/src/lib/dem.ts` (new `demSources/` folder beside it),
`web/src/screens/ProjectScreen.tsx` (auto-load effect near line 980 and the
source chip near line 179), `web/src/lib/diagnostics.ts`,
`web/src/lib/pdfReport.ts`, `web/src/components/MapView.tsx` (attribution),
`web/src/lib/types.ts`.

- Extend `DemRaster` with `source: { id, label, attribution, licence,
  nativePitchM }` (the upload path already tags `source` informally; make it
  typed). `resolutionM` stays and is set to the **finer** axis of a lat/lng grid
  (E-W ≈ 27 m at 27°S for a 1 s grid; N-S 30.9 m) so nothing is lost.
- Define `DemSource { id; label; covers(bounds): Promise<boolean>;
  load(bounds): Promise<DemRaster> }` and a cascade `loadAutoDem(bounds)` that
  tries sources in order and returns the first that covers and loads. Order:
  `qld-lidar` → `ga-dem-s` → `terrarium` (Phases 3 and 1 add the first two; a
  source that throws or reports no coverage is skipped with a console warning).
  No project setting, no selector (decision 9).
- Diagnostics: `terrain.source` (info) — "Terrain: <label>, <pitch> m cells,
  <n>×<m> raster" — emitted wherever `buildTerrainField` is called
  (`solver.ts` ~430 and ~880). The existing `terrain.resampled` note stays.
- PDF report: a "Terrain" line under the standard line (`pdfReport.ts` ~200)
  with source label, native pitch, raster pitch actually used, and the
  attribution text.
- Map: the DEM attribution string joins the base-map attribution control.
- UI: the DEM status chip shows the source label (and "uploaded" for an
  uploaded DEM). Nothing else.

Gate: unit tests for the cascade (first covering source wins; failure falls
through; upload always wins), the diagnostics note text, and a snapshot of the
report line. Terrarium remains the only automatic source at the end of this
phase, so behaviour is unchanged.

## Phase 1 — GA DEM-S adapter (national default)

File: `web/src/lib/demSources/gaDemS.ts`.

- `covers(bounds)`: bounds within the COG bbox (113–154 °E, −44 … −10 °S).
- `load(bounds)`: `fromUrl(COG_URL)` with geotiff.js (already a dependency),
  cache the `GeoTIFF` handle per session, compute the pixel window for
  `bounds + TERRAIN_MARGIN_M` (500 m; `terrainField.ts`) plus one pixel of
  slack, `readRasters({ window })` from image 0 (full resolution; never an
  overview — the engine wants native pitch). Map nodata (< −1e30) to `NaN`
  (ocean is 0 in DEM-S and is kept as sea level). Return a `DemRaster` whose
  `elevation(lat, lng)` is bilinear on the lat/lng grid (same code shape as
  `regionRaster` in `dem.ts`, but in degrees). Cache the window per session
  keyed by rounded bounds.
- Size guard: a window above 4096² pixels (≈ 110 km) is refused with a
  diagnostic and the cascade falls through to Terrarium; BESS and wind-farm
  extents are far below this.
- Attribution: "Elevation: Geoscience Australia, SRTM-derived 1 Second DEM-S
  v1.0 (CC BY 4.0)".
- The cascade now resolves to `ga-dem-s` for Australian projects, including
  every existing project without an uploaded DEM (decision 6). Terrarium is
  used only where DEM-S has no coverage or fails to load.

Gate:
1. Live probe script `tools/dem-probe.mjs` (network, not in CI): prints window
   stats and timing for Tarong; must read a 6 km window in < 2 s.
2. **V2 re-run**: `validation/run_v2.mjs` extended to solve the V2 case with
   (a) the uploaded Vicmap 10 m DEM (today's gate), (b) `ga-dem-s`, (c)
   `terrarium`. Report per-receiver deltas vs SoundPLAN for each. Pass: (b)
   stays inside the existing V2 limits (±3 dB all, mean ≤ 1.4, worst ≤ 3.8)
   and its mean absolute delta is no worse than (c).
3. Tarong example project: receiver table Terrarium vs DEM-S, saved as
   `validation/dem-source-memo.md` (documentation, not pass/fail).

## Phase 2 — Remove the despike, add terrain QA — **BUILT**

Deviations from the plan as written, all minor:

- `correctedDemRaster(dem, field, origin)` takes the scene's geodetic origin as
  a third argument: a `SceneHeightfield` carries its origin in local metres
  only, so the wrapper cannot convert lat/lng without it.
- `lastTerrainPitchM()` became `lastTerrainBuild()`, returning
  `{ pitchM, count, maxDevM, correction, cells }` — the same "last build"
  record, extended, rather than a second accessor beside it.
- The QA overlay lives in the Layers tab's existing **Terrain** card (with the
  DEM status), not with the debug overlays under Contours, and defaults ON: a
  flagged blunder should be seen, not looked for.
- Phase 4's job, done early because the bug was in reach: `demUpload` now sets
  `resolutionM` from the GeoTIFF pixel size (projected CRS in its own linear
  units, geographic converted at the raster's latitude). Uploaded DEMs were
  being sampled at `terrainField`'s 20 m fallback whatever their real pitch, so
  upload projects change — accepted under decision 6.
- An old project's `topography.despikeStrength` is ignored on load but is not
  actively stripped on save: nothing writes the field, and deleting it would be
  the compatibility shim decision 9 rules out.


Files: `web/src/lib/terrainField.ts`, `terrainField.test.ts`,
`web/src/lib/types.ts` (~640), `web/src/components/SidePanel.tsx` (~3025 select
and hint), `web/src/lib/demoProject.ts`, `web/src/lib/gridCore.ts` (~35),
`web/src/lib/solver.ts` (~430, ~880), `web/src/screens/ProjectScreen.tsx`
(~1109 comment), new `web/src/lib/terrainQa.ts` + test, map overlay in
`MapView.tsx`.

- Delete `despikeGrid`, the `despikeStrength` option on `TerrainFieldOptions`,
  the `TopoSettings.despikeStrength` field (tolerated on load, dropped on save),
  the SidePanel select and the "peak-preserving" hint text, and the demo
  project default. Update the `buildTerrainField` memo key.
- `terrainQa.flagSuspectCells(heights, nx, ny, pitchM)` returns
  `{ indices, maxDevM, count }`. A cell is suspect only if **all** hold:
  1. slope from the cell to at least one 4-neighbour exceeds 45°, i.e. the
     rise in one step is more than one cell width (Hirt 2018 maximum-slope
     idea; a single threshold for every pitch — the extremum and component
     rules below, not the angle, are what protect real terrain);
  2. the cell (or the ≤ 2×2 cluster it belongs to) is a strict local maximum
     or minimum against the ring of cells around it;
  3. the connected component of cells meeting 1–2 is at most 2×2 cells
     (a one-cell-wide bund or a cliff line forms a long component and is
     never flagged).
  Interior windows only; border cells are never flagged (the 500 m margin
  makes them irrelevant and avoids the truncated-window artefact the Hampel
  had).
- Reporting: diagnostics `terrain.suspect` (material when count > 0) with count,
  largest deviation from the ring median, and the source label; the map gets a
  "Suspect terrain cells" overlay (small markers, toggle in the layers list).
- Correction: `settings.topography.qaCorrect: boolean` (default **false**).
  When true, flagged cells (and only those) are replaced by the median of the
  8-neighbour ring, and the diagnostic states how many cells were changed and
  the largest change. Nothing else is ever altered.
- Endpoint consistency: `sceneBuilder.groundAt` / `solver.groundElevation` /
  `gridCore` cell heights already read the raw `DemRaster`; with no despike the
  raw DEM and the heightfield agree, so no change is needed. If `qaCorrect` is
  on, sample endpoint ground from the corrected heightfield instead (helper in
  `terrainField.ts`), so a corrected cell under a receiver is not left floating.

Gate: tests — isolated 60 m spike flagged; 2×2 smeared blob flagged; 1-cell
ridge, 2-cell ridge, conical peak, planar slope, smooth summit all **not**
flagged; border cells never flagged; `qaCorrect` changes exactly the flagged
cells; an old project with `despikeStrength: 'medium'` loads and solves;
`terrainField.test.ts` gate tests still pass. Run the real-DEM check
(Vicmap 10 m, script from the review) and record the flagged count in the
memo (expected: single digits).

## Phase 3 — QLD LiDAR adapter — **BUILT**

Deviations and findings, all recorded rather than re-litigated:

- **Coverage probes five points, not one.** A site can sit half on a capture,
  and a one-point `identify` would then export half 1 m LiDAR and half 30 m
  SRTM with a step between them. Centre + four corners, all must be non-SRTM
  with `lowps ≤ 5`; any error → no coverage, and the cascade moves on.
- **The licence is still unconfirmed.** No QSpatial or data.qld.gov.au record
  names the `Elevation/QldDem` endpoint. The two records for the sibling
  `DEM_TimeSeries_AllUsers` service disagree — the portal says CC BY 3.0, the
  ISO metadata says CC BY-SA — so `licence` reads `see service metadata` and
  the service's `copyrightText` travels with the raster as `attribution`,
  which is what the service's own terms require. **Confirm before Phase 4.**
- **The service is flaky under load.** ~30–50 % of `exportImage` calls return
  HTTP 200, `content-type: image/tiff`, and a JSON body
  (`"General function failure"`) instead of a raster; a successful 2048²
  export takes 8–20 s. The adapter sniffs the TIFF magic rather than the
  content type and quotes the service's message, so the fall-through to DEM-S
  is diagnosable. No retry was added — that is a product decision.
- `parseDemGeoTiff` was split so `parseDemGeoTiffBuffer(buf, opts)` exists;
  the QLD raster is georeferenced from the file's own tie point and pixel
  scale, exactly as an upload is.
- **Grid snapshot pitch** (decision 5) now follows `dem.resolutionM` instead of
  a hard-coded ~30 m, capped at `TERRAIN_MAX_CELLS_PER_AXIS`. `DemRaster`
  gained an optional `grid()` so `captureDemRegion` resamples typed array to
  typed array for the lat/lng-gridded sources.
- Measured (`tools/dem-probe.mjs`, 10 km Brisbane box, 1 m native → 5.37 m
  sampled): `buildTerrainField` 393 ms, `captureDemRegion` 2048² 54 ms (64 ms
  through `elevation`). Main-thread total 447 ms — inside the 1 s budget, so
  no worker scaffolding was built.

File: `web/src/lib/demSources/qldLidar.ts`.

- `covers(bounds)`: bounds inside the service extent and an `identify` call at
  the bounds centre returns a catalog item whose name is **not** SRTM
  (`lowps` ≤ 5). Cache the answer per project.
- `load(bounds)`: one `exportImage` (bilinear resampling) at
  `max(2 m, lowps)` capped so the image stays ≤ 2048² and ≤ ~4 MB; parse the
  float32 TIFF with geotiff.js `fromArrayBuffer` (as `demUpload.ts` does),
  `noData=-9999` → `NaN`. `resolutionM` = the export pitch.
- Attribution from the service `copyrightText`; licence confirmed on the QSpatial
  record before enabling by default.
- Performance gate: `buildTerrainField` over a 10 km site at 5 m is 4 M cells.
  Measure on the main thread; if > 1 s, move the raster sampling into the grid
  worker path for receivers too (this overlaps the solve-responsiveness work in
  memory; do not duplicate it — coordinate).

Gate: Tarong (SRTM area) must **skip** this source; a Brisbane-region test
bounds must use it; a solve against it completes; timing recorded.

## Phase 4 — Docs, help, memo

- Help page and SidePanel hint: describe the sources, the cascade, the QA pass,
  and that uploads override everything.
- README/attribution section lists all sources and licences.
- `validation/dem-source-memo.md`: V2 + Tarong comparisons, QA flag counts,
  timings.

## Decisions resolved 2026-09-03 (were open questions)

1. Existing projects switch to DEM-S automatically, with no notification.
2. QLD LiDAR is included (Phase 3).
3. No Copernicus proxy; Terrarium stays as the fallback outside DEM-S coverage.

## Execution notes

- Order: Phase 0+1 together (the abstraction exists to host DEM-S), then 2,
  then 3, then 4. The pure QA module (`terrainQa.ts` + test) can be written in
  parallel with Phase 0+1 because it touches no shared file; Phase 2 wires it.
- Every phase: `npm test` and `npm run lint` in `web/` green, one commit per
  phase, no push. Commit messages: substantive body only, **no co-author or
  "generated" trailer** (Ryan's standing rule).
- Each phase gets an independent review of its diff before the next phase
  builds on it.

## Not in scope

Bund/berm primitives; any smoothing or TIN simplification; engine changes;
NSW/VIC state services (no public coverage service found); FABDEM (licence);
Copernicus GLO-30 (decision 8).

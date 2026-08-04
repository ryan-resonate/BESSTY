# BEESTY improvements plan (2026-07-30)

Twenty improvements to the BEESTY web app, scoped with Ryan (Q&A 2026-07-30 —
every decision below is locked, including the I10 tab grouping and gear
placement approved 2026-07-31). Written for an implementing
session. Items are ordered for execution: quick wins → the notification system
(a dependency of later items) → structural work → the factorial study.

## Ground rules

- Per-item gate: `npm run lint` (tsc), `npm run build`, `npm test` green.
  Commit per item, style `web(improve N): …`. No AI trailers.
- **No solver-number changes.** Nothing here may alter computed levels except
  where an item explicitly says so (none do — I13 fixes a *display* bug, and
  I17 changes pass/fail COLOURS by design, never the levels themselves).
- Firestore/project schema changes are additive and parse-tolerant; old
  projects must load unchanged (except the I2 migration, which is explicit).
- New dependencies are limited to: `exceljs` (I14 formatted XLSX export),
  `minisearch` (I11 help search), `jspdf` (I15 PDF export), and a tiny in-repo
  window/toast layer built by hand (no UI framework). Anything else needs
  Ryan's sign-off.
- The wasm/solver crates are untouched by this plan.

## Current-state anchors (verified in code)

- Receiver map markers: `MapView.tsx` — `receiverMarker(...)` already receives
  `activeLimit` (from `limitForPeriod(r, project.scenario.period)`, line ~1358)
  and uses it for the pass/fail colour only.
- Native dialogs: 15 `alert/confirm/prompt` sites in `CatalogScreen.tsx`,
  `ImportObjectsModal.tsx`, `ProjectMetaPanel.tsx`, `SidePanel.tsx`,
  `ProjectListScreen.tsx`, `EpsgPicker.tsx`.
- Legacy storage: `lib/storage.ts` (localStorage project store + index),
  `lib/firebase.ts` falls back to it, `lib/firestoreSeed.ts` (examples already
  moved to Firestore), `Project.localCatalog?: CatalogEntry[]`,
  `lib/seedCatalog.ts` (~79 KB bundled seed).
- Bulk edit: `SidePanel.tsx` `onBulkUpdateSources(ByIds)`; BESS wizard has a
  "Bulk model swap" (`BessGroupWizard.tsx` ~line 265) — model only, no mode.
  Groups support per-unit overrides keyed by `slotKey` (`bessGroups.ts`
  materialiser re-applies `unitOverrides` after regeneration).
- Selection: `ProjectScreen.tsx` `selectedIds: Set<string>` (line ~188); an
  Esc-to-clear keydown handler already exists (~line 198) with the
  skip-when-in-text-field pattern to copy.
- Grid status: `MapChrome.tsx` line ~95 ("Computing grid…" button label);
  `grid.worker.ts` message protocol `{id, job, region}` → `{id, ok, result}`;
  tiles are 16×16 cells (`solver.ts` `buildGridJob`).
- 3D: `Map3DView.tsx` is MapLibre GL, `pitch: 70` at two call sites (~158,
  ~192). MapLibre hard-caps pitch at 85°.
- Debug grid: SidePanel layers tab "Debug: show grid cell centres"
  (`SidePanel.tsx` ~1354); `MapView.tsx` ~2068 has a comment about an
  **upscaled display grid** whose cell centres don't coincide with the compute
  grid — prime suspect for I13.
- Settings sections in `SidePanel.tsx` (14): Band system, Standard, Ground,
  Source containers, DΩ, Cmet, Atmosphere, Barrier diffraction, Annex D WTG,
  General sources, Contour grid spacing, Propagation cutoffs, Topography
  (DEM), Drag extrapolation caps.
- Reflections: the ENGINE has them (`iso9613/reflection.rs` — §7.5 first-order
  image-source, `LW + 10·lg(1−α)`, Fresnel gate Eq 26/27; 2024 §7.5.3
  higher-order to a cap of 4; §7.5.4 cylinders) and they are conformance-
  validated (**T19 "reflecting barrier over terrain" passes ±0.05 dB**, plus
  internal cases 12/16/17). BEESTY uses none of it: `sceneBuilder.ts` line ~91
  types the field `reflectors: []` — an empty TUPLE TYPE, so it cannot hold
  anything — and line ~358 hardcodes `max_reflection_order: 1`.
  `Barrier.absorptionCoeff` exists (`types.ts` ~296, defaulted `0.2` in
  `ProjectScreen.tsx` ~884) but has no UI and is dropped by `wallFromBarrier`.
  `surfaceDensityKgM2` is likewise unused — correctly, since ISO 9613-2 has no
  transmission term.

---

## I8 — Contour default: lines only  *(quick win)*

Change the display-mode **fallback** so any project without an explicitly saved
choice renders contour LINES only (no fill). Applies to old projects that never
chose, and to all new projects; explicitly saved choices are untouched.
Find the current default where the layers tab / contour renderer resolves the
display mode; change the `?? 'both'`-style fallback to `?? 'lines'`.
Gate: a project with no saved choice shows lines-only; one with a saved 'both'
still fills.

## I1 — Show limits on receiver markers  *(quick win)*

A second, **smaller** line under the level on the map receiver marker showing
the **active period's** limit (`limitForPeriod`, already computed for colour).
Colour behaviour unchanged in form, but the pass/fail test itself goes through
the I17 comparison rule (integer by default). NOT added to the side panel
(Ryan: map only).
Toggle: a "Show limits" checkbox in the **layers tab** alongside the other
display toggles, persisted with the same mechanism they use; default OFF.
Touch: `MapView.tsx` `receiverMarker` (marker HTML/label), layers tab in
`SidePanel.tsx`, the layers-state type.
Gate: toggle on → both numbers render (level prominent, limit smaller);
period switch updates the limit; toggle off → exactly today's marker.

## I17 — Integer limit comparison (default), with exact-mode toggle  *(quick win)*

Compliance is jurisdiction-flavoured: in the default mode, the computed level
is **rounded to the nearest integer before comparing to the limit**, and only
a genuine exceedance fails — 40.4 dB rounds to 40, which does NOT exceed a
40 dB limit, so it shows **green**. 40.6 rounds to 41 → red. A project setting
toggles back to exact comparison for jurisdictions that want it.

- **One shared helper** (`lib/limits.ts`):
  `exceedsLimit(levelDbA, limitDbA, mode: 'integer' | 'exact')` —
  integer mode: `Math.round(level) > limit`; exact mode: `level > limit`.
  Equality is a pass in both modes (only *exceedances* matter). The limit is
  compared as entered (it's a set value, not a measurement); only the level
  rounds. Rounding is standard half-up (`Math.round`), documented in the
  helper.
- **Setting**: `ProjectSettings.limitComparison?: 'integer' | 'exact'`,
  **absent = `'integer'`** (locked: integer is the default). Note this
  deliberately changes today's behaviour for existing projects — a 40.4 vs 40
  receiver flips red → green — which is the requested default. Toggle lives in
  the settings UI (Calculation tab once I10 lands) as
  "Limit comparison: Rounded to integer (default) / Exact".
- **Sweep every comparison site to the helper** — no inline `level > limit`
  anywhere: the receiver marker fail test (`MapView.tsx` ~153), any receiver
  list/row colouring, exporters that emit pass/fail, and the I14 factorial +
  I15 PDF colours (both specs reference this helper).
- **Displayed values are unchanged** — markers/tables keep showing the
  computed level at current precision; only the compliance COLOUR uses the
  rounded comparison.

Gate: unit tests on the helper (40.4/40.5/40.6 vs 40 in both modes; equality
passes; negative-level edge documented); marker colour flips with the setting;
`grep` shows no remaining inline limit comparisons.

## I6 — BESS "change all" can change mode  *(quick win)*

Extend the wizard's Bulk model swap (`BessGroupWizard.tsx`) with a mode
selector: when swapping model + mode, the mode list comes from the target
model; when changing mode only, apply to units whose current model supports
that mode and report "N skipped (mode not available)" via the I3 toast (plain
text until I3 lands). Mode-only changes write the same per-unit override path
the model swap uses.
Gate: unit test on the swap helper (model+mode, mode-only incl. skip count).

## I16 — Paste spectra from Excel into the new-source screen  *(quick win)*

On the new/edit sound source screen (catalog entry editor), the per-band
spectrum cells accept a **pasted Excel range**: click the first band cell,
Ctrl+V, and the values fill across the bands — whether the copied range was
**horizontal or vertical**. (The spreadsheet import stays the right tool for
complex multi-mode sources; this is for quickly keying a simple source.)

- Excel puts ranges on the clipboard as TSV: a horizontal range is one line of
  tab-separated values, a vertical range is one value per line. An `onPaste`
  handler on the spectrum inputs reads `clipboardData`, splits on
  newlines/tabs, and treats EITHER a single row or a single column as the
  value list. A genuine 2-D block is rejected with a toast ("paste a single
  row or column of levels").
- Fill starts **at the focused cell** and runs forward through the remaining
  band cells; cells before the focus are untouched. Extra values beyond the
  last band are ignored, and too-few values fill only what was pasted — both
  cases noted in a toast ("10 of 12 values used"). Existing single-value paste
  into one cell keeps working (a one-token paste is just that).
- Parsing: trim whitespace, tolerate blank tokens (skipped), reject the paste
  with a toast if any non-blank token isn't numeric — no partial writes on a
  bad paste.
- Build it as a small reusable helper (`lib/spectrumPaste.ts` + a hook) and
  attach it to the catalog editor's spectrum grid; any other spectrum grid can
  adopt it later for free.

Gate: unit tests on the clipboard parser (horizontal TSV, vertical lines,
2-D rejection, truncation/short-fill counts, non-numeric rejection); manual
paste from real Excel in both orientations starting at cell 1 and mid-row.

## I13 — BUG: debug grid at 100 m renders as 200 m  *(quick win)*

Symptom: "Debug: show grid cell centres" at 100 m spacing draws centres 200 m
apart, while contours correctly use the 100 m compute grid.
Hypothesis (verify first): the debug layer renders from the **display-upscaled
grid** (see `MapView.tsx` ~2068 — upscaled cell centres don't coincide with
compute-grid centres) or strides the array by 2. Fix: render the debug layer
from the compute grid's own `cols/rows/dxM/dyM` (the `GridResult`), never the
display-resampled copy.
Gate: manual — 100 m setting shows 100 m centres; count centres across a known
span. Add a unit test if the centre-point generator is extractable.

## I9 — 3D camera to (near-)horizon  *(quick win, option A)*

Raise MapLibre's pitch ceiling: `maxPitch: 85` on the map construction and
remove/raise both hard-coded `pitch: 70` clamps (`Map3DView.tsx` ~158, ~192) so
the user can tilt from top-down to 85° (~5° above horizon). Check terrain/fog
settings still render acceptably at 85°.
Explicitly OUT of scope (deferred option B): a free-camera three.js rebuild for
true 0°/below-ground views — revisit as its own project if 85° proves
insufficient in practice.
Gate: manual — tilt reaches 85°, no render artefacts, stalks/contours visible.

## I3 — In-app notification system  *(foundation for I2, I6, I5, I12)*

Build a small, dependency-free notification layer (new
`components/Notifications.tsx` + `lib/notify.ts`):
- `notify.info/success/warning/error(msg, opts)` → stacked toasts, top-right,
  auto-dismiss (errors sticky until dismissed), BESSTY-styled.
- `notify.confirm({title, body, confirmLabel, danger}) → Promise<boolean>` →
  styled modal replacing `window.confirm`.
- `notify.prompt(...)` → styled input modal for the few `prompt(...)` sites.
A provider mounts once in `App.tsx`; `lib/notify.ts` exposes an imperative API
so non-React code can call it.
Then **sweep all 15 native-dialog sites** (files listed above) — every
`alert` → toast, `confirm` → `notify.confirm`, `prompt` → `notify.prompt`.
Gate: `grep -rE "[^.a-zA-Z](alert|confirm|prompt)\(" web/src` returns zero
app-code hits; catalog delete/overwrite flows exercised manually.

## I2 — Remove legacy localStorage + local catalogs; seed → global

Locked scope (Ryan): delete the localStorage layer **completely**, remove
project-local catalogs, and move bundled seed entries into the global
(Firestore) catalog.
1. **Seed → global**: one-time idempotent migration — on app start (admin/any
   signed-in user with write access), upsert every `seedCatalog.ts` entry into
   the Firestore global catalog keyed by entry id (skip existing). Once
   verified in prod, delete `seedCatalog.ts` from the bundle and its imports.
2. **Project `localCatalog` → global**: on project load, if `localCatalog` is
   non-empty, upsert those entries into the global catalog (id-keyed;
   on id collision with DIFFERENT content, write as a new id
   `<id>-from-<project>` and remap the project's sources), then strip
   `localCatalog` from the project doc on next save. `catalogScope: 'local'`
   stays tolerated in stored sources and resolves via the global catalog.
3. **Delete the localStorage store**: remove `lib/storage.ts` and the
   `firebase.ts` fallback banner/path; projects require Firestore. Remove the
   demo-seeding localStorage checks (`demoProject.ts`, `firestoreSeed.ts`
   leftovers). Surface a clear I3 error toast if Firestore is unreachable
   instead of silently falling back.
Order note: land AFTER I3 so migration outcomes ("3 local models moved to the
global catalog") surface as toasts.
Gate: fresh profile loads projects from Firestore only; a fixture project with
`localCatalog` migrates and re-solves identically (same source ids → same
levels); `grep -rn localStorage web/src` → zero app-code hits.

## I4 — Selection-based editing works on BESS-group members

Locked behaviour: multi-select bulk edits APPLY to units inside BESS groups as
**per-unit overrides that survive re-materialisation** (never detaching them);
the group wizard's "change all" can later OVERWRITE those manual edits.
Implementation: `onBulkUpdateSourcesByIds` (and the single-source editor) —
when a target source has `groupId`+`slotKey`, write the patch BOTH to the
materialised source and into the group's `unitOverrides[slotKey]` so
`materialiseBessGroup` re-applies it. Wizard bulk operations (model/mode swap,
I6) clear the overridden field from `unitOverrides` for affected slots — the
"overwrite manual edits" path.
Gate: unit tests on the materialiser round-trip — select 3 group units, bulk
edit elevationOffset → regenerate group → edits survive; wizard model swap →
override cleared and new model applied.

## I5 — Copy/paste (Ctrl+C / Ctrl+V), cross-project

Scope: **all selectable objects** — sources (incl. whole BESS groups when the
whole group is selected), barriers, receivers. Paste lands **at the mouse
cursor**, preserving the copied set's relative layout (translate centroid →
cursor lat/lng); fresh ids throughout; pasted group = a new group with new
`groupId` + remapped `slotKey` overrides.
Clipboard: `navigator.clipboard.writeText` of a JSON envelope
`{beesty: 1, version, objects: {...}}` → **cross-project and cross-tab paste
works for free** (locked: wanted). Paste reads the clipboard, validates the
envelope, ignores foreign content. Fallback to an in-memory buffer when the
Clipboard API is denied.
Keyboard: extend the existing `ProjectScreen` keydown pattern (Esc handler,
~line 198) with Ctrl/Cmd+C and Ctrl/Cmd+V, skipping text-input focus. Track
last mouse position on the map for the paste anchor (cursor outside the map →
paste at map centre).
Note: today `selectedIds` covers sources; barriers/receivers selection is
separate — extend copy to whatever the current selection model exposes, and
document what "selected" means per type in the PR.
Gate: unit tests on the envelope round-trip (ids remapped, offsets preserved,
group integrity); manual cross-project paste.

## I12 — Grid progress + kill "Page Unresponsive"

Locked: grid solves are the pain point; other freezes deferred.
1. **Progress**: extend the worker protocol with
   `{id, progress: {tilesDone, tilesTotal}}` posted per completed tile from
   `runBatchedGrid` (callback param) via `grid.worker.ts`. UI: MapChrome's
   button becomes a progress readout ("Computing 37%…") + a thin bar; add a
   **Cancel** button → `worker.terminate()` + respawn worker + generation
   counter so stale results are dropped.
2. **Unresponsive**: audit why Chrome flags the page. Known candidates, in
   order: (a) the main-thread `evaluateGrid` fallback path — make the worker
   path the ONLY grid path (delete or dev-flag the inline one); (b) contour
   polygon generation (`contourLines.ts`, d3-contour) on large grids — move it
   into the same worker call (return contour geometry with the grid) or chunk
   it with `await`-yields; (c) the DEM region snapshot capture before dispatch
   — chunk with yields if it shows up in profiling.
Gate: a deliberately huge grid (e.g. 512×512) shows live progress, Cancel
works, and Chrome raises no unresponsive warning through solve + contour
build.

## I15 — PDF export: bitmap basemap + vector results

A report-quality "snapshot" of the map as a PDF: the **basemap as a bitmap**,
everything computed drawn as **true vectors** on top — contour lines (when a
grid has been calculated) and receiver values coloured by compliance, exactly
as on screen.

- **Extent = the current viewport** (it's a snapshot). Export dialog offers
  page size (A4/A3, landscape default); the map extent is fitted to the page
  at the current aspect.
- **Basemap capture**: compose the visible raster tiles onto an offscreen
  canvas by FETCHING the tile URLs for the export extent/zoom (fetch → blob →
  `drawImage`) rather than screenshotting the Leaflet canvas — this sidesteps
  canvas CORS tainting and lets us render at 2× resolution for print. Embed as
  the PDF background image.
- **Vector overlays**, transformed lat/lng → page coordinates with the same
  projection as the basemap composition, mirroring the CURRENT layer toggles:
  - contour polylines per level band in the on-screen colours (labels on the
    major bands), from the already-computed contour geometry — no re-solve;
  - receivers as vector markers with the level text coloured by the
    active-period compliance (and the limit as the smaller second line when
    the I1 toggle is on);
  - sources, barriers, BESS group footprints and the calculation-area outline
    as drawn on screen.
- **Report furniture** (each a checkbox in the export dialog, all default ON —
  veto if unwanted): title block (project name, scenario/period, date), contour
  legend, scale bar, north arrow.
- Library: **jsPDF** (vector paths + text + image embedding in-browser) — the
  third and final new dependency, listed in the ground rules for sign-off.
- Entry point: an "Export PDF…" action next to the existing export options.

Gate: exported PDF opens in Acrobat/Chrome with selectable-text receiver
values, zoomable crisp contour lines (vector, not rasterised), basemap aligned
with the overlays at all zoom levels; a project with no grid exports receivers
over the basemap without error.

## I7 — Calculation-area box: live drag, anchored corners, rotation

1. **Live geometry while dragging** — box outline updates continuously during
   corner/edge/centre drags; the grid recompute still fires only on release
   (existing behaviour preserved).
2. **Corner drags anchor the opposite corner** (it stays fixed; centre moves),
   matching normal drawing-tool behaviour. Edge-midpoint handles resize one
   axis; centre handle moves the whole box.
3. **Rotation**: add `rotationDeg` to `CalculationArea` (additive, default 0).
   A rotate handle above the box + a numeric bearing field in the calc-area
   panel. **The compute grid rotates WITH the box** (locked): generate cells in
   the box frame (rotate cell offsets by `rotationDeg` about the centre before
   the lat/lng projection in `buildGridJob`/`runBatchedGrid`), so cells stay
   aligned to the box. Contour rendering + shapefile/raster exports must use
   the same rotated frame — audit `contourLines.ts`, `exporters.ts`,
   `Map3DView` draping for axis-aligned assumptions (d3-contour operates on
   the cell lattice, so contours come out in grid space and are projected
   per-vertex — verify that projection goes through the rotated transform).
Gate: unit test that a rotated job's cell lat/lngs are the rotation of the
unrotated ones; manual — drag/rotate feels right, contours align with the
rotated box, exports open correctly in QGIS.

## I10 — Settings as a tabbed floating window

Mechanics (locked): a **floating, draggable, non-modal** window (shared
`components/FloatingWindow.tsx` used by I11 too) — the map stays interactive
so setting changes are observable live; Esc closes; remembers position/size.
Settings move OUT of the side panel entirely.

**Tab grouping (LOCKED — Ryan, 2026-07-31): 15 sections → 5 tabs.**

| Tab | Sections |
|---|---|
| **1. Calculation** | Standard (1996/2024) · Band system · Solid-angle DΩ · Meteorological Cmet · Barrier diffraction (caps) |
| **2. Compliance** | Limit comparison (I17) — and the natural home for default receiver limits and the I15 PDF colour rules when they land |
| **3. Environment** | Ground (G) · Atmosphere (Aatm) · Topography/DEM (despike) |
| **4. Sources** | Source containers · General sources · Annex D wind turbines |
| **5. Performance** | Contour grid spacing · Propagation cutoffs · Drag extrapolation caps |

Rationale: 1 = "which maths", 2 = "how we judge the answer", 3 = "the site",
4 = "the machines", 5 = "speed/accuracy trade-offs". Compliance is deliberately
separate from Calculation — they're different decisions, often owned by
different people, and conflating "which standard" with "how we round" is how a
jurisdiction rule ends up buried under acoustics settings. Nothing user-facing
renames; sections move verbatim.

**Button placement (LOCKED — Ryan, 2026-07-31): both.** A gear in the top map
header (MapChrome, right-aligned near the Run-grid / layers controls) as the
primary, plus a "Settings…" link where the old side-panel tab was. The link is
for muscle memory during the transition — worth revisiting once the header gear
is habitual, but it stays for now.

Gate: every setting reachable in the window drives the same state as before
(no behaviour change); side panel no longer renders the settings sections;
old deep-links/tab state tolerated.

## I11 — Help as a searchable floating window

Locked: bundled-in content, markdown in the repo, client-side search
(`minisearch`), reusing the I10 `FloatingWindow`.
- Content: `web/src/help/*.md` (seeded by porting the current `HelpScreen`
  content, however minimal), front-matter for title/section. Vite imports them
  raw at build time; a tiny loader builds the nav tree + a `minisearch` index.
- Window: left nav + search box; content pane renders the markdown (small
  in-repo renderer or `marked` — prefer in-repo to avoid a dep; if a dep is
  needed, ask Ryan).
- The `?` button stays a REAL `<a href="#/help">`: middle-click/ctrl-click
  opens the standalone `/help` route in a new tab natively (locked
  requirement); plain left-click is intercepted to open the floating window
  instead. `/help` route renders the same component full-page.
Gate: search finds terms across pages; window opens over a running project
without disturbing it; middle-click opens the new tab.

## I14 — Factorial BESS configuration study

Locked shape: a **2-axis full factorial** — battery candidates × inverter
candidates — everything else held constant; transient results; matrix UI with
pass/fail as CELL COLOUR over the level (not extra tables); formatted XLSX
export (adds `exceljs`).

Flow (new modal launched from a toolbar/side-panel "Compare configurations…"
button):
1. **Axis setup**: pick the group(s)/sources forming the *battery* axis and
   the *inverter* axis (any source or group not assigned stays fixed). For
   each axis, tick **candidates = model + mode pairs** (a model may appear
   multiple times with different modes; modes listed from each model's
   catalog entry).
2. **Receivers**: tick the receivers to evaluate (default: all).
3. **Run**: for each (battery-candidate, inverter-candidate) combo, clone the
   resolved source list with the axis members' model+mode swapped (reusing the
   I6/I4 override machinery in-memory — the PROJECT IS NOT MUTATED), solve the
   selected receivers via the existing `evaluateProject` path, collect
   per-receiver totals. Combos run sequentially with a progress bar +
   cancel (receiver solves are fast; N_bat × N_inv × receivers is cheap).
4. **Results**: matrix per receiver — **batteries across the top, inverters
   down the side** (locked orientation); each cell shows total dB(A), coloured
   green/red (with margin shading) against that receiver's active-period
   limit. A receiver picker + an "All receivers" view showing worst-case level
   per combo. Results are transient (kept in component state; re-run to
   refresh; not persisted to the project).
5. **Export**: one XLSX via `exceljs` — a sheet per receiver plus a worst-case
   summary sheet; header styling, conditional fill matching the on-screen
   pass/fail colours, limits + scenario metadata in a header block.
Gate: unit test the combo enumeration + source-swapping (project untouched
afterwards); manual run on a demo project; XLSX opens in Excel with colours.

---

## I18 — Reflections: absorptive barriers + reflective BESS containers

Locked shape (Ryan, 2026-07-31): barriers get an **editable absorption
coefficient** and become **reflecting surfaces**; **BESS containers reflect
too**; reflections default **ON up to 3rd order for point receivers** and
**OFF for contour grids**. Both are user-overridable, mirroring the existing
`settings.containers.{receiverCalc,grid}` split.

The physics is already built and validated in the engine — this item is
entirely BEESTY-side plumbing plus the culling strategy below.

**Model + scene changes**
- `Scene.reflectors: []` → `SceneReflector[]`; add the type
  (`{ segment: [[e,n],[e,n]], base_z, top_z, alpha }`, optional `alpha_bands`;
  engine validates `α ∈ [0,1]` and `top_z > base_z`). Leave `cylinders: []`
  alone — no BEESTY object is cylindrical.
- `settings.max_reflection_order` becomes a real setting, not the hardcoded 1.
- New `ProjectSettings.reflections?: { receiverCalc?: boolean; grid?: boolean;
  maxOrder?: number }` — absent ⇒ `{receiverCalc: true, grid: false,
  maxOrder: 3}` per the locked defaults. **This changes existing projects'
  reported levels**, so it lands with the A/B note below.
- `wallFromBarrier` keeps emitting the screening `Wall`; a parallel
  `reflectorsFromBarrier` emits one reflector per densified segment carrying
  `alpha = absorptionCoeff`. A wall must appear in BOTH lists — the engine
  keeps them separate deliberately (*"so the reflected ray isn't also
  diffracted by the same surface"*), so listing twice is the intended usage,
  not double-counting. Pin that with a test.
- Containers emit their 4 facades as reflectors when the container is
  modelled (reuse `containerFootprint` corners; `alpha` from a new
  `CatalogEntry.facadeAbsorption`, defaulting ~0.1 for painted steel).

**UI**
- Barrier row: absorption input beside top height (0–1, step 0.05, default
  0.2). Worth a preset hint — 0 hard/reflective, 0.2 typical, 0.6+ absorptive
  treatment.
- New "Reflections" settings section: the two toggles, an order selector
  (1–3), and the reflector-budget readout from the culling note below.

**The binding constraint — reflector budget.** The engine bounds higher-order
enumeration at 100k paths (`Σ m·(m−1)^(k−1)` for k=2..order) and REJECTS the
scene above it. At order 3 that caps the scene at **46 reflecting surfaces**
(47 ⇒ 101,614 paths ⇒ rejected). A container contributes 4 facades, so a naive
implementation dies at **~11 BESS units** — a real site has hundreds. Order 3
across a whole BESS array is therefore not reachable by simply switching it on.

Culling is thus part of the feature, not an optimisation:
1. Keep only facades whose plan segment lies within a corridor around the
   source→receiver line (plus a margin), evaluated per receiver group.
2. Drop back-facing facades — a facade whose outward normal points away from
   both source and receiver can never carry a specular path.
3. Cap the surviving set (nearest-first) and **degrade the order rather than
   fail**: if the budget still can't take order 3, drop to 2, then 1, and
   surface that in the UI. Silent truncation is not acceptable — the readout
   must say what was dropped.

This is also why contours default OFF: a grid solves every cell, and the
reflector set would have to be re-culled per tile.

Gate:
- Unit: a wall listed as obstacle + reflector screens AND reflects; α = 1
  contributes nothing; α = 0 gives the full `10·lg(1−α)` = 0 dB image source.
- Unit: the culler never drops a facade that carries a valid specular path for
  the tested geometry, and the emitted count always satisfies the engine's
  guard for the chosen order.
- Integration: a level actually MOVES when reflections are enabled — the
  containers bug (shipped inert because nothing populated the field) is the
  precedent; assert dB, never just that the scene serialises.
- A/B: re-run the V1/V2 SoundPLAN comparison with reflections OFF to confirm
  the existing agreement is untouched, then record the ON deltas separately.

---

## I19 — Persist display settings on the project

Every display setting is currently plain `useState` in `ProjectScreen` and
resets on reload: `contourMode`, `contourOpacity`, `contourStepDb`,
`contourBounds`, `palette`, `domainMode`, `fixedDomain`, `baseMap`,
`showContours`, `showGridDebug`, `showReceiverLimits`, `gridSpacingM`. Setting
up a view is real work and currently survives nothing.

Locked (Ryan, 2026-07-31): persist **on the project**, not per user — reopening
a project restores the view it was left in, and a colleague opening the same
project sees the same presentation.

- New `ProjectSettings.display?: { … }`, all fields optional, absent ⇒ today's
  defaults (so old projects load unchanged, and I8's lines-only default still
  applies to anything that never chose).
- `gridSpacingM` is the one to be careful with: it has an auto-pick that
  freezes once the user touches the picker (`gridSpacingTouchedRef`). Persist
  the *touched* flag too, or reopening re-auto-picks over a deliberate choice.
- `showGridDebug` should NOT persist — it's a diagnostic, and a project that
  reopens covered in pink dots looks broken.
- Writes go through the existing debounced project save; a slider drag must not
  emit a Firestore write per frame (reuse the debounce, don't add a new one).

Gate: set a distinctive view (filled contours, magma, 2 dB steps, fixed
domain), reload → identical; a project saved before this change still opens
with the current defaults; dragging the opacity slider produces one write, not
fifty.

## I20 — Surface every silent truncation

The I13 bug existed because a cap (4000 debug dots) was applied by quietly
thinning the data — the output looked plausible and misreported reality for
months. The same pattern exists elsewhere, and in a compliance tool an
invisible approximation is the dangerous kind.

Locked (Ryan, 2026-07-31): don't silently truncate anywhere; make each cap
report itself. Once the warnings show which caps actually bite in real
projects, loosen the ones that fire too often — the reporting comes first
precisely so that decision is evidence-based.

**Known caps to instrument** (audit for more while implementing):

| Cap | Where | Effect when it bites |
|---|---|---|
| Barnes-Hut `theta` clustering | `sourceTree.ts` / `buildGridJob` | distant sources merged into one stand-in |
| `TERRAIN_MAX_CELLS_PER_AXIS` = 2048 | `terrainField.ts` | terrain resampled coarser than the DEM |
| `maxContributionDistanceM` | `propagation.ts` | sources beyond it contribute nothing |
| `−120 dB` grid floor | `gridCore.ts` | very low cells clamped |
| `MAX_WALL_SEGMENT_M` densification | `sceneBuilder.ts` | barrier profile sampled coarsely |
| 20 000 debug dots | `MapView.tsx` | already warns (console) — fold into the same channel |
| reflector budget | I18, when it lands | reflection order silently degraded |

**Shape**: a `lib/diagnostics.ts` collector that a solve writes notes into
(`{ code, severity, message, detail }`), returned alongside the results rather
than logged. Surface it as:
- a count badge in the results dock ("3 approximations applied") opening a
  small panel listing them, and
- an I3 toast for anything that materially changes numbers (clustering active,
  terrain downsampled), once per solve — not per tile.

Every entry says what was capped, what the cap was, and what it cost where that
is knowable (e.g. "terrain resampled to 24 m from the DEM's 20 m").

Gate: force each cap with a deliberately hostile project (10 km² grid, 5000
sources, huge DEM) and confirm each reports; a normal project reports nothing
and shows no badge. Unit-test the collector's dedup (one entry per cap per
solve, not one per tile).

---

## Suggested commit order

| # | Item | Size |
|---|---|---|
| 1 | I8 contour default | XS |
| 2 | I1 limits on markers | S |
| 3 | I17 integer limit comparison + toggle | S |
| 4 | I13 debug-grid bug | S |
| 5 | I9 3D pitch to 85° | S |
| 6 | I6 change-all modes | S |
| 7 | I16 paste spectra from Excel | S |
| 8 | I3 notification system + 15-site sweep | M |
| 9 | I2 localStorage removal + catalog migrations | M (careful) |
| 10 | I4 group-member selection edits | M |
| 11 | I5 copy/paste | M |
| 12 | I12 progress + responsiveness | M |
| 13 | I15 PDF export (basemap + vector results) | M |
| 14 | I7 calc-area drag/rotation | M/L |
| 15 | I10 settings window (after grouping approval) | M |
| 16 | I11 help window | M |
| 17 | I14 factorial study | L |
| 18 | I18 reflections (barriers + containers) | L |
| 19 | I19 persist display settings on the project | S |
| 20 | I20 surface every silent truncation | M |

Items 1–8 are **done** (commits `5234e36` → `2319613`); see
`beesty-improvements-testing.md`. I19 is a quick win and can jump the queue.
I20 wants to land before or alongside I18, whose reflector budget is exactly
the kind of cap it exists to expose.

## Risks / watch-items

- **I2 is the only destructive item** — it deletes a persistence layer.
  Migrations must be idempotent and verified against a real project backup
  before the localStorage code is removed (sequence: migrate → verify →
  delete). Everything else is additive or display-level.
- **I7 rotation** touches the grid frame — the one place a mistake could move
  numbers. The rotation must be a pure re-parameterisation (cells rotate,
  physics untouched); the unit test in I7 pins that.
- **I12** changes the worker protocol — keep it backward-compatible within the
  session (version the message) so a stale worker doesn't wedge the UI.
- **I14** must never mutate the project — swaps happen on the resolved-source
  clones only; the gate test asserts the project JSON is byte-identical after
  a run.
- **I18 is the only item that changes reported levels on existing projects.**
  Turning reflections on by default for point receivers will raise levels at
  receivers facing a wall or a container row — that is the point, but it must
  be announced, A/B'd against the SoundPLAN validation set, and dated, or a
  re-opened project will look like it regressed.
- **I18's reflector budget is a hard engine limit, not a performance knob** —
  46 surfaces at order 3. The order must degrade automatically and say so;
  a scene over the limit is rejected outright, which would surface to the user
  as a failed solve rather than a slow one.
- **I18 double-listing is correct** — a wall belongs in both `obstacles` and
  `reflectors`. Anyone "fixing" that apparent duplication will silently delete
  either the screening or the reflection, so the test must state the intent.
- **I20 must not become noise.** If every solve raises three toasts, they stop
  being read and the item has made things worse. Dock badge is the default
  surface; a toast is only for caps that materially move numbers. The follow-up
  loosening pass is part of the item, not optional.
- **I19 must not write per frame.** Display settings change on slider drags;
  route them through the existing debounced save or a project doc gets a write
  per animation frame.

---

# Addendum (2026-08-04) — decisions, the solve-pipeline audit, Barnes-Hut in full

## Decisions recorded (Ryan)

- **Settings**: gear button moves into the side panel (top-right); the side
  panel's Settings tab goes away; inline settings text gets trimmed with the
  detail moved to help pages.
- **Factorial study**: becomes a draggable background FloatingWindow. Editing
  stays enabled while it runs; results are labelled with the snapshot time
  they were computed against.
- **Barrier attenuation / reflections**: no external reference case exists —
  build first-principles validation cases (V-items below) plus an adversarial
  code review of the reflection path.
- **BESS groups**: per-group "Reset overrides" button that discards ALL
  per-unit manual changes (position deltas, modes, elevations) and
  re-materialises the group from its wizard settings.
- **Reflection order cap** stays at ≤ 3 with the existing path budget.

## Solve-pipeline audit — why the app janked on anything that re-solves

Ryan's report: jank when moving barriers, moving objects right after another
move, moving things while a grid solves, zooming after a move — "things that
trigger an update of the solve". All four mechanisms found:

1. **Point solve runs on the MAIN thread.** `evaluateProject`
   (`web/src/lib/solver.ts:218`) is synchronous wasm per receiver, fired 80 ms
   after every structural edit or settled drag (ProjectScreen point effect).
   With hundreds of sources it blocks all input for the full solve — the
   "can't move a second thing right after the first" feel. → **P1** below.
2. **Background regrids queued instead of superseding.** The single grid
   worker queues posted jobs and nothing ever terminated a stale one (the ✕
   button was the only caller of `cancelGridRun`). Each settled drag posted
   another full solve; with 5–8 s solves a burst of edits kept the worker
   busy on dead geometry for minutes. **FIXED (this commit):** the worker
   layer now terminates the in-flight job when a new one posts — newest
   geometry wins — and stale promises settle immediately with
   `GRID_CANCELLED` instead of hanging into the 60 s dead-man timeout.
3. **Background regrids were invisible.** The auto path set no status and no
   progress, so the app "got slow for no reason". **FIXED (this commit):**
   auto-regrids drive the same computing status + progress bar as a manual
   run (and are cancellable); debounce raised 150 → 600 ms so nudge bursts
   coalesce.
4. **Contour rebuild lands on the main thread.** When a grid completes,
   contour polylines are extracted and the Leaflet layers rebuilt on the main
   thread — the hitch felt when "zooming after moving an object" is the
   background regrid completing mid-gesture. → **P3**.

Planned (P-items), in order of impact:

- **P1 — point solve to a worker.** Same job/region pattern as the grid
  (resolve catalog + geometry on the main thread, solve in the worker). This
  removes the last main-thread wasm and is the single biggest smoothness win.
- **P2 — grid worker pool.** Tiles are already independent jobs; run K
  workers (≈ `hardwareConcurrency − 2`) round-robin over tiles. The 5–8 s /
  800-source grid is single-core today, so this is a ~4–8× wall-clock cut —
  and it, not θ, is the honest answer to grid speed (see Barnes-Hut below).
- **P3 — contour extraction in the worker.** Return the line sets with the
  grid so `setGrid` only swaps layers.
- **P4 — incremental regrid** (later): re-solve only tiles whose effective
  source list changed. Requires per-tile result caching; after P2.

## Barnes-Hut source aggregation — the method, comprehensively

Implementation: `web/src/lib/sourceTree.ts` (tree + walks), consumed per
named receiver via `propagation.ts` and per grid tile in
`solver.ts::buildGridJob`.

**Build.** All finite-position sources go into an adaptive quadtree: the
bounding box splits at its geometric midpoint into four quadrants,
recursively, until a node holds ≤ 4 sources (`LEAF_CAP`). Each node stores:

- the **energy sum** of its members' Lw spectra per band (not dB averaging —
  the spectra are converted to linear energy, summed, and back);
- the **energy-weighted centroid** (lat/lng) and energy-weighted mean source
  height — so the aggregate sits where the acoustic power actually is, not at
  the geometric middle;
- its bounding-box **diagonal `s`** (metres) — the "size" in the acceptance
  test;
- a `containsWtg` flag (see the turbine rule).

Build cost is O(N log N) once per solve snapshot; spectra resolve through a
per-(model, mode, wind) cache so rebuilds aren't catalog-bound.

**Walk (per receiver).** Depth-first from the root. At each node, with `d` =
distance from the receiver to the node centroid, the **multipole acceptance
criterion** is `s / d < θ`:

- **Accepted** → the whole subtree collapses to ONE virtual source at the
  centroid carrying the summed spectrum and mean height. The engine then
  evaluates a single ISO 9613-2 path for it (divergence, air absorption,
  ground, screening) instead of one per member.
- **Rejected** → recurse into the children; leaves emit their real sources
  individually (full treatment, exact positions).

`θ = 0` disables clustering entirely (every real source, always). A hard
distance cutoff (`maxContributionDistanceM`) prunes whole subtrees whose
nearest face lies beyond it.

**Per-tile walk for grids.** Grid cells are processed in 16×16-cell tiles,
and each tile does its own walk (`walkSourceTreeForRegion`) with `d` measured
from the node centroid to the NEAREST point of the tile rectangle. A cluster
is therefore only accepted when it is far from the *entire* tile — cells near
a source never see it collapsed, cells far away share one aggregate. One tree
serves every tile.

**The turbine rule.** A multi-source node containing a WTG is never accepted:
the walk recurses until each turbine is an individual source. Folding a WTG
into a cluster would silently drop its Annex D treatment (G ≤ 0.5 cap, 4 m
receiver convention, 3 dB screening cap), which changes certified numbers.
BESS/auxiliary sources cluster freely.

**Error argument.** Representing a cluster by its centroid displaces each
member by at most s/2, so the worst single-member distance error is a factor
(1 ± s/2d), i.e. `s/d < θ` bounds the worst-member divergence error to about
`20·log10(1/(1−θ/2))` dB — ~1.2 dB at θ = 0.25 for the very worst member.
Because the centroid is energy-weighted, first-order errors cancel across the
ensemble and the aggregate error is second-order, O((s/d)²) — in practice
≪ 0.5 dB at the default θ = 0.25. Two caveats the bound does NOT cover:

- **Screening is evaluated on the centroid ray only.** A cluster straddling a
  barrier edge or ridge line uses one representative path; members that are
  actually screened differently get smeared. This *raises* levels when the
  centroid ray is unscreened but members aren't (and vice versa). Relevant to
  the "barrier attenuation looks low" investigation: the V-cases below run at
  θ = 0 as well as the default, to separate engine correctness from
  clustering artefacts.
- **θ ≥ 1 has no error guarantee at all** (at s/d = 1 a member can sit at
  distance ~0 from the receiver). θ = 2 is a stress-test setting, not a
  results setting.

**Why θ = 0.1 vs 2.0 was only 8 s vs 5 s at 800 sources.** The criterion can
only fire where `d > s/θ`, and a contour grid drawn over the site itself is
near-field almost everywhere. Take a ~500 m-diagonal yard: at θ = 0.25 the
whole yard collapses only for receivers beyond ~2 km; quarter-nodes (~250 m)
beyond ~1 km. Cells inside or beside the array bottom out at the leaves and
see essentially all 800 sources individually — *correctly*, because their
nearest sources dominate and must not be smeared. So the grid's workload is
near-field-dominated and θ-insensitive; only the outer ring of tiles ever
clusters, which is exactly the 8 → 5 s you measured. The treecode is doing
what it should — named receivers a kilometre out collapse the whole site to a
handful of aggregates — but grid speed is governed by near-field volume on a
single core. The fix for that is **P2 (worker pool)**, not a bigger θ.

### D-item — Barnes-Hut debug layer (new)

Layers tab → Debug → **"Barnes-Hut clustering"**. Pure TS + Leaflet overlay;
no engine change; walks re-use the existing tree functions with the current θ
and cutoff.

- **Tile view** (grid mode): draw the 16×16-cell tile boundaries, each tile
  labelled with its effective-source count (`walkSourceTreeForRegion` per
  tile — the same call `buildGridJob` makes, so the display IS the truth).
  Expectation with 800 sources: tiles over the array read ≈ 800, the far ring
  collapses to dozens. If a far tile still reads ≈ 800, something is wrong —
  this view is the instrument that would show it.
- **Inspect one target**: click a tile (or a named receiver) → overlay that
  walk's result: accepted cluster nodes as translucent rectangles (their
  actual bboxes) with centroid dot + member count + combined dB(A), real
  pass-through sources as dots. WTG-forced expansion is visible here too.
- **Header readout**: `N real → M effective (K clusters)` for the inspected
  target, plus the active θ / cutoff.

## V-items — reflection & barrier validation cases (from Ryan's spec)

All implemented as wasm-path tests (`web/src/lib/*.wasm.test.ts` style) so
they validate the app's actual wiring — catalog → sceneBuilder → engine —
not just the engine. Each runs at θ = 0 (no clustering) and default θ.

- **V-R1 — direct path.** One omni point source, flat hard ground, no
  obstacles: assert `Lp = Lw − (20·log10 d + 11) − Aatm − Agr` against a hand
  calculation per band, within 0.1 dB, at 100 / 500 / 1000 m.
- **V-R2 — same-side wall (Ryan's case 1).** Long reflective barrier BESIDE
  the source; receiver on the SAME side, in the specular zone. With
  reflections ON, the image source at the mirrored distance adds
  `ΔL = 10·log10(1 + (1−α)·(d/d')²·10^(−ΔAatm/10))` over the no-barrier
  level. Sweep α ∈ {0, 0.3, 0.7, 1.0}: α = 1 must equal no-barrier exactly;
  the gain must fall monotonically with α; α = 0 must match the hand value.
- **V-R3a — canyon ladder (calculable multi-order).** Two parallel α = 0
  walls with the source between; receiver beyond the OPEN END with sight down
  the axis, so every image of every order is unscreened at a known distance.
  The image ladder sums in closed form — assert against it for order 1, 2, 3,
  and check the order-3 total exceeds order-1 by the hand-computed margin.
- **V-R3b — enclosure (Ryan's case 2, bounded).** Source ringed by four
  reflective walls, receiver outside. No clean closed form once diffraction
  mixes with reflection, so assert the calculable structure instead: level
  with α = 1 equals the barrier-only (reflections-off) level; level rises
  monotonically as α → 0; and the α = 0 vs α = 1 delta stays within
  hand-derived bounds from the escaping image paths.
- **V-B1 — insertion loss sanity.** Same geometry as V-R2 but receiver on the
  FAR side: assert Dz against the ISO §7.4 single-edge formula by hand for
  two or three path differences (the "barrier attenuation looks low" check),
  plus the 20/25 dB caps.
- Alongside: adversarial Fable review of `reflectors.ts`, the sceneBuilder
  reflection emission, and the engine's image-source path (read-only).

## Work queue (updated 2026-08-04)

| # | Item | Size | Status |
|---|---|---|---|
| A | Settings gear → side panel top-right; tab removed; verbosity trim | S | next |
| D | BESS "Reset overrides" button | S | queued |
| E | BESS wizard Esc layering (segment editor first) | S | queued |
| F | Wall drawing: right-click finishes; click-near-start closes loop | S–M | queued |
| B | Factorial study as background FloatingWindow (+ snapshot label) | M | queued |
| V | V-R1…V-B1 validation cases + reflection review | M | queued |
| P1 | Point solve to a worker | M | queued |
| P2 | Grid worker pool | M | queued |
| I | Barnes-Hut debug layer | M | queued |
| P3 | Contour extraction in worker | S | queued |
| H | DEM fetch box ignores calc-area rotation (corner under-coverage) | S | queued |
| P4 | Incremental regrid | L | later |

# BEESTY improvements plan (2026-07-30)

Fourteen improvements to the BEESTY web app, scoped with Ryan (Q&A 2026-07-30 —
every decision below is locked; the ONE open item needing approval is the
Settings tab grouping / button placement in I10). Written for an implementing
session. Items are ordered for execution: quick wins → the notification system
(a dependency of later items) → structural work → the factorial study.

## Ground rules

- Per-item gate: `npm run lint` (tsc), `npm run build`, `npm test` green.
  Commit per item, style `web(improve N): …`. No AI trailers.
- **No solver-number changes.** Nothing here may alter computed levels except
  where an item explicitly says so (none do — I13 fixes a *display* bug).
- Firestore/project schema changes are additive and parse-tolerant; old
  projects must load unchanged (except the I2 migration, which is explicit).
- New dependencies are limited to: `exceljs` (I14 formatted XLSX export),
  `minisearch` (I11 help search), and a tiny in-repo window/toast layer built
  by hand (no UI framework). Anything else needs Ryan's sign-off.
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
Colour behaviour unchanged. NOT added to the side panel (Ryan: map only).
Toggle: a "Show limits" checkbox in the **layers tab** alongside the other
display toggles, persisted with the same mechanism they use; default OFF.
Touch: `MapView.tsx` `receiverMarker` (marker HTML/label), layers tab in
`SidePanel.tsx`, the layers-state type.
Gate: toggle on → both numbers render (level prominent, limit smaller);
period switch updates the limit; toggle off → exactly today's marker.

## I6 — BESS "change all" can change mode  *(quick win)*

Extend the wizard's Bulk model swap (`BessGroupWizard.tsx`) with a mode
selector: when swapping model + mode, the mode list comes from the target
model; when changing mode only, apply to units whose current model supports
that mode and report "N skipped (mode not available)" via the I3 toast (plain
text until I3 lands). Mode-only changes write the same per-unit override path
the model swap uses.
Gate: unit test on the swap helper (model+mode, mode-only incl. skip count).

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

## I10 — Settings as a tabbed floating window  *(grouping needs Ryan's approval)*

Mechanics (locked): a **floating, draggable, non-modal** window (shared
`components/FloatingWindow.tsx` used by I11 too) — the map stays interactive
so setting changes are observable live; Esc closes; remembers position/size.
Settings move OUT of the side panel entirely.

**PROPOSED tab grouping (14 sections → 4 tabs) — approve or amend:**

| Tab | Sections |
|---|---|
| **1. Calculation** | Standard (1996/2024) · Band system · Solid-angle DΩ · Meteorological Cmet · Barrier diffraction (caps) |
| **2. Environment** | Ground (G) · Atmosphere (Aatm) · Topography/DEM (despike) |
| **3. Sources** | Source containers · General sources · Annex D wind turbines |
| **4. Performance** | Contour grid spacing · Propagation cutoffs · Drag extrapolation caps |

Rationale: tab 1 = "which maths", 2 = "the site", 3 = "the machines",
4 = "speed/accuracy trade-offs". Nothing user-facing renames; sections move
verbatim.

**PROPOSED button placement — pick one:**
- (a) **Gear icon in the top map header (MapChrome), right-aligned near the
  Run-grid/layers controls** ← recommended: always visible, one click from
  anywhere, frees side-panel real estate.
- (b) Gear pinned at the bottom of the side-panel tab strip.
- (c) Both (header gear + a "Settings…" link where the old tab was, for
  muscle memory during transition).

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

## Suggested commit order

| # | Item | Size |
|---|---|---|
| 1 | I8 contour default | XS |
| 2 | I1 limits on markers | S |
| 3 | I13 debug-grid bug | S |
| 4 | I9 3D pitch to 85° | S |
| 5 | I6 change-all modes | S |
| 6 | I3 notification system + 15-site sweep | M |
| 7 | I2 localStorage removal + catalog migrations | M (careful) |
| 8 | I4 group-member selection edits | M |
| 9 | I5 copy/paste | M |
| 10 | I12 progress + responsiveness | M |
| 11 | I7 calc-area drag/rotation | M/L |
| 12 | I10 settings window (after grouping approval) | M |
| 13 | I11 help window | M |
| 14 | I14 factorial study | L |

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

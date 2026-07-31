# BEESTY improvements — what shipped, and how to test it (2026-07-31)

Covers the first tranche of `beesty-improvements-plan.md`: the eight quick-win
items (I8, I17, I1, I13, I9, I3, I6, I16). Commits `5234e36` → `f882872`,
pushed to `BESSTY/main`.

Automated state: **90 tests pass**, `tsc -b --noEmit` clean, `vite build` clean.
Everything below is what automation *can't* check — the visual and interaction
behaviour. The app is sign-in gated, so none of this was verified in a running
browser; it all needs your eyes.

---

## 1. Priority tests — these change numbers or verdicts

### I17 — Integer limit comparison *(highest risk item)*

**This changes pass/fail on existing projects the first time you open them.**
Integer is now the default: a receiver at 40.4 dB against a 40 dB limit was red
and is now green.

- Open a project you know well with a receiver sitting just over a limit.
  Confirm the marker flipped red → green, and that the **displayed level still
  reads 40.4** — only the verdict rounds, never the number.
- Settings → **Limit comparison** → *Exact*. The same receiver must go back to
  red immediately.
- Check the four surfaces agree on the same receiver at once: **map marker
  colour**, **receiver list row**, **results dock "N over" count**, and the
  dock's **"Worst"** line. Before this change the dock's "Worst" line coloured
  on a different rule and would have shown red while the map showed green.
- Export CSV/XLSX and confirm the pass/fail column matches the screen.
- Edge cases worth one look: exactly 40.0 (passes both modes), 40.5 (rounds
  half-up to 41 → fails), a receiver with no result at all (dash, not a fail).

### I8 — Contours default to lines

- Open any project and run a grid: you should get **lines only**, no fill.
- Switch to Filled/Both — it should still work; it just isn't the default.
- Note: this resets on every reload (see Observation 1 below).

---

## 2. Visual / interaction tests

### I1 — Limits on receiver markers

- Layers tab → **Receivers → "Show limits on markers"** (default off).
- Turn it on: each receiver gets a smaller second line, `limit 40`, under the
  level.
- Change the scenario period day → evening → night. The limit shown must track
  the active period.
- Markers are draggable and the icon grows taller when limits are shown —
  **drag one and confirm it doesn't jump** as you pick it up (the anchor moves
  with the icon size; worth one check).
- Turn it off: the marker should be pixel-identical to before this change.

### I13 — Debug grid spacing *(a real bug, now fixed)*

The dots were drawn every *n*th cell whenever a grid exceeded 4000 cells, so a
100 m grid over a ~10 km area drew at 200 m. Reproduce the original conditions:

- Set a **large calculation area (~10 km)** and **100 m grid spacing**, run the
  grid, then Layers → *Debug: show grid cell centres*.
- Measure across a known span — dots must now be **100 m apart**, matching the
  spacing setting.
- **Pan and zoom.** Dots are now drawn for the visible area only and redraw on
  move; confirm they keep appearing as you pan and stay aligned with the contour
  lines.
- Zoom right out over a big grid: it may cap at 20,000 dots and log a console
  warning. That's intended — confirm it warns rather than silently thinning.

### I9 — 3D camera to 85°

MapLibre's default `maxPitch` is 60, so the intended 70° opening view was being
silently clamped. Both are fixed together.

- Open 3D. The **opening view should now be noticeably lower//flatter** than
  before (70°, previously clamped to 60°).
- Drag the pitch down to the new maximum (85°, ~5° above horizon).
- **This is the check I couldn't do**: at 85° confirm the sky/fog/horizon still
  render sensibly, terrain doesn't tear at the horizon, and source/receiver
  stalks and contours remain visible. If the horizon looks wrong, the `sky` /
  `fog-ground-blend` values in `Map3DView.makeStyle` are the dials.

### I3 — Notifications

All 14 native `alert`/`confirm`/`prompt` calls are gone. Worth exercising each:

- **Toasts**: import a catalog file with no entries (warning), or a broken one
  (error). Errors are **sticky** — they stay until you click ✕; other kinds
  auto-dismiss after 5 s.
- **Confirm**: delete a project, a group, a BESS group, or a saved version.
  Check the ✕/backdrop/Esc all cancel.
- **Destructive dialogs are deliberately harder to trigger**: focus starts on
  *Cancel* and **Enter does nothing**. You must click Delete. Non-destructive
  dialogs still take Enter. Confirm both.
- **Prompt**: "+ New project", and "Name this group" with 2+ objects selected.
  Enter submits, Esc cancels, the field is pre-selected for overtyping.
- **Queueing**: if you can trigger two dialogs at once, both should be answered
  in turn rather than one vanishing.
- **The catalog import weighting question** is now two labelled buttons —
  *A-weighted (LwA)* vs *Z-weighted (raw Lw)* — instead of an unlabelled
  OK/Cancel. See Observation 3: Esc still means Z-weighted, which is a trap.

### I6 — BESS "change all" can change mode

In the BESS group wizard, the section is renamed **Change all**.

- Per model: **"change mode…"** next to the model swap. Disabled (greyed) for
  single-mode models.
- With **two or more different models** in a group, a group-wide **"set mode…"**
  appears. Pick a mode only some models have (e.g. a night mode on the BESS but
  not the inverter): it should apply where supported and toast
  *"N units set to …. M units skipped (mode not available)."*
- Verify it reaches **nested groups**, not just top-level rows — build a group
  with a nested repeated block and confirm those units changed too.
- Swap a model and confirm the mode resets to the new model's default.

### I16 — Paste spectra from Excel

In the catalog entry editor's spectrum table:

- Copy a **vertical column** of levels in Excel → click the first band cell →
  Ctrl+V. Values fill downward from that cell.
- Copy a **horizontal row** → same result.
- **Start mid-table** — cells above the focused one must be untouched.
- Copy **more values than there are bands** → toast says N ignored.
- Copy a **2-D block** → rejected with a toast, nothing written.
- Copy a range with a **blank cell in the middle** → the blank band keeps its
  old value and *later values stay on their correct frequencies*. This is the
  one to check carefully; the alternative (shifting everything up) produces
  plausible-looking wrong numbers.
- Copy something with **text in it** → whole paste rejected, nothing written.
- A **single cell** paste still behaves like normal typing.

---

## 3. Observations — things worth considering that aren't in the plan

Numbered so you can reply to them individually.

**1. No display settings persist at all.** `contourMode`, `palette`,
`showContours`, `baseMap`, `contourStepDb`, contour bounds and grid spacing are
all plain `useState` in `ProjectScreen`. Every reload resets them. I8's plan
wording ("explicitly saved choices are untouched") assumed a persistence layer
that doesn't exist. Suggest a small item: persist display preferences, probably
per-user rather than per-project, so a reload doesn't undo your view setup.

**2. Exports don't record which comparison mode produced the verdicts.** A CSV
or XLSX now says "pass" for a 40.4 dB receiver against 40 dB, and nothing in the
file says integer rounding was applied. For a consulting deliverable that's a
traceability gap — a reviewer can't reproduce the verdict from the file. Suggest
adding the comparison mode (and ideally the standard edition and DΩ) to export
metadata. Cheap, and it matters for defensibility.

**3. The A-weighted/Z-weighted import question is still a trap.** It's a
two-way *choice* forced into a yes/no dialog. I've labelled the buttons, but
**Esc / backdrop-click still resolves to Z-weighted**, silently — and the wrong
answer shifts every propagated level by 3–5 dB. It should be a three-option
dialog (A / Z / **Cancel the import**) or a radio in the import modal that
can't be dismissed into a default. This is the highest-consequence UX issue I
found.

**4. Nobody had verified the 3D default view.** `pitch: 70` never applied
because `maxPitch` defaults to 60. That's a silent clamp that survived because
the result still looked plausible. Worth a quick audit of other MapLibre/Leaflet
options set on faith — anything set at construction that a library may clamp.

**5. Silent truncation is a recurring pattern.** The debug-grid bug was a cap
(4000 dots) applied by quietly thinning the data. The I18 plan already carries a
"no silent caps" note; the same discipline is worth applying to the Barnes-Hut
clustering threshold and the 2048-cell terrain axis cap — both currently
degrade accuracy without telling anyone. Neither is wrong; they're just
invisible.

**6. `limitForPeriod` silently defaults to 40 dB** when a receiver has no limit
set for the active period (`types.ts` ~319). A receiver imported without limits
gets judged against 40 dB and shows a normal red/green verdict, indistinguishable
from a deliberate limit. Suggest rendering "no limit set" as a neutral/grey
marker rather than inventing one.

**7. Container catalog values are still placeholders.** Last session's fix gave
`containerHeightM` a per-kind fallback (BESS 2.6 m, aux 2.2 m), but no real
product carries a measured value yet, and the catalog editor field is now there
to take them. Same will apply to `facadeAbsorption` when I18 lands. Worth an
hour with datasheets at some point — the fallbacks are plausible, not sourced.

**8. Toasts have no cap.** A loop calling `notify.*` would stack indefinitely.
Not reachable today; would be once I12 (grid progress) starts emitting
per-tile messages. Worth a max-N-and-collapse rule when I12 lands.

**9. I10 is still blocked on you** — the 4-tab settings grouping
(Calculation / Environment / Sources / Performance) and where the gear button
lives (map header / side-panel tab strip / both). It's the only plan item that
can't proceed without a decision. The settings panel gained two more sections
this tranche (Limit comparison, and the Receivers card in Layers), so the
grouping is getting more valuable, not less.

---

## 3b. Second tranche — I19, I4, and I2 (part)

### I19 — Display settings persist on the project

- Set a distinctive view: filled contours, magma palette, 2 dB steps, fixed
  domain, OSM basemap, limits shown. **Reload.** Everything should return.
- Open a **project saved before this change** — it should open on the current
  defaults (lines-only contours, viridis), not blank or broken.
- **Grid spacing is the subtle one.** Pick a spacing manually, reload, and
  confirm it is *not* silently re-auto-picked. Then change the calculation area
  size on a project where you have never touched the spacing picker, and
  confirm auto-pick still follows the area.
- Turn on *Debug: show grid cell centres*, reload — it should come back **off**.
- Drag the opacity slider back and forth, then check the save indicator: one
  save after you stop, not a stream.
- **Ctrl+Z after changing the palette must undo your last real edit**, not the
  palette. This was the trap — display changes deliberately bypass the undo
  stack.

### I4 — Selection edits stick to BESS-group members

- Select 3 units **inside** a BESS group, bulk-edit their elevation offset.
- Open the group wizard and change something structural (a gap, a count) so the
  group re-materialises. **The 3 edits must survive.**
- Nudge one of those units on the map, then bulk-edit its height. The position
  nudge must survive too — overrides merge rather than replace.
- Then use the wizard's **"change all"** to swap that model or mode. It should
  **overwrite** the manual per-unit edits — that's the locked behaviour. If the
  tuned units keep their old mode, the override clearing didn't fire.

### I2 — localStorage removed, catalog migration behind a button

- **Open every project you care about and confirm it loads.** The localStorage
  fallback is gone; projects are Firestore-only now. Ryan confirmed the
  localStorage-only projects aren't needed — note the data is still sitting in
  the browser untouched, it's just no longer read, so this is reversible if
  something turns out to have been wanted.
- Go offline / block Firestore and open a project: you should get a **red error
  toast**, not a silent empty project.
- Catalog screen: the **Local tab is gone**; Global + My library remain.
- Open a project that has a local catalog → **Project tab → "Local catalog"**
  section appears with a Migrate button. Press it, read the confirm (it tells
  you what will happen), accept. Then check: the models appear in the Global
  catalog, the project's sources still resolve, and **re-solving gives the same
  levels**. The section should vanish afterwards.
- A project with no local catalog should show no such section at all.

### I20 — Approximations are visible

- Solve a normal small project: the dock should show **nothing** new.
- Force a cap and confirm it reports:
  - **Terrain resample** — make the calculation area very large (tens of km) so
    the DEM needs more than 2048 cells per axis. Expect an amber row:
    *"Terrain resampled to N m (DEM provides 20 m)…"*
  - **Cutoff** — set Propagation cutoffs low (say 2 km) on a project with
    distant sources. Expect a grey info row.
  - **Unresolved sources** — delete a catalog entry a project uses. Expect an
    amber row saying N sources contribute nothing.
- Click the row to expand the detail; amber = can move levels, grey = bounded a
  resource only.
- Not yet instrumented: Barnes-Hut clustering, the −120 dB grid floor and wall
  densification, all of which live on the worker path. Those land with I12.

---

## 4. Not started

Eight items remain: **I5** (copy/paste), **I12** (grid progress), **I15** (PDF
export), **I7** (calc-area drag/rotation), **I10** (settings window — unblocked,
5 tabs, gear in both places), **I11** (help window), **I14** (factorial study)
and **I18** (reflections). Three pull in a new dependency: `jspdf` (I15),
`minisearch` (I11), `exceljs` (I14).

**I12 should go next** — it plumbs worker messages back to the main thread,
which is also what I20 needs to finish instrumenting the clustering and grid
caps. `Diagnostics.merge()` already exists and is tested for that.

---

## 5. RESOLVED — the I2 decision

**Answered 2026-07-31 and actioned.** Ryan confirmed localStorage-only projects
exist but aren't needed, so the fallback was deleted. The local-catalog
migration was made an explicit button rather than automatic, since Ryan
questioned why the catalog would be migrated at all — rewriting source model
references on open would have been the wrong default.

The one piece still deliberately undone: `seedCatalog.ts` stays in the bundle.
Dropping it is only safe once the global Firestore catalog is confirmed
populated in production. Check the Catalog screen shows the full model list on
a fresh profile, then it can go.

Original context follows.

Finishing I2 meant three irreversible things in production:

1. Executing the local-catalog migration (writes to the Firestore global
   catalog, rewrites project source references).
2. Deleting `lib/storage.ts` and the `useProjectDoc` localStorage fallback.
3. Dropping `seedCatalog.ts` from the bundle.

Step 2 is the dangerous one. **A project that exists only in localStorage
becomes permanently unreachable** the moment the fallback goes — the data stays
in the browser but nothing can read it. `useProjectDoc` currently reaches that
path whenever a Firestore doc is missing, so there is no way for me to tell
from the code whether anyone still has such projects.

The plan's own risk note requires **migrate → verify → delete**, so this is a
deliberate stop, not an oversight.

**What I need from you:**

- Does anyone (you, or a colleague, on any browser profile) still have projects
  that live **only** in localStorage and have never been saved to Firestore?
  - **No** → I delete the fallback and finish I2 as specified.
  - **Yes / not sure** → I build a one-click "rescue local projects to the
    cloud" step first, you run it and confirm the count, and only then does the
    fallback go.
- Separately: the local-catalog migration runs **per project on open**. Do you
  want it automatic, or behind a visible "Migrate this project's catalog"
  button so you can watch the first few before trusting it? Automatic is
  tidier; manual is safer for the first pass, and given it rewrites source
  model references on real projects I'd lean manual for the first run.

# BESSTY feature plans — eight active + one shelved

Status: **fully locked 2026-08-07** — Ryan's numbered answers to Q1–Q35 plus
the follow-ups (A: exports carry all periods; B: limit tables arrive as
wind-speed columns × receiver rows; C: order confirmed with ideas 2+3+6
bundled into one batch). Ready to build on Ryan's go. Idea 9 (auralisation)
is **shelved** — plan kept as an appendix for whenever it revives.

Grounding: plans reference the code as of `ea0d837`. Facts checked against the
source, not assumed:

- The WASM solver returns **Z-weighted per-band Lp**; A-weighting is applied
  web-side at sum time (`solver.ts aWeightedTotal`, `gridCore.ts` band fold,
  plus a deliberate local copy in `exporters.ts`). Weighting is therefore a
  **web-only** concern; the engine never changes for idea 1.
- The contour grid stores **totals only** (bands are folded at tile merge);
  switching weighting re-solves the grid (accepted, Q5).
- `CatalogModeData` = `{name, bandSystem, weighting A|Z, frequencies,
  spectra[windSpeed], windSpeeds}` — gains `powerKw` for idea 5.
- `Receiver` limits are three scalars (day/evening/night) — gain an optional
  wind-speed table for idea 5/7.
- The factorial study sweeps battery × inverter candidates, not wind speed;
  the wind sweep (idea 7) is a new runner.
- Per-source per-band Lp at each receiver already exists (contribution export
  uses `ps.perBandLp`) — the curtailment optimiser's transfer matrix is free.
- Firestore: `projects/{id}` + immutable `versions/{vid}` snapshots, rules
  in-repo, Cloud Functions already in use, email+password auth.
- `referenceLayers` (vector, styled, non-solver) exist with a shapefile
  import path — the landing zone for DXF.

Per-item gates as always: `npm run lint` + `npm test` + `npm run build`, plus
the feature-specific validation listed per plan, plus a Fable adversarial
review after each batch. Standing constraints: no `web/src/wasm/*` commits, no
Standards PDFs, push remote is `BESSTY`, no AI trailers on commits.

---

## 1. Assessment weighting (Z / A / C) + tonality at the receiver

**Locked decisions:** weighting selectable A/C/Z, A default (Q from brief).
Limits follow the active weighting (Q4). Weighting change invalidates and
re-solves the grid (Q5). Tonality is assessed **at the receiver only** (Q1),
via a **method dropdown** whose first entry is the ISO 1996-2 Annex J
simplified method — built so more methods slot in later (Q2). Penalty is a
fixed dB, **default off**, 5 dB default magnitude when enabled (Q3).

### Weighting

- `ProjectSettings.assessment?: { weighting?: 'A' | 'C' | 'Z' }`, absent = `'A'`.
- New `web/src/lib/weighting.ts` consolidating today's three A-weight tables
  into one module: `weightsFor(bandSystem, weighting)` — IEC 61672-1 A and C
  curves evaluated at band centres (C = f1/f4 pole pairs with 1 kHz
  normalisation; A adds f2/f3), Z = zeros. Unit-tested against the published
  IEC 61672-1 table values.
- Threaded through the three sum sites (point solve, grid fold, exporters);
  label sweep dB(A)→dB(C)/dB(Z) across results dock, markers, legend, PDF,
  CSV/XLSX headers, GeoTIFF description. A wiring test greps components for
  hardcoded "dB(A)" to keep the sweep honest.
- Stored limit fields keep their `limitDayDbA` names (schema compat); UI
  labels and pass/fail comparison read them in the active weighting.
- Always-on **dBC − dBA** column in receiver results/exports (LF screening
  indicator), independent of the selected weighting.

### Tonality (receiver-only)

- `assessment.tonality?: { method: 'iso1996-2-annexJ'; applyPenalty: boolean;
  penaltyDb: number }` — `method` is a union type rendered as a Settings
  dropdown with one entry for now; adding a method later is a new union
  member + implementation, no UI rework (Q2).
- Annex J simplified screen on the **received** per-band Lp at each receiver:
  a one-third-octave band is tone-flagged when it exceeds BOTH adjacent bands
  by 15 dB (25–125 Hz), 8 dB (160–400 Hz), 5 dB (≥500 Hz). Requires the
  project band system to be one-third-octave; at octave the results row shows
  "tonality not assessable at octave resolution" rather than silently passing.
- When `applyPenalty` and a receiver is flagged: penalty added to that
  receiver's assessment level before the limit comparison; the results row
  and exports show it explicitly (level, "+5 dB tonality", assessed level,
  flagged band(s)). Default state: screen runs and reports, penalty **not**
  applied (Q3).
- Contours never carry the penalty; the PDF notes when a penalty is active on
  receivers.

**Validation:** weighting module vs IEC 61672-1 values; constructed spectra
walking each threshold region; an HF-tone case that flags near the source
distance and clears far away (the reason receiver-side assessment is right);
penalty flip test on the pass/fail badge.

**Effort:** ~3–4 days. Engine untouched.

---

## 2. Custom named contour lines

**Locked decisions:** labels rendered the same way existing contour level
labels are rendered (Q6); included in KML/SHP/PDF by default with a per-line
export toggle (Q7); per-line colour, line weight, dash/solid — all user
settable (Q8).

- `DisplaySettings.customContours?: Array<{ id: string; label: string;
  levelDb: number; color: string; widthPx: number; dashed: boolean;
  export: boolean }>`.
- Layers tab "Custom lines" list: add/remove, level, name, colour swatch,
  width, dash toggle, export toggle.
- Tracing: the contour worker's marching-squares pass gains an explicit
  extra-levels list (custom levels are usually off the step grid, e.g.
  37.5 dB); traced lines return tagged with their custom-line id.
- Rendering: above regular contour lines; labelled via the existing contour
  label mechanism (same font/halo/placement rules, text = the line's name,
  optionally with the level). Custom lines render even when regular contours
  are hidden — they are compliance artefacts.
- Exports: KML + SHP features attributed `{label, level}`; PDF draws + adds
  to legend. Levels are in the active assessment weighting; legend says so.

**Validation:** synthetic cone grid → asserted line radius; KML/SHP attribute
round-trip; PDF operator-stream check for dash + label; adding a line
re-traces without re-solving.

**Effort:** ~1 day.

---

## 3. Map annotations — text with leader, plus dimension lines

**Locked decisions:** v1 = text with optional leader arrow AND dimension
lines (Q9, extended by Ryan); text black with a small white buffer; 9 pt on
PDF export; fixed screen-size on the map (Q10).

- `Project.annotations?: Array<
    | { id: string; kind: 'text'; latLng: [number, number]; text: string;
        leaderTo?: [number, number] }
    | { id: string; kind: 'dimension'; from: [number, number];
        to: [number, number] }>`.
  Project data (not display settings): annotations are deliverable content,
  shared with collaborators, undoable for free via project-state undo.
- Text: black, white halo (map divIcon text-shadow; PDF white outline behind
  the glyph run). Dimension: line between two points with end ticks and the
  geodesic distance auto-labelled ("48.3 m", one decimal), label centred and
  haloed like text annotations.
- Map controls "Annotate" mode: click to place text (popover editor; second
  click optionally sets the leader anchor); drag either endpoint of a
  dimension; Esc via the esc-stack; delete from the popover.
- PDF font (Ryan: 9 pt Arial is the house default and **appearance matters**;
  an open-source equivalent is acceptable): embed **Liberation Sans / Arimo**
  — the metric-compatible Arial substitutes (SIL OFL / Apache; PDF embedding
  explicitly permitted) — via jsPDF `addFileToVFS`/`addFont`, regular + bold,
  loaded with the PDF export chunk only (~200–400 KB, never in the main
  bundle). Applied to **all PDF text** (annotations at 9 pt, plus labels,
  legend, titles) so the whole deliverable matches house style, not just the
  annotations.
- Fixed screen-size on map (like receiver labels); absolute pt size in PDF.

**Validation:** place/edit/undo cycle; geodesic label value vs hand
calculation; PDF text + halo emission; esc-stack wiring test extension.

**Effort:** ~2 days.

---

## 4. Operating modes per day / evening / night (gated by a setting)

**Locked decisions:** explicit **Off** state (Q11 — needed by curtailment).
Only the **selected period is solved** — no always-three-periods solving
(Q12). Per-period modes are editable at every level a mode exists today
(source, wizard segment, per-unit override) with the same fallback chain
(Q13), and the whole capability sits behind a **project setting, default
OFF** — when off, no per-period UI appears anywhere (Q13).

- Setting: `ProjectSettings.periods?: { perPeriodModes: boolean }` (default
  false). Off ⇒ every mode picker is the current single dropdown; on ⇒ each
  picker gains a "per period" expander with three dropdowns (day/evening/
  night).
- Data: everywhere a mode override exists (`Source.modeOverride`,
  `BessSegment.modeOverride`, `BessUnitOverride.modeOverride`) the value
  widens from `string | null` to also allow `{ day?: string | null;
  evening?: string | null; night?: string | null }`. A plain string still
  means "all periods", so every existing document parses unchanged; the
  resolver collapses to one mode given `scenario.period`.
- **Off state:** reserved mode id `'__off'`, shown as "Off" in pickers.
  Resolves to "drop this source at scene build" for that period; map marker
  greys when the active period has it off.
- Grid fingerprint gains the resolved-mode vector, so switching period only
  invalidates the grid when some resolved mode actually differs (also
  tightens staleness detection generally).
- Exports (**A — resolved**): the receiver-totals export solves **all three
  periods at export time** and prints per-period level columns
  (level_day/evening/night, each with its pass/fail), while the screen keeps
  showing only the selected period. When per-period modes are off (or no
  resolved mode differs) the three solves collapse to one and the columns
  repeat today's single value — identical semantics to the current export.
  Contribution and spectra exports stay active-period, labelled with which
  period they represent (they're diagnostic detail, and tripling them bloats
  the workbook).

**Validation:** resolver unit tests (string form, object form, fallback chain
segment → unit → source → catalog default); `__off` drop test; fingerprint
invalidation only on real mode differences; wizard chips show per-period
badges ("D/E/N: NRO0 / NRO2 / Off").

**Known limitation as built (2026-08-07):** `__off` drops the source AND its
container from the scene, so a parked BESS stops screening its neighbours even
though the box is physically still standing. This errs loud (less screening ⇒
higher levels). Fixing it properly needs a screens-only source in the engine —
a `SceneSourceInput` that emits its `Building` obstacle but no sound power —
which is solver-side work, not a web change. Irrelevant to WTGs (no container),
so it does not block idea 5.

**Effort:** ~2–3 days.

---

## 5. Wind-farm curtailment optimiser — global optimum

**Locked decisions:** power per mode per wind speed exists in datasheets and
is the data model (Q14). Wind-speed-dependent limits become a per-receiver
**grid (period × integer wind speed)**, gated by a setting (default off),
with Excel paste and import-to-all-receivers (Q15). Objective: minimise
electrical generation reduction at each integer wind speed independently
(8 m/s means the 7.5–8.5 bin) (Q16). **Global optimum required** (Q17).
Optimise **all periods**, not just night (Q18). Deliverable: turbine ×
wind-speed mode schedule (XLSX) + "apply this wind speed's modes to the
project" (Q19).

### Data model

- `CatalogModeData.powerKw?: Record<string, number>` — keyed by stringified
  wind speed exactly as `spectra` is; catalog editor gains a power row under
  the spectrum grid (same Excel paste path). Turbines missing power data are
  named in a refusal message rather than silently skipped.
- Setting `ProjectSettings.compliance?: { windSpeedLimits: boolean }`
  (default false). When on, each receiver gains
  `limitTable?: { windSpeeds: number[]; limits: { day: number[];
  evening: number[]; night: number[] } }` — a grid editor (rows = periods,
  columns = integer wind speeds) with 2-D Excel paste and "apply this table
  to all receivers". Fallback: the existing scalar limits when the setting is
  off or a receiver has no table. Active limit lookup =
  `table[period][round(windSpeed)]`.
- Bulk import (**B — resolved**: tables arrive as **wind-speed columns ×
  receiver rows**): XLSX/CSV with a header row of integer wind speeds and the
  first column holding receiver names; one worksheet per period (sheet names
  Day/Evening/Night; a single-sheet file prompts for which period it covers).
  The same block shape pastes directly into the bulk dialog. Receiver
  matching by name — exact then case-insensitive/trimmed; unmatched rows are
  listed for manual mapping and receivers absent from the file are reported,
  never silently left on stale limits.

### Optimiser — exact, via MILP

The per-band transfer function `T[t][r][band] = Lp_band − Lw_band` for
turbine t at receiver r depends only on geometry/ground/atmosphere/barriers —
not on mode or wind speed. One ordinary solve (WTGs are never clustered;
point receivers are exact) yields the entire matrix from the existing
per-source per-band contributions. Every candidate assignment is then pure
arithmetic — and, crucially, **linear in energy**:

- Decision variables: binary `x[t][m]` (turbine t runs mode m; includes
  `__off`). `Σ_m x[t][m] = 1` per turbine.
- Receiver constraints, per (wind speed, period):
  `Σ_t Σ_m x[t][m] · E[t][r][m] ≤ Ecap[r]`, where
  `E[t][r][m] = Σ_b 10^((Lw[m,ws,b] + T[t][r][b] + W[b])/10)` and
  `Ecap[r] = 10^(limit(r,period,ws)/10)` — honouring the project's
  `limitComparison` setting (`integer` ⇒ cap at limit + 0.5 exclusive,
  `exact` ⇒ at the limit).
- Objective: minimise `Σ x[t][m] · (Pmax[t](ws) − P[m](ws))` — lost kW.
  `__off` loses full power and contributes zero energy.

Each (wind speed, period) cell is an independent MILP of |turbines|·|modes|
binaries and |receivers| constraints — small by MILP standards; a branch-and-
bound solver finds the **provable global optimum** in well under a second per
cell for realistic farms (tens of turbines, ≤8 modes, dozens of receivers).
Solver: **HiGHS via the `highs` wasm package (MIT licence)**, lazy-loaded
only when the optimiser runs so the main bundle doesn't grow. Infeasible
cells (all-off still exceeding) report the residual exceedance and the
controlling receiver honestly.

Greedy is gone from the plan: with linearity + MILP we get the global
optimum Ryan asked for, with an optimality certificate from the solver
rather than a heuristic disclaimer.

### UX and deliverables

- "Curtailment" study window (FloatingWindow): wind speeds (default: catalog
  coverage), periods (default all three), optional margin (limit − X dB,
  default 0); Run shows a live table turbine × wind speed per period with
  mode chips, per-cell kW loss, binding receiver, status optimal/infeasible.
- XLSX export: one sheet per period — turbine rows × wind-speed columns with
  mode cells, kW-loss summary row, binding-receiver row, plus a settings
  snapshot sheet.
- "Apply modes for ws = X": writes the schedule's modes into the per-period
  mode overrides (idea 4), so the project can be inspected/reported in the
  curtailed state.

**Validation:** brute-force enumeration cross-check on small farms (3
turbines × 3 modes — MILP answer must equal exhaustive optimum exactly);
transfer-matrix reconstruction vs a direct solve at 0.01 dB; limit-rounding
semantics under both comparison modes; infeasibility reporting; `__off`
power accounting.

**Effort:** ~5–7 days (limit grid + paste/import, power curves in catalog,
MILP integration, window, exports, validation). Engine untouched.

**Depends on:** idea 4 (Off state + per-period mode overrides for Apply).

---

## 6. DXF import (just-in-case feature — best-guess defaults)

Ryan: "we don't really deal with DXFs — make your best guess" (Q20–22);
size bound 50 MB (Q23). Best-guess scope, kept deliberately v1-simple:

- Parser: `dxf-parser` (MIT, ASCII DXF) in a worker; binary DXF rejected
  with a "save as ASCII DXF" message. Engineered for 50 MB (streamed into
  the worker, progress bar, no main-thread stalls).
- Entities: LINE, LWPOLYLINE, POLYLINE, ARC/CIRCLE (tessellated ~0.5 m chord
  error), INSERT expanded one level, TEXT/MTEXT as reference labels.
  Everything else skipped with a per-type count in the import summary.
- Units: trust `$INSUNITS` but confirm in a dialog showing the drawing
  extent in metres under each candidate interpretation (mm-vs-m is the
  classic failure).
- CRS: existing `EpsgPicker` (MGA the expected case) + on-map preview before
  commit. No two-point manual placement in v1 (noted as future work for
  local-grid drawings).
- Mapping UI: DXF **layers** listed with feature counts; each maps to
  Reference layer (default) / Barriers (height prompt per layer, absorption
  default) / Skip. Blocks import as reference geometry only in v1 — not
  sources. If polyline vertices carry Z: offer "Z = wall top level
  (absolute, converted to height-above-ground via the DEM)" vs "ignore Z,
  prompt height".
- Whole import lands as one undoable mutation with a summary.

**Validation:** golden minimal DXF per entity type; units-misread guard;
block transform (rotation + scale); 50 MB synthetic file through the worker
without a main-thread stall.

**Effort:** ~3–4 days at this scope.

---

## 7. Wind-speed sweep exports

**Locked decisions:** receivers and grids are **each optional** — contours
only, receivers only, or both (Q24). The combined shapefile uses the
**on-screen contour level set** (the display levels), not just custom lines
(Q25). XLSX layout as proposed is sufficient (Q26).

- "Wind sweep" runner (Export menu + config dialog): wind speeds (default:
  the integer speeds the catalog defines), period(s), and two checkboxes —
  solve receivers / solve grids (either or both; grids warn that N wind
  speeds = N full grid solves).
- Execution: sequential over wind speeds on the worker pool's study lane
  (doesn't fight live edits), progress + cancel; results held for export.
- **XLSX** (when receivers ran): sheet per period; receiver rows ×
  wind-speed columns; pass/fail conditional formatting against the active
  limit (scalar or idea-5 limit table); limit, worst-wind-speed and margin
  columns; settings snapshot sheet.
- **SHP** (when grids ran): one zip, polyline features attributed
  `{windSpeed, levelDb, period}` at the current display contour levels;
  custom lines (idea 2) ride along when their export flag is on. KML
  sibling, one folder per wind speed. Optional GeoTIFF zip
  (`grid_ws08.tif`, …).

**Validation:** sweep vs individually-run solves (bit-identical); XLSX
structure; SHP attribute round-trip; cancel mid-sweep leaves no stale state;
receivers-only and grids-only configs both export correctly.

**Effort:** ~2–3 days. Benefits from idea 5's limit tables; consumes idea
2's export flags.

---

## 8. Read-only share links

**Locked decisions:** visible to the client: contours, receivers with
limits, source positions, noise walls, **model/mode names and source
levels/spectra**; never emails, UIDs, contributions, DEM, collaborator
lists (Q27). Fully public capability URL, unguessable token (Q28). Expiry:
default + **user-settable**, plus a revocation UI (Q29). Strictly view-only
(Q30). Frozen snapshot, republish to update — **but the viewer can switch
time of day and wind speed among the states embedded at publish time**
(Q31). Creation via a Cloud Function with a server-side field allowlist
(Q32).

- **Token + storage:** `shares/{token}`, token ≥190 bits from
  `crypto.getRandomValues` (32 base62 chars). Doc: `{ownerUid, createdAt,
  expiresAt (user-set, default 90 d), revoked, label, draftOrFinal,
  payload}`; payload overflows to Storage `shares/{token}/…` when it won't
  fit Firestore's 1 MB cap.
- **Multi-state snapshots (the Q31 consequence):** "no calculation in the
  viewer" + "switch period / wind speed" ⇒ the publish step embeds
  **precomputed states**. The publish dialog lists what has been computed in
  the session (base grid + receiver results per period; sweep results per
  wind speed if idea 7 ran) with a size estimate, and the publisher ticks
  which states to include. The viewer's period/wind-speed dropdowns just
  swap embedded display data. States not embedded aren't offered. A 10-ws ×
  3-period full-grid share is ~5 MB of rasters → automatic Storage overflow
  path.
- **Payload allowlist (Cloud Function):** the function builds the payload
  from an explicit field allowlist — never strip-listing a project (a new
  field defaulting to "shared" is how leaks happen). Allowed: contour
  polylines + rasters + styling, custom lines, receivers (name, position,
  height, limits incl. limit tables, levels, badges), sources (position,
  kind, model display name, active mode name(s), per-band Lw of the modes
  used), barriers (geometry, height, absorption), basemap prefs, annotations,
  project label, publish date. Everything else absent by construction.
- **Rules:** `shares` allows single-doc `get` when
  `!revoked && expiresAt > request.time`; **`list` denied absolutely**
  (enumeration impossible); create/update/delete only via the function
  (admin SDK) / owning editor. Storage rules mirror the path. New dev dep
  `@firebase/rules-unit-testing` with an emulator suite: deny list, deny
  expired, deny revoked, deny cross-path, deny tamper.
- **Viewer:** public route `/share/:token` skipping the auth gate; stripped
  read-only MapView (no side panel, no editing, no solver); period /
  wind-speed dropdowns over embedded states; watermark strip (label,
  "Prepared by Resonate Consultants", publish date, DRAFT/FINAL); meta
  noindex, `Referrer-Policy: no-referrer`.
- **Management UI:** Share dialog on the project — create (label, expiry
  picker defaulting 90 days, draft/final), list links with
  created/expiry/last-access, copy, revoke (flag flip + Storage cleanup).
- **Audit before ship (non-negotiable):** emulator suite green; Fable
  adversarial review aimed at rules + function + viewer; manual checklist
  (token entropy, token never logged/analytics'd, robots, Storage list
  disabled, App Check evaluation, allowlist reviewed field-by-field against
  Q27).

**Validation:** emulator suite; end-to-end publish → unauthenticated fetch →
forbidden-field absence assertion; expiry clock test; multi-state switch
renders the right embedded grid.

**Effort:** ~5–7 days including the audit and multi-state publishing.

---

## Build order (confirmed by Ryan, with 2+3+6 bundled)

Ryan's adjustment to the proposed order: ideas 2, 3 and 6 are "kind of
similar and smaller bits of work" — one map-and-drawing batch. Otherwise as
proposed. Fable adversarial review lands at the end of every batch.

1. **Batch 1 — map & drawing toolkit** (~6–7 d): idea 2 custom contour
   lines, idea 3 annotations + dimension lines (incl. the Liberation
   Sans/Arimo PDF font embedding), idea 6 DXF import.
2. **Batch 2** (~3–4 d): idea 1 — weighting + tonality.
3. **Batch 3** (~2–3 d): idea 4 — per-period modes + Off (prerequisite
   for 5; includes the all-periods export from decision A).
4. **Batch 4** (~5–7 d): idea 5 — limit grids + curtailment optimiser.
5. **Batch 5** (~2–3 d): idea 7 — wind sweep exports.
6. **Batch 6** (~5–7 d): idea 8 — share links, last so its security-audit
   window is clean and it can embed sweep states from 7.

---

## Decision log — follow-ups

- **A (idea 4, resolved 2026-08-07).** Exports include all three periods
  (solved at export time); the screen shows only the selected period.
- **B (idea 5, resolved 2026-08-07).** Limit tables arrive as wind-speed
  columns × receiver rows; import/paste formats built to that shape, one
  block/sheet per period.
- **C (resolved 2026-08-07).** Order confirmed with ideas 2+3+6 bundled as
  Batch 1.
- **Font (idea 3, resolved 2026-08-07).** 9 pt Arial is the house default
  and appearance matters; an open-source metric-compatible equivalent
  (Liberation Sans / Arimo) is acceptable and will be embedded across the
  entire PDF export.

---

## Appendix — idea 9, auralisation (SHELVED)

Ryan 2026-08-07: back burner; substantial extra work, value unclear. Plan
retained in brief for a future revival: offline-rendered shaped noise
(random-phase IFFT to the received 1/3-octave envelope) or spectrum-matched
filtering of real recordings; tones injected where the idea-1 receiver
screen flags them; blade-pass AM for WTGs; relative calibration first (all
renders share one digital reference so A/B comparisons are exact even when
absolute playback level isn't); receiver-popover player + WAV export with
provenance + fixed disclaimer wording. Effort was estimated ~3–5 days.

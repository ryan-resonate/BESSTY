# Review-fix implementation plan (2026-07-09)

Implementation plan for the confirmed findings of the multi-agent code review
(8 reviewers + adversarial verification; 32 confirmed / 1 rejected). Full
finding records — including `detail` and `failure_scenario` for every item —
live in **`docs/review-2026-07-09-findings.json`** (`confirmed[i]` indices are
referenced below as **[i]**). Where a fix sketch below is terse, read the
finding's `detail` field first.

## Ground rules (non-negotiable)

1. **The conformance gate cannot weaken.** After every phase:
   `cargo test -p iso9613-core --test conformance_tr17534` — all 19 cases at
   the existing tolerances (±0.05 totals). Never edit a TR reference value.
2. Full gate per phase: `cargo test --workspace` green,
   `cargo test -p iso9613-core --features parallel` green,
   `cargo clippy --workspace --all-targets --features parallel` clean,
   `cd crates/iso9613-py && cargo build && cargo clippy` clean.
3. **Golden / case expected values** may be regenerated ONLY when a fix
   intentionally changes physics, and only from an independent oracle
   (scratchpad `oracle.py` pattern) — never by copying the new Rust output.
   Record the justification in the commit message.
4. One commit per lettered item (or tightly-coupled group). No AI trailers.
5. New validation errors: extend `SceneError` with precise variants +
   `Display` text; never repurpose an existing variant's meaning
   (see info note: extended-source vertex-count errors currently masquerade
   as `BadLwLength` — fix that here too).
6. Licensed ISO PDFs stay out of git. Standards text extractions for
   cross-checking are in the session scratchpad (`iso1996.txt`, `iso2024.txt`,
   `tr17534.txt`).

---

## Phase A — Criticals (wrong numbers / panics / corruption)

### A1. Gate `project_solid_edges` crossings to the S→R span — [0]
`crates/iso9613-core/src/iso9613/barrier/path.rs:734`
A `Solid` behind the source or beyond the receiver emits over-top candidates
with `along < 0` or `along > dp`, breaking `upper_hull_select`'s monotone-x
precondition and fabricating up to ~25 dB of phantom screening (classic
façade-receiver geometry: building right behind the receiver).
**Fix:** in `project_solid_edges`, after computing `along`, `continue` unless
`(-1e-9..=dp + 1e-9).contains(&along)` — mirroring `project_walls`' `t∈[0,1]`
gate. **Do the same in `lateral_plane_hull`** for the in-plane `s` coordinate
(supports with `s` outside `[0, L]` are behind/beyond the anchors and equally
invalid for the taut string).
**Tests:** new cases in `case_20_solid_and_pitched.rs`:
(a) Solid box wholly beyond R and (b) wholly behind S, both straddling the
S–R plan line → `Abar == 0` exactly (level equals the no-obstacle scene);
(c) existing tests unchanged.
**Risk:** none to conformance (TR solids sit between S and R).

### A2. Validate `Terrain::Heightfield` — [1]
`crates/iso9613-core/src/iso9613/terrain.rs:31`, validation in
`crates/iso9613-core/src/scene/mod.rs::validate` (~line 477).
`heights.len() != nx*ny` panics OOB inside `solve()` from plain JSON;
NaN heights propagate silently.
**Fix:** `validate()` gains a terrain arm: reject
`heights.len() != nx * ny`, `nx == 0 || ny == 0`, non-finite/`<= 0.0`
`spacing`, non-finite `origin`, any non-finite height. New
`SceneError::DegenerateTerrain { reason: &'static str }`.
**Tests:** unit tests in scene mod: short-heights JSON → `Err(DegenerateTerrain)`
via `solve_json`; NaN height rejected; valid heightfield still solves.

### A3. Make `Session` mutators transactional — [2], [12]
`crates/iso9613-core/src/scene/mod.rs:1294-1337`
Mutators commit to `self.scene` before `validate()`; a rejected edit leaves an
invalid scene + stale `BandSystem`/decomposition, and the next `solve()` can
panic (BandSpectrum `from_iter` length assert).
**Fix:** uniform pattern — apply the edit to a **clone**, validate the clone,
then swap: `set_receivers`, `set_source_lw`, `set_obstacles`, `update`.
For cheap fields avoid full clones where easy (e.g. `set_receivers` can
validate the new receivers stand-alone, then swap), but correctness first:
a full `Scene` clone per interactive edit is acceptable.
`set_atmosphere` → returns `Result`, validates (see C1 range rules) before
committing.
**Tests:** new `session_mutators.rs` test file:
(a) each mutator round-trips against a fresh one-shot `solve` (bit-equal);
(b) a rejected edit (wrong lw length; NaN receiver; bad obstacle) returns
`Err` AND leaves the session solving identically to before the attempt;
(c) `update` closure that corrupts then errors → session unchanged.

### A4. Fix `Obstacle::hip` ridge inset (confirmed by direct code reading;
fell out of dedup before verification)
`crates/iso9613-core/src/scene/mod.rs::ridged` (~line 218)
`hip()` passes `half_w = 0.5·|c1−c0|` — the **ridge-parallel side length** —
as the inset, instead of half the **end width** `0.5·|c0−c3|`. Any non-square
footprint clamps to `0.49·axis_len` → degenerate near-pyramid.
**Fix:** `let half_w = 0.5 * ((c[0][0]-c[3][0]).hypot(c[0][1]-c[3][1]));`
(width of the end edge c3→c0, perpendicular to the ridge axis).
**Tests:** extend `case_20`: hip over a 20×10 footprint → ridge endpoints at
the expected inset (5 m from each end midpoint, i.e. ridge length 10);
hip == gable when inset would be 0-width; hip screens ≥ gable of same
eaves/ridge for an end-on path (ridge shorter → less high crest → assert
bracketing versus flat roofs still holds).

---

## Phase B — Majors: physics correctness

### B1. Spatially scope the lateral cluster; pool solids too — [4], [15]
`crates/iso9613-core/src/iso9613/barrier/path.rs:197` (dispatch),
`scene/mod.rs::barriers` (~line 655).
Two confirmed defects, one redesign:
(a) every convex footprint in the scene joins ONE hull — an off-corridor
building evicts the real screening building's lateral (energy under-counted);
(b) `Solid`s are never pooled — rows of gabled houses don't share a taut
string (leak over-counted).
**Fix (design):** pool per *screening group*: an obstacle joins the cluster
for a given S→R pair **only if its plan outline intersects the open S–R plan
segment** (it actually blocks the direct ray — reuse the `project_walls`
crossing test on its footprint edges / solid plan silhouette). Pool the
**edges** of all blocking convex footprints AND blocking convex `Solid`s into
one `lateral_plane_hull` call (footprints already synthesize roof+post edges —
build the same list; solids pass their wireframes). Non-blocking obstacles
contribute nothing (they don't screen; their own `Abar` is 0). Concave
footprints keep the visibility-graph path (unchanged). With A1's `s∈[0,L]`
support gate this kills both failure modes.
**Tests:** T11/T13/T14/T16/T17/T18 unchanged (the TR buildings all block);
new: T11 scene + an extra 10 m box far off to the side → bands identical to
T11 alone; two touching Solid boxes == the equivalent two-Building cluster;
Solid box + Building box adjacent == two-Building cluster (bit-equal).
**Risk:** highest-touch change of the plan. Do it AFTER A1 (shares the gate).
If T16/T17 shift at all, stop and re-derive — they must not.

### B2. Simplified-method `hm = F/d` denominator — [5]
`crates/iso9613-core/src/iso9613/terrain.rs:78`
`mean_height` divides the profile area by the 3-D slant distance; Eq 14/Fig 5
(and 1996 Fig 3) use the ground-projected base-point distance.
**Fix:** divide by `dp` (plan distance), guard `dp < 1e-9`. Verify the flat
heightfield then reproduces `hm_flat = (hs+hr)/2` exactly — add that as a
property test.
**Risk:** T07 uses this path (hm≈4.99 today). Expected shift ≈ 0.2%
(dp=194.16 vs d3=194.60) → ≪ 0.05 dB. T07 must stay green unmodified; if it
does not, check the 1996 vs 2024 wording split before touching anything —
edition-dependent behaviour would go in `EditionSpec`, not a test edit.

### B3. Higher-order Fresnel incidence per bounce — [6]
`crates/iso9613-core/src/iso9613/reflection.rs:138`
The Fresnel size gate for chain reflections uses the ORIGINAL source's
incidence for every bounce. Read `confirmed[6].detail` for the verifier's
trace. **Fix:** evaluate each bounce's gate with the incoming leg = previous
bounce point (or image thereof), outgoing leg = next bounce/receiver.
**Tests:** `case_16` (parallel walls) must stay green — it is oracle-derived;
if the fix shifts it, recompute the oracle (scratchpad python) with the
corrected per-bounce angles and regenerate WITH justification. Add a case
where bounce-2 incidence is oblique enough that the old code wrongly
accepts/rejects (assert against a hand-computed gate).

### B4. Divergence: coincident source/receiver — [3], [21], [27]
`crates/iso9613-core/src/iso9613/divergence.rs:16`, `scene/mod.rs::validate`.
`d = 0` → `Adiv = −∞` → `Lp = +∞` → JSON `null`s and `total_dba: None`.
**Fix (two layers):** (1) `validate()` rejects a receiver within `1e-6` m of
any point source (`SceneError::CoincidentSourceReceiver { source_id,
receiver_id }`). (2) `adiv` floors distance at `1e-3` m — extended-source
SUB-sources can legitimately sit arbitrarily close to a receiver (receiver
inside an area source) and must stay finite, not error.
**Tests:** coincident point source rejected; receiver 0.5 m inside an area
source solves finite; `adiv(d=0)` returns the floored finite value.

### B5. Reflection scope: extended sources + non-General kinds — [7], [8]
`crates/iso9613-core/src/scene/mod.rs:1128, 1147`
Extended sub-sources and ChimneyStack/WTG point sources get NO reflection
paths; `ExtendedSource.kind` is serialized but never read.
**Fix (scope decision, do smallest honest thing):**
(a) `validate()` rejects `ExtendedSource.kind != General` with a clear
"not yet implemented" error (stop silently mis-evaluating);
(b) run first-order (and chain) reflection loops for extended sub-sources —
it is the same code path with the sub-source position/LW; keep higher-order
optional if runtime balloons (document);
(c) ChimneyStack: include reflections, recomputing `Dc` for the image-path
emission angle (direction-dependent); WTG stays excluded (Annex D regime),
documented on `SourceKind::WindTurbine`.
**Tests:** area source beside a façade gains the expected +Δ vs no-reflector
(hand oracle, first order); chimney + reflector uses per-path Dc (assert the
image path's Dc differs from the direct's when geometry says so).

### B6. Reflected paths: screening by terrain/buildings — [14]
`crates/iso9613-core/src/scene/mod.rs:995`
Image-source legs are screened by thin walls only — never terrain ridges,
footprints, or solids → reflected energy over-predicted.
**Fix:** pass the full obstacle set to the image `GeneralEval`:
`footprints`/`solids` as-is (they're position-independent), and terrain
edges recomputed for the image→receiver profile
(`terrain.profile_edges(image_pos, receiver)` — per image, cached per
reflector×receiver if hot).
**Risk:** T19 (terrain + reflecting barrier) currently passes WITHOUT this;
adding terrain to its reflected leg may shift the reflected band values.
Hand-check first: in T19 the reflected ray's profile is flat (verify against
Table 66 geometry in the TR text) — expected no change. T19 must stay green;
if the TR's own construction omits terrain on the reflected leg, follow the
TR (document the choice inline) rather than "improving" past the reference.

### B7. `select_lateral`: only screening walls' ends compete — [13]
`crates/iso9613-core/src/iso9613/barrier/path.rs:876`
Global best-per-side across ALL wall ends lets a non-screening wall's end
supplant the screening wall's real lateral.
**Fix:** associate each `LateralEdge` with its parent wall (add a
`wall_index` field or emit lateral edges grouped per wall in `barriers()`),
and in `build_geometry` consider only edges whose parent wall crosses the
S–R plan segment (same blocking test as B1). Best-per-side among those.
**Risk:** T08/T09/T10 all have single walls that DO block → unchanged. The
T09 far-end edge (37 m off-path, Dz=20 dB) belongs to the blocking wall and
must survive — assert. Golden S4 uses one wall + its own ends → unchanged;
if any golden byte shifts, stop and re-derive.
**Tests:** two-wall scene (one blocking, one parallel offset non-blocking):
laterals identical to the blocking-wall-only scene.

### B8. Cap and hoist reflection sequence enumeration — [11], [16]
`crates/iso9613-core/src/scene/mod.rs:666, 1026`
Unbounded `max_reflection_order` (u32) drives `m·(m−1)^(k−1)` materialised
sequences, rebuilt per source×receiver → DoS from JSON; quadratic waste.
**Fix:** `validate()` rejects `max_reflection_order > 4`
(`SceneError::ReflectionOrderTooHigh`); additionally hard-cap the total
sequence count (e.g. 20 000 — return a validation error naming both knobs,
computed from `m` and order, BEFORE enumerating). Hoist
`reflection_sequences` to once per `solve_cached` (it depends only on
`(m, max_order)`), pass `&[Vec<usize>]` down.
**Tests:** order=5 rejected; 50 reflectors × order 4 rejected by the count
cap with a clear message; results bit-identical pre/post hoist for case_16.

---

## Phase C — Validation sweep (one commit)

### C1. Complete `Scene::validate()` — [9], [10], [19], [24], [25], [28], + A2
All in `crates/iso9613-core/src/scene/mod.rs::validate`.
Add, with tests each (valid passes / invalid errors with the right variant):
- **Atmosphere:** finite AND physical — `temperature_c > −273.15`,
  `pressure_kpa > 0`, `0 ≤ relative_humidity_pct ≤ 100`. Used by
  `Session::set_atmosphere` (A3).
- **Reflectors & cylinders:** finite geometry; `0 ≤ alpha ≤ 1`;
  `alpha_bands` (when present) length == band count and every entry in [0,1];
  cylinder `radius > 0`, `top_z > base_z`.
- **Ground regions:** finite polygon vertices; `0 ≤ g ≤ 1`; ≥ 3 vertices.
- **Amisc regions:** finite polygons; densities/percentages in range.
- **Footprints:** reject self-intersecting (O(n²) segment test — n is tiny)
  and zero-area/collinear footprints (`DegenerateBuilding`).
- **Solids:** zero-length edges rejected; (already: index bounds, ≥3 verts).
- **SourceKind payloads:** `rotor_diameter_m > 0`, `opening_radius_m > 0`,
  finite.
- **Settings:** `dz_cap_db` finite and `≥ 0` (interacts with C2);
  `max_reflection_order` cap (B8).
- **Error-message hygiene:** extended-source vertex-count failures get their
  own variant (currently mis-reported as `BadLwLength`).

### C2. Bound the `dz_cap_db` override in `cap()` — [20]
`crates/iso9613-core/src/iso9613/barrier/diffraction.rs:118`
Negative override → negative (amplifying) Abar; huge override silently
defeats the ISO 20/25 dB cap. **Fix:** with C1 rejecting non-finite/negative,
ALSO clamp in `cap()` to `[0, standard_cap]` (defence in depth — evaluate
whether values above the ISO cap should be allowed intentionally; if yes,
document; if no, clamp). Test both layers.

---

## Phase D — Minors & hygiene (batch by file)

- **D1 [17]** `crates/iso9613-py/src/lib.rs:34` — wrap solves in
  `py.allow_threads(...)` (parse JSON first, own the `String`). Applies to
  `solve`, `solve_parallel`, `Session::solve`. Test: none practical in CI —
  verify it builds + clippy clean.
- **D2 [26]** `crates/iso9613-wasm/src/lib.rs:45, 316` — replace
  `panic!`/unchecked indexing (`band_system_for`, `eval_cell_dba`
  `topo_offsets`/`topo_barriers`) with JS-visible errors
  (`Result<_, JsValue>`) / defensive bounds checks. **Scope note:** shim code
  only — no BEESTY edits, no packaging work; behaviour for valid inputs must
  be byte-identical (golden shim tests if present).
- **D3 [23]** `annex_b.rs:47` — interpolate `Dc` in **ln(ka)** per Formula
  B.4 (read `confirmed[23].detail`). Regenerate `case_18` expectations from
  a corrected oracle if values shift; justify in commit.
- **D4 [22]** `reflection.rs:313` — `fresnel_valid` vertical foreshortening:
  use Eq 27's α_h (incidence projected onto the vertical plane ⟂ facade),
  not ray elevation. T19 + case_12 must stay green (recheck the 250 Hz
  boundary band noted in the T19 test comments — it may legitimately flip;
  the TOTAL must not move beyond tolerance).
- **D5 [18]** `path.rs:531` — `polygon_interior_point` failure: fall back to
  offsetting inward from the longest edge midpoint (normal side chosen by
  point-in-polygon), before giving up; if still none, treat the footprint as
  convex hull (never silently drop laterals). Unit test with a sliver
  polygon.
- **D6 [29]** — Cmet end-to-end test: two scenes differing only in
  `c0_db`, `dp > 10(hs+hr)`, assert the band-flat delta equals
  `cmet_db(...)` for a point AND an extended source.
- **D7 [30]** — extend `case_20`: Solid box == Building with receiver ABOVE
  the roof (T12 geometry); mixed Solid+Building cluster sanity (folds into
  B1's tests).
- **D8 [31] + info notes** — comment/docs sweep: delete stale "PENDING T12"
  block (conformance_tr17534.rs:472-475); fix `lateral_path_lengths` doc
  (Δz ≥ 0 by triangle inequality, path.rs:98); T16 comment cites wrong TR
  table (conformance_tr17534.rs:368); document ChimneyStack `ka` using
  ambient vs mouth temperature (scene/mod.rs:937 — consider an optional
  `mouth_temperature_c` field as a follow-up, document for now); document
  WTG ignoring ground regions (scene/mod.rs:924) — or fix by passing
  region factors (small; prefer the fix if Annex D eval accepts per-region G
  cleanly); add `#[serde(default)]` to remaining Scene/Settings fields for
  schema leniency (mod.rs:260) — verify old fixtures still parse.

---

## Phase E — Flagged in review but NOT verified (investigate before fixing)

These surfaced in reviewer output that fell out of the final deduped set
(duplicate journal rows from the interrupted run). Treat each as a
hypothesis: reproduce first, then fix with a test, else record as refuted.

- **E1** `region_ground_factors` (scene/mod.rs ~825): with
  `height_agl == 0` the source/receiver region has zero extent and returns
  `default_g` instead of the ground at the endpoint. Repro: G-regions with a
  0-height source over g=1 region, default 0. Fix: sample `g_at(endpoint)`
  when the region length is ~0.
- **E2** `Ahous` vs Annex A.4 interplay (scene/mod.rs ~769): A.4 says
  Agr,b = 0 within built-up region / drop Ahous if Agr,0 > Ahous. Read A.4 in
  the 2024 text and implement with a case test.
- **E3** `extent.rs::subdivide_area` (~99): grid sized from distance to the
  nearest polygon VERTEX — a receiver near an edge midpoint / over the
  interior violates the k=0.5 criterion. Repro with a large area source and
  close receiver vs a brute-force fine subdivision; fix the distance metric
  (distance to the polygon, not to vertices).
- **E4** WTG sources ignore terrain screening + per-region G + footprints
  (scene/mod.rs ~924): decide intended scope with Annex D, then either pass
  the geometry (preferred) or document loudly on `SourceKind::WindTurbine`.

---

## Sequencing & verification protocol

Order: **A1 → A2 → A3 → A4 → B1 → B4 → B8 → C1+C2 → B2 → B3 → B5 → B6 →
B7 → D1..D8 → E1..E4.** (A-first: small, independent, de-risk everything
else; B1 before B7 because they share the "blocking obstacle" predicate —
factor it once.)

After EVERY item: the Phase-0 gate (workspace + parallel + conformance +
clippy + py). After B-phase items that can move physics (B1–B7): also diff
the full conformance band output (print bands, not just pass/fail) against
the pre-change run and account for every changed digit in the commit
message. Finish with one clean-tree full run and a README/docs refresh if
behaviour notes changed (reflections scope, WTG docs, validation list).

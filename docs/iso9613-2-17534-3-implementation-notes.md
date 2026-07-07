# ISO/TR 17534-3:2015 — QA implementation recommendations for the 1996 mode

**Why this doc exists.** ISO 9613‑2:1996 leaves several corners under‑specified. ISO/TR 17534‑3:2015
("Recommendations for quality assured implementation of ISO 9613‑2") pins those choices down so
independent software produces the **same** numbers, and its §6 test cases assume an implementation
that follows them. Therefore, in this project:

> **1996 mode = ISO 9613‑2:1996 text *as constrained by* ISO/TR 17534‑3:2015 §5.**

Implement to these recommendations from the start of the 1996 work (Phase 2) — they are *interpretation
requirements*, distinct from the §6 numeric test cases (which we treat as the acceptance oracle,
own‑cases‑first; see the plan §5).

Source: ISO/TR 17534‑3:2015 (canonical copies of all standards: **`T:\Literature\Standards\ISO`**,
available to all Resonate staff; the local `Standards/` working copy is `.gitignore`d — single‑user
licence, never commit).

**Big picture.** The §5 recommendations are, to a large extent, precisely the changes later
incorporated into **ISO 9613‑2:2024**. So applying 17534‑3 to the 1996 mode makes 1996 and 2024
**agree** on many mechanisms (path construction, lateral diffraction, caps, higher‑order reflections),
which means that code is **shared**, and the genuine edition switch narrows to a short list (§3 below).

## 1. Classification key (17534‑3 §5.1)

- **A** — agreed solution for a problem *incompletely or not addressed* in 1996.
- **B** — *better/consistent* solution for a problem inconsistently or unsatisfactorily treated in 1996.
- **C** — *common interpretation* of unclear 1996 content.

## 2. The recommendations (§5.2 – §5.9)

### 5.2 Screening — ray construction  [A, B]
- **Issue:** 1996 Eq (16)/(17) compute `z` using the parallel component `a`, but this **fails for
  double diffraction with non‑parallel edges** (no single `a` is definable), and the "two most
  effective barriers" reduction doesn't generalise beyond two edges.
- **Recommendation:** construct rays as a **rubber‑band polyline in two perpendicular planes** — the
  vertical plane `EV` (over‑top) and the lateral plane `EL` (around vertical edges), both containing
  source and receiver. This is equivalent to Eq (16) for the single‑diffraction / right‑angle case
  but **generalises to any number and orientation of edges**. Up to **three** contributions: one
  over‑top + two lateral. `e` = sum of segments between the first and last active edge.
- **Impl:** use the vertical‑plane rubber‑band `z = (dss+dsr+e) − d` as the general method (this is the
  2024 §7.4.1 construction) — **not** the raw 1996 `a`‑term formula. → **Shared with 2024.** Our
  current path code already builds this.
- **Lateral path selection rules** (same clause): at most **three** contributions — over‑top + **two**
  lateral (one per side; with several candidate edges per side take the most‑transmitting, i.e.
  lowest‑`Dz`, path per side — in most cases the shortest). The TR notes zig‑zag/multi‑object lateral
  paths are ambiguous and defers a general strategy ("a common strategy will be developed") — document
  our choice (shortest polygon per side). **Factor‑8 rule:** neglect a lateral path if the maximum
  offset of its diffracting edges from the direct S–R line exceeds 8× the corresponding maximum offset
  of the over‑top (EV) rubber band. **DEFERRED to Phase 3** (Phase‑1 review): best‑per‑side selection
  + factor‑8 need the per‑edge side/offset geometry buildings introduce, and only bite with multiple
  obstacles; for a single finite wall the two ends already ARE the best left/right paths, and the web
  currently supplies no lateral edges. The Eq‑25 combination + `≥ 0` floor and lateral‑uncapping are
  already in.
- **2024:** adopted (Eq 22, §7.4.3).

### 5.3 Cap applies to over‑top only  [C]
- **Issue:** the 20/25 dB `Dz` cap, if applied to lateral contributions too, wrongly limits a single
  screen to ~15 dB; and lateral contributions should vanish for long barriers.
- **Recommendation:** apply the 20 dB (single) / 25 dB (multiple) cap **only to over‑top diffraction**,
  not to the lateral paths.
- **Impl:** cap `Abar,top` before the Eq (25) combination; don't cap `Abar,side*`. → **Shared with 2024.**
  ✅ Fixed in Phase 1 — `abar_spectrum` caps only the over‑top path.
- **2024:** adopted (§7.4.4 wording).

### 5.4 Two‑step `Dz` with `zmin`  [B]
- **Issue:** raw 1996 Eq (14) has no lower bound on `z`; a raised line of sight drives the log argument
  below 1 → **negative `Dz`** (a fake level *increase* behind the barrier).
- **Recommendation:** apply Eq (14) in two steps:
  ```
  zmin = −2λ / (C2·C3)
  Dz = 10·lg[ 3 + (C2/λ)·C3·z·Kmet ]   for z > zmin
  Dz = 0                                for z ≤ zmin
  ```
  Note this **keeps the 1996 bracket** `3 + …·Kmet` and merely clamps at `zmin`.
- **Impl:** 1996 mode uses this clamped 1996 bracket. **This is the origin of 2024's `zmin`
  (Eq 19).** But 2024 *also* restructured the bracket to `1 + (2 + …)·Kmet` and changed the `Kmet`
  denominator to `2(z−zmin)` — so **1996‑per‑17534‑3 `Dz` is still not identical to 2024 `Dz`** (see
  §3). This is the subtle one: don't assume the `zmin` fix collapses the whole barrier difference.
- **2024:** `zmin` adopted; bracket + `Kmet` further changed.

### 5.5 No `Abar = Dz − Agr` when `Agr < 0`  [B]
- **Issue:** with reflecting ground `Agr` is negative (a boost); `Dz − Agr` would fake ~3 dB of
  attenuation from a negligible barrier.
- **Recommendation:** use Eq (12) `Abar = Dz − Agr` **only when `Agr > 0`**; otherwise `Abar = Dz`
  (Eq 13).
- **Impl:** this is exactly the barrier‑convention branch already in the code (`IsoEq16` /
  `ground_in_bar`). → **Shared with 2024** (2024 Eq 16/17). Keep it edition‑independent.

### 5.6 Lateral combination must not increase the level  [B]
- **Recommendation:** combine the three contributions by energy —
  `Abar = −10·lg(10^(−0.1·Abar,top) + 10^(−0.1·Abar,side1) + 10^(−0.1·Abar,side2))`; **if the result is
  negative, set `Abar = 0`.**
- **Impl:** identical to 2024 Eq (25). → **Shared with 2024.**

### 5.7 Ground effect from the vertical plane only  [C]
- **Recommendation:** `Agr` is computed once per source–receiver pair from the **vertical‑plane (EV)**
  path; laterally diffracted (EL) rays do **not** get their own ground effect — lateral diffraction
  only *modifies `Abar`*.
- **Impl:** compute `Agr` on the direct/vertical geometry; never per lateral path. → **Shared with 2024.**

### 5.8 No lateral diffraction when elevated ground screens the direct ray  [C]
- **Recommendation:** if any **ground contour** contributes to the over‑top rubber band, do **not**
  compute lateral diffraction (hills aren't bounded by vertical edges).
- **Impl:** flag terrain‑derived screening edges; suppress lateral paths when any are active. → **Shared
  with 2024** (§7.4.3: "not considered if elevated ground contributes to the ray path over the top").
  Matches our existing "terrain virtual barriers emit no lateral edges" behaviour.

### 5.9 Higher‑order reflections  [A]
- **Recommendation:** extend the image‑source method to **n‑th order** (image of the image); integrate
  explicitly.
- **Impl:** image‑source engine carries an order cap ≥ 1. → **Shared with 2024** (§7.5.3, Eq 29).

## 3. What remains a genuine 1996 ↔ 2024 difference *after* applying 17534‑3

Once the §5 recommendations are in the 1996 mode, the edition switch reduces to:

1. **`Agr` combination** — 1996 `As+Ar+Am` vs 2024 `Kgeo` wrap. *17534‑3 does not add `Kgeo`.* → the
   cleanest, most isolated switch.
2. **Barrier `Dz` bracket** — 1996/17534‑3 `10lg[3 + (C2/λ)C3·z·Kmet]` (clamped at `zmin`) vs 2024
   `10lg[1 + (2 + (C2/λ)C3·z)·Kmet]`. Equal when `Kmet=1`; 2024 lower downwind.
3. **`Kmet`** — denominator `2z` (1996/17534‑3) vs `2(z−zmin)` (2024); numerator `dss·dsr` vs
   `(max+e)·min` (multi‑edge only).
4. **`Aatm` coefficient source** — 1996 Table 2 (optional) vs 2024 ISO 9613‑1 at exact centre freqs.
5. **Reflection loss expression** — 1996 `ρ` (Table 4) vs 2024 `α` (default 0.1); numerically same.
6. **Extended‑source subdivision** — 1996 `d ≥ 2·Hmax` rule vs 2024 raster factor `k = 0.5` +
   projection method (differences doc §2). **Not addressed by 17534‑3** (its §5 says nothing about
   subdivision and no §6 case uses a line/area source), so this difference survives *and* is untested
   by the TR — cover it in our own case suite.
7. **2024‑only additions** — detailed forestal `Afol`; Annex B chimney directivity; Annex C wind‑
   climatology `C0`; Annex D wind turbines; cylindrical `Acurv`.

Everything else (ray/path construction, lateral rules, caps, barrier‑vs‑ground convention, higher‑order
reflections) is **shared**. This is a meaningful simplification: the `Iso1996`/`Iso2024` evaluators
differ in a handful of clearly‑bounded places, not across the whole barrier/reflection machinery.

## 4. §6 test cases & §7 conformity (for the validation phase)

- **§6 test cases (T01–T19):** each ships **step‑by‑step intermediate results** *and* a **final result
  interval**. The comparison rule (ISO 17534‑1:2015, A.2 — now held): step values are stated to **two
  decimal places** and are correct if the deviation **≤ ±0.05 dB** (per band and totals; the step
  tables include `α`, `a'…d'`, `Agr_s/m/r`, `Adiv`, `Aatm`, per‑band `L`, `LA`); final results must
  fall within published lower/upper limits at one decimal place (x.x5 results get a 0.1 rounding
  interval; wider ±x dB intervals where definitions leave freedom — explicitly incl. extended‑source
  partitioning). Consequences for our harness:
  - Assert **intermediate terms** (`Adiv`, `Aatm`, `Agr`, `Dz`, `Abar`, per band), not just the total —
    this localises any discrepancy to the offending term.
  - Treat the pass criterion as "within the published interval," per the TR's own tolerance policy.
  - **Case inventory:** T01–T03 flat homogeneous ground (G = 0/0.5/1); T04 varying ground factors;
    T05 = T04 via the **simplified §7.3.2 method**; T06 varying ground **heights (contour lines)** +
    factors; T07 = T06 via §7.3.2; T08/T09 long/short barrier; T10 barrier + varying heights; T11–T18
    **buildings** (cubic, polygonal, three‑building, complex‑with‑backyard); **T19 reflecting
    barrier**. Per TR §6.1: T01–T07 need plain ISO 9613‑2; **T08–T19 additionally require §5.2–§5.9**.
  - **Gaps the TR does NOT cover** (must be in our own suite): extended line/area sources, cylindrical
    reflectors, `Amisc` terms, `Cmet`, and every 2024‑specific behaviour.
  - **Terrain is described by contour lines** (T06/T10/T14/T19) — the core needs a terrain model that
    accepts contours and derives ground profiles, mean height `hm`, terrain screening edges, and
    `hS`/`hR` — this is why terrain is a first‑class `Scene` input (plan §3.4).
  - **T05/T07 exercise the simplified ground method (§7.3.2)** — **RESOLVED (2026‑07‑02): in scope**
    (plan §8), so the DOC is unqualified.
- **§7 Declaration of Conformity (DOC):** the TR defines a conformity declaration. Produce a filled DOC
  as a Phase‑4 deliverable — it's the artifact that states which parts of ISO 9613‑2 the solver
  implements and that it matches the reference cases.

## 5. Open items to confirm when reading §6 in full (Phase 2/4)

- Exact `zmin` expression and whether `Kmet` is included in the §5.4 threshold (text partly garbled;
  transcribe from the page image at implementation). Note: since 1996 sets `Kmet = 1` for `z ≤ 0` and
  `zmin < 0`, a `Kmet` factor inside the `zmin` expression evaluates to 1 there — the two readings are
  expected to coincide; verify.
- Full §6 inputs, intermediate values, and interval tolerances per case (transcribe at Phase 4).
- ~~Obtain ISO 17534‑1~~ — **obtained (2026‑07‑02)**; precision rule extracted into §4 above. Still to
  transcribe at Phase 4: the DOC/TRC form templates (17534‑1 Annex B).
- `Aatm` in the TR cases: T01 specifies T = 20 °C, RH = 70 % (a 1996 Table‑2 column) rather than α
  values — the step‑by‑step `Aatm` values will adjudicate Table‑2 lookup vs ISO 9613‑1 computation.

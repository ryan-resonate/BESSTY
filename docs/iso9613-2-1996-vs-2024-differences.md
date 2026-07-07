# ISO 9613‑2:1996 vs :2024 — comprehensive differences

**Purpose.** This is the authoritative reference for the standalone solver's *version‑switched*
behaviour. Every substantive difference between the two editions is catalogued here with both
formulae, the numerical impact, and the implementation implication. The solver selects an edition
at the scene level (`Standard::Iso1996 | Iso2024`); this document defines exactly what that switch
must change, and — equally important — what it must **not** change (shared code).

**Sources.** Canonical copies of all referenced standards live in **`T:\Literature\Standards\ISO`**
(internally available to all Resonate staff). A local working copy in `Standards/` is `.gitignore`d
(single‑user licence — never commit).
- ISO 9613‑2:1996(E) — *General method of calculation* (first edition). Scanned; read via rendered
  page images.
- ISO 9613‑2:2024(en) — *Engineering method for the prediction of sound pressure levels outdoors*
  (second edition). Clean text + rendered images for the equation‑dense pages.
- ISO/TR 17534‑3:2015 — QA test cases for ISO 9613‑2 (validation gate; see §12).

**Verification status.** Every formula below was transcribed from the primary documents in this
session. A few informative‑annex numeric tables (1996 `Asite`, `Ahous`, and the 1996 worked
example) are flagged **[verify‑at‑impl]** — the structure is confirmed but exact table values should
be re‑checked against the page image when that term is implemented.

Formula numbers are given as **1996 Eq (n)** / **2024 Eq (m)** because the editions renumber.

---

## 0. TL;DR — what the version switch actually changes

| Area | Changed? | Nature of change |
|---|---|---|
| Basic equation `Lft = Lw + Dc − A`, `A = Adiv+Aatm+Agr+Abar+Amisc` | **No** | Identical |
| `Adiv` geometric divergence | **No** | Identical (`20 lg(d/d0)+11`) |
| `Aatm` formula | **No** | Identical (`α·d/1000`) |
| `Aatm` coefficient source | **Yes (minor)** | 1996 tabulated `α` (Table 2) / 2024 computes from ISO 9613‑1 at exact centre freqs |
| `Agr` General — shape functions `a'..d'`, regions, `G` | **No** | Identical |
| **`Agr` General — combination** | **Yes (headline)** | 1996 `Agr=As+Ar+Am`; 2024 wraps in `Kgeo` geometry factor |
| `Agr` Simplified (dB(A)) method | **No** | Identical (incl. the `10 lg(1+Kgeo)` source term) |
| **`Abar` `Dz` formula** | **Yes** | 1996 `10lg[3+…·Kmet]`; 2024 `10lg[1+(2+…)·Kmet]` + explicit `zmin` |
| **`Abar` `Kmet`** | **Yes** | denom `2z` → `2(z−zmin)`; numerator `dss·dsr` → `(max+e)·min` |
| `Abar` `C2`, `C3`, caps (20/25 dB) | **No** | Identical |
| **`Abar` path‑length diff `z` default** | **Yes** | 1996 default includes `a` term; 2024 default is vertical‑plane, `a` is the "alternative method" |
| **`Abar` lateral diffraction combination** | **Yes** | 2024 adds explicit over‑top⊕side energy sum (Eq 25) |
| **Reflections — order** | **Yes** | 1996 single only; 2024 adds nth‑order (Eq 29) |
| **Reflections — cylindrical** | **Yes** | 1996 `ρ` estimate; 2024 explicit `Acurv` (Eq 30) |
| Reflections — surface loss | **Yes (cosmetic)** | 1996 `ρ` (Table 4) vs 2024 `α` default 0.1; `10lg(1−α)=10lgρ` |
| `Cmet` formula | **No** | Identical |
| `Cmet` `C0` determination | **Yes** | 2024 adds Annex C wind‑climatology method |
| `Amisc` foliage/industrial/housing | **No / superset** | 1996 == 2024 *simplified*; 2024 adds detailed forestal method |
| Source subdivision (line/area/groups) | **Yes** | 1996 `d≥2·Hmax`; 2024 raster factor `k=0.5` + projection method |
| Wind‑turbine annex (D) | **Yes** | 2024 only (Annex D) |
| Chimney directivity annex (B) | **Yes** | 2024 only (Annex B) |

Point‑source, flat‑ground, no‑barrier cases will typically differ between editions **only** through
`Agr` (the `Kgeo` wrap). Barrier and reflection scenes diverge more.

> **⚠ Read this table together with the 17534‑3 implementation notes.** Our 1996 mode is implemented
> *per ISO/TR 17534‑3:2015 §5*, whose QA recommendations were largely folded into 2024. So several
> "Yes" rows above (the default `z` construction §8.3, the lateral combination §8.4, the higher‑order
> reflections §9.3, the `zmin` threshold) **collapse to shared behaviour** once 17534‑3 is applied to
> 1996. The differences that genuinely survive are: `Agr` `Kgeo` (§6), the `Dz` bracket + `Kmet`
> details (§8.1–8.2), `Aatm` coefficient source (§5), and the 2024‑only additions (§9.3‑9.4, §12). See
> [`iso9613-2-17534-3-implementation-notes.md`](./iso9613-2-17534-3-implementation-notes.md) §3.

---

## 1. Editorial / structural

- **Title of Part 2:** 1996 "General method of calculation" → 2024 "Engineering method for the
  prediction of sound pressure levels outdoors."
- **Edition:** first (1996‑12) → second (2024‑01).
- **A‑weighting normative ref:** IEC 651 (1996) → **IEC 61672‑1** (2024). Values are effectively the
  same; keep A‑weighting tables edition‑independent.
- **Band filters:** IEC 61260‑1 referenced in 2024.
- **Frequency range:** both cover the 8 octave bands 63 Hz – 8 kHz. (Our solver additionally supports
  ⅓‑octave; that is an implementation extension, not part of either edition's normative core.)
- **Formula count:** 1996 has Eqs (1)–(22) + Annexes A/B; 2024 has Eqs (1)–(32) + Annexes A(.1–.6),
  B, C(.1–.6), D. The renumbering is mechanical but pervasive — always cross‑reference by clause.
- **Annex set** (see §11): 1996 = A (misc attenuation) + B (worked example). 2024 = A (misc,
  expanded) + B (chimney directivity, **new**) + C (`C0` from wind climatology, **new**) + D (wind
  turbines, **new**). The 1996 worked‑example annex is **dropped**.

---

## 2. Source description (§4)

**Concept unchanged:** all formulae are for point sources; extended sources are decomposed into point
sub‑sources; a group may be replaced by one equivalent point source.

**Subdivision criterion — changed:**
- **1996:** a group/extended source may be represented by an equivalent point source when the
  receiver distance `d ≥ 2·Hmax` (`Hmax` = largest source dimension); otherwise subdivide.
- **2024:** subdivide so that no section's extent exceeds `k ×` (distance from its centre to the
  receiver), with **raster factor `k = 0.5`** — plus the **"projection method"**: sections are
  further split by projection lines to the edges of every screening object so each section is either
  fully screened or fully unscreened. Explicit polygon procedure for line sources; convex partitioning
  for area sources.

**Implication.** For a single point source: no difference. For **line/area/grouped** sources the
discretisation differs → the sub‑source generator must be edition‑aware. 2024's projection method is
also what makes screened extended sources correct, so it interacts with `Abar`. This lives in the
*scene‑decomposition* layer, not the per‑path kernel.

---

## 3. Basic formulae (§6) — unchanged core

| Quantity | 1996 | 2024 | Same? |
|---|---|---|---|
| Per‑band level | `LfT(DW)=Lw+Dc−A` Eq (3) | Eq (3) | ✅ |
| Attenuation split | `A=Adiv+Aatm+Agr+Abar+Amisc` Eq (4) | Eq (5) | ✅ |
| Energy sum over sources/bands | Eq (5) | Eq (6) | ✅ |
| Long‑term | `LAT(LT)=LAT(DW)−Cmet` Eq (6) | Eq (7) | ✅ |

**Directivity `Dc`:** concept identical (`Dc` = source directivity index + a solid‑angle term for
nearby reflecting surfaces). 2024 makes the solid‑angle term explicit — **Eq (4)** `Dc = 10 lg(4π/Ω)`
with **Table 2** (1 surface → 3 dB, edge → 6 dB, corner → 9 dB) — and notes this can *replace*
image‑source modelling of near‑source surfaces. Treat as shared logic; 2024 just tabulates it.

---

## 4. Geometric divergence `Adiv` (§7.1) — identical

`Adiv = 20 lg(d/d0) + 11` dB, `d0 = 1 m`. 1996 Eq (7) ≡ 2024 Eq (8). **No switch.**

---

## 5. Atmospheric absorption `Aatm` (§7.2) — formula identical, coefficient source differs

- Formula `Aatm = α·d/1000` (α in dB/km): 1996 Eq (8) ≡ 2024 Eq (9).
- **1996:** `α` taken from **Table 2** (tabulated for 10 °C/70 %, 20 °C/70 %, 30 °C/70 %, 15 °C/20 %,
  15 °C/50 %, 15 °C/80 %); other conditions → ISO 9613‑1.
- **2024:** `α` **computed from ISO 9613‑1:1993 Formulae (2)–(6)** using the **exact** octave‑band
  centre frequencies (explicitly *not* the nominal/rounded ones used elsewhere).

**Implication.** Our solver already computes `α` from an absorption model; keep that for both editions.
Provide a 1996 "Table 2 lookup" option only if a 17534‑3 case demands the tabulated values. The
practical delta is small but nonzero at high frequencies. Edition flag: choice of coefficient source.

---

## 6. Ground attenuation — General method (§7.3.1) — **HEADLINE DIFFERENCE**

**Identical between editions:** the three regions (source `30·hS`, receiver `30·hR`, middle), the
ground factor `G` (hard 0 / porous 1 / mixed), the multi‑section `G` averaging, and **Table 3** in
full — the `−1.5` terms, the `q` factor, and the shape functions:

```
a'(h) = 1.5 + 3.0·e^(−0.12(h−5)²)·(1−e^(−dp/50)) + 5.7·e^(−0.09h²)·(1−e^(−2.8e−6·dp²))
b'(h) = 1.5 + 8.6·e^(−0.09h²)·(1−e^(−dp/50))
c'(h) = 1.5 + 14.0·e^(−0.46h²)·(1−e^(−dp/50))
d'(h) = 1.5 + 5.0·e^(−0.9h²)·(1−e^(−dp/50))
q = 0                        if dp ≤ 30(hS+hR)
q = 1 − 30(hS+hR)/dp         if dp > 30(hS+hR)
```

`AS`, `AR`, `Am` are computed the same way in both editions.

**The difference is the final combination.**

- **1996 — Eq (9):** `Agr = AS + AR + Am`  (direct sum)

- **2024 — Eqs (11)(12)(13):**
  ```
  Ãgr  = AS + AR + Am
  Kgeo = ( dp² + (hS − hR)² ) / ( dp² + (hS + hR)² )
  Agr  = −10·lg[ 1 + (10^(−Ãgr/10) − 1)·Kgeo ]
  ```

**Behaviour.** `Kgeo ∈ (0,1]`. At large `dp` with modest heights `Kgeo → 1` and 2024 ≈ 1996. At short
range or large `(hS+hR)` (e.g. tall sources — chimneys, turbines), `Kgeo < 1`, which **reduces the
magnitude** of the ground effect relative to the 1996 sum. This is the single most likely reason a
plain point‑source case differs between editions.

**Historical note (useful for code comments):** this `Kgeo` is the *same* geometry factor that
already existed in **1996's simplified method** (1996 Eq (11), the `D` source correction). The 2024
revision generalised it into the general method.

**Implication.** Shared code computes `AS+AR+Am`; the edition flag selects the final wrap
(1996: identity; 2024: `Kgeo` transform). `Kgeo` is a pure function of `(dp, hS, hR)`.

---

## 7. Ground attenuation — Simplified dB(A) method (§7.3.2) — unchanged

- `Agr = 4.8 − (2hm/d)·(17 + 300/d) ≥ 0`: 1996 Eq (10) ≡ 2024 Eq (14).
- Source correction (added to `Dc`): 1996 Eq (11) `= 10 lg{1 + [dp²+(hS−hR)²]/[dp²+(hS+hR)²]}`
  ≡ 2024 Eq (15) `D = 10 lg(1 + Kgeo)` with `Kgeo` from Eq (13). Identical.

**In scope (decision 2026‑07‑02):** required for TR conformance cases T05/T07 → unqualified DOC.
Identical in both editions — **no switch**; selected by a `ground_method` setting (default General).
When active, `Dc` gains the Eq 15 `D` term, `Agr` clamps at ≥ 0, and `hm` is evaluated from the
terrain profile (Figure 5 area method — machinery shared with Annex D.5).

---

## 8. Screening `Abar` (§7.4) — **SIGNIFICANT DIFFERENCES**

**Identical between editions:** the screening‑object qualification (surface density ≥ 10 kg/m²,
closed surface, `ll + lr > λ`); the ground‑combination rule `Abar = Dz − Agr` (over‑top, `Agr>0`,
1996 Eq 12 / 2024 Eq 16) and `Abar = Dz` (around edge, or `Agr≤0`, 1996 Eq 13 / 2024 Eq 17); the
constants `C2 = 20` (or 40 if ground reflections are handled separately by image sources); the
multi‑edge `C3` (1996 Eq 15 ≡ 2024 Eq 20):
```
C3 = [1 + (5λ/e)²] / [ 1/3 + (5λ/e)² ]      (=1 for single diffraction, e=0)
```
and the caps: **single ≤ 20 dB, multiple ≤ 25 dB**.

### 8.1 The `Dz` formula — changed
```
1996 Eq (14):  Dz = 10·lg[ 3 + (C2/λ)·C3·z·Kmet ]                 (no explicit zmin)
2024 Eq (18):  Dz = 10·lg[ 1 + (2 + (C2/λ)·C3·z)·Kmet ]   for z > zmin
               Dz = 0                                     for z ≤ zmin
2024 Eq (19):  zmin = −2λ / (C2·C3)
```

> **✅ FIXED in Phase 1 (2026‑07).** The code previously implemented `Dz = 10·lg[1 + (3 + (C2/λ)C3·z)
> ·Kmet]` with `zmin = −λ/(C2·C3)` and `C3 = (1+(5/e)²)/(1/3+(5/e)²)` (no `λ`). All three were wrong
> vs the 2024 PDF (printed p.16): the bracket constant is **2** (Eq 18), `zmin` is **−2λ/(C2·C3)**
> (Eq 19), and `C3` is **`(1+(5λ/e)²)/(1/3+(5λ/e)²)`** (Eq 20, frequency-dependent). The old barrier
> validation cases encoded the same misreadings; they were **recomputed independently** (fresh
> Python implementation, not ported from the Rust) — case 03 → 40.93 dB(A), case 04 → 36.18 dB(A).
> See the execution addendum §2.3.
- When `Kmet = 1` (e.g. lateral paths, or the grazing region): `1 + (2 + X) = 3 + X` — the two
  forms are **identical**.
- When `Kmet < 1` (downwind correction active): 1996 leaves the constant `3` un‑attenuated and scales
  only the `(C2/λ)C3z` term; 2024 puts the `2` **inside** the `Kmet` product, so only `1` stays
  un‑attenuated. Net: **2024 yields slightly lower `Dz` downwind.**
- 2024 adds an explicit `zmin` and, together with the `Kmet` denominator change below, makes `Dz`
  **continuous through the shadow boundary** (`Dz → 0` as `z → zmin⁺`). 1996 is discontinuous near
  `z = 0` (jumps to `10 lg 3 ≈ 4.8 dB`).

### 8.2 `Kmet` — changed
```
1996 Eq (18):  Kmet = exp[ −(1/2000)·√( dss·dsr·d / (2z) ) ]        for z > 0 ;  Kmet = 1 for z ≤ 0
2024 Eq (21):  Kmet = exp[ −(1/2000)·√( (max(dss,dsr)+e)·min(dss,dsr)·d / (2(z − zmin)) ) ]
```
- **Numerator:** `dss·dsr` → `(max(dss,dsr)+e)·min(dss,dsr)`. For **single** diffraction (`e=0`)
  `max·min = dss·dsr` → identical. Differs only for **multi‑edge** paths.
- **Denominator:** `2z` → `2(z − zmin)` — the continuity fix (pairs with 8.1).
- Both set `Kmet = 1` for lateral diffraction.

### 8.3 Path‑length difference `z` — default construction changed
- **1996 (Eqs 16 single / 17 double):** `z = √[ (dss + dsr + e)² + a² ] − d`, where `a` is the
  component of the S–R separation **parallel to the barrier edge**. This `a`‑term is part of the
  *default* method.
- **2024 (Eq 22, §7.4.1 general method):** `z = (dss + dsr + e) − d`, constructed as a rubber‑band in
  the **vertical plane** containing S and R (no `a`‑term). For multiple edges that don't block the
  line of sight, **Eq (23)** `z = max(zn)`.
- **2024 (Eq 24, §7.4.2 "alternative method"):** `z = √[ (dss + dsr + e)² + a² ] − d` — i.e. the
  1996‑style `a`‑term formula is retained but demoted to an optional, "lower and more accurate"
  method for edges not perpendicular to S–R.

**⚠ 17534‑3 override — this difference collapses in practice.** 17534‑3 §5.2 recommends the
**vertical‑plane rubber‑band construction for the 1996 mode as well**, precisely because the raw
`a`‑term formula fails for non‑parallel double diffraction (and doesn't generalise past two edges). So
the *implemented* 1996 `z`‑construction is the **same** as 2024's Eq (22). The `a`‑term formula is only
the raw‑text 1996 default and the 2024 optional "alternative method." Our current code already builds
the vertical‑plane rubber band — correct for both editions. (See implementation‑notes §5.2.)

### 8.4 Lateral diffraction & combination — expanded in 2024
- **1996:** acknowledges diffraction around vertical edges (`Abar = Dz`, Eq 13) and that lateral
  paths reduce effectiveness (NOTE), with `Kmet = 1` laterally — but gives **no explicit formula to
  combine** over‑top and around‑side contributions.
- **2024 (§7.4.3 / §7.4.4):** formalises up to two lateral paths and combines them with the over‑top
  path by energy — **Eq (25):**
  ```
  Abar = −10·lg[ 10^(−0.1·Abar,top) + 10^(−0.1·Abar,side1) + 10^(−0.1·Abar,side2) ]   (≥ 0)
  ```
  A lateral path is neglected if its supporting‑point offset exceeds the vertical‑plane offset by a
  factor > 8; lateral paths are ignored when elevated ground contributes to the over‑top path.

**Implication — RESOLVED by 17534‑3.** TR §5.6 mandates exactly this energy combination (with a
floor at 0) for the 1996 mode, and TR §6.1 states cases T08–T19 *require* the §5.2–§5.9
recommendations. So Eq (25) is **shared** behaviour across both editions, with the TR's companion
rules: cap over‑top only (§5.3), at most two lateral paths (best left + best right), the factor‑8
neglect rule, and no lateral paths when terrain participates in the over‑top rubber band (§5.8).

---

## 9. Reflections (§7.5) — **SIGNIFICANT DIFFERENCES**

Both editions use image sources and exclude ground reflection (it is in `Agr`).

### 9.1 Validity condition
```
1996 Eq (19):  1/λ  >  [ 2 / (lmin·cosβ)² ] · [ dS,O·dO,R / (dS,O + dO,R) ]
               lmin = minimum dimension (length or height) of the reflecting surface
2024 Eq (26/27): 1/λ > (2 / leff²) · [ dS,O·dO,R / (dS,O + dO,R) ]
               leff = min( a·cos αa , h·cos αh )
```
2024 separates horizontal extent `a`/angle `αa` from vertical extent `h`/angle `αh`.

### 9.2 Image‑source sound power
```
1996 Eq (20):  Lw,im = Lw + 10·lg(ρ) + DI      (ρ = reflection coefficient; Table 4)
2024 Eq (28):  Lw,im = Lw + 10·lg(1−α) + DIr   (α = absorption coefficient; default 0.1 for facades)
```
Numerically equivalent (`10 lg(1−α) = 10 lg ρ`). 2024 standardises the **default α = 0.1**; 1996 uses
**Table 4** estimates: flat hard walls `ρ=1`, walls with windows/openings `ρ=0.8`, factory walls with
~50 % openings `ρ=0.4`, cylinders (tanks/silos) via a geometric `ρ` formula, open installations `ρ≈0`.
**[verify‑at‑impl]** exact 1996 Table 4 entries.

### 9.3 Higher‑order reflections — 2024 only
- **1996:** single reflection only (normative).
- **2024 (§7.5.3, Eq 29):** nth‑order image source
  `Lw,im,N = Lw + 10·lg( ∏ₙ (1−αₙ) ) + DIr`, required when source/receiver sit between (near‑)parallel
  or surrounding reflectors; each reflector must independently satisfy Eq (26)/(27).

### 9.4 Cylindrical surfaces — 2024 only (as an `Amisc` term)
- **1996:** only a `ρ` estimate for cylinders in Table 4.
- **2024 (§7.5.4, Eq 30):** explicit curvature attenuation `Acurv` (applied within `Amisc`):
  ```
  Acurv = 10·lg[ (1/r + 2·dS·dR/(dS+dR))·(1 − k²) ]⁻¹ ,  k = d/r
  ```
  (transcribe exactly from Eq 30 at implementation — the bracket grouping is intricate). Reflection
  order > 1 is not considered for curved surfaces.

**Implication.** Reflections are edition‑aware: 1996 = first‑order planar (+ optional cylinder `ρ`);
2024 = first + higher‑order planar with `α`, plus `Acurv`. Our image‑source engine should carry an
order cap and a per‑surface loss (α), with the edition selecting defaults and whether `Acurv`/nth‑order
are enabled.

---

## 10. Meteorological correction `Cmet` (§8) — formula identical, `C0` method added

```
Cmet = 0                        if dp ≤ 10(hS+hR)      (1996 Eq 21 ≡ 2024 Eq 31)
Cmet = C0·[ 1 − 10(hS+hR)/dp ]  if dp > 10(hS+hR)      (1996 Eq 22 ≡ 2024 Eq 32)
```
- **1996:** `C0` estimated from elementary local meteorology; range 0…≈+5 dB, values > 2 dB
  exceptional; worked example gives `C0 ≈ +3 dB`.
- **2024:** same guidance **plus Annex C** — compute `C0` from the angular wind distribution
  (wind rose): `Dwd(β) = −Q·{1 − cos[β − γ − sin(β−γ)]}` with preferred `Q = 5 dB`, `γ = π/4`, summed
  over wind samples (Eqs C.1–C.6).

**Implication.** The `Cmet` kernel is shared. `C0` is an input either way; the Annex C wind‑climatology
computation is an optional 2024 feature that produces a (possibly direction‑dependent) `C0`.

---

## 11. Accuracy (§9) — same table, wider stated applicability

1996 **Table 5** ≡ 2024 **Table 4**: `±3 dB` for `0<h<5 m` (all `d<1000 m`); `±1 dB` for `5<h<30 m,
0<d<100 m`; `±3 dB` for `5<h<30 m, 100<d<1000 m`. 2024 extends the *experience* note to heights up to
~200 m (chimneys, wind turbines) and points to Annex D; 1996 stops at 30 m. Informative only — no
computational effect.

---

## 12. Annexes

### 1996
- **Annex A (informative) — `Amisc`:** foliage `Afol` (Table A.1), industrial sites `Asite`, housing
  `Ahous`.
- **Annex B (informative) — worked example.** **[verify‑at‑impl]** (useful as an extra end‑to‑end
  check; dropped in 2024).

### 2024
- **Annex A (informative) — `Amisc`, expanded:**
  - `Afol` foliage: **simplified** method with **Table A.1 identical to 1996** (`10≤df≤20 m`:
    `0,0,1,1,1,1,2,3 dB`; `20≤df≤200 m`: `0.02,0.03,0.04,0.05,0.06,0.08,0.09,0.12 dB/m`) **plus a new
    detailed forestal‑parameter method** (A.2.3: stem diameter, basal area, standing stock, structuring
    classes → regression `Klin`, Tables A.2–A.6).
  - `Asite` industrial: Table A.7 attenuation‑per‑metre, max 10 dB.
  - `Ahous` housing: `Ahous = Ahous,1 + Ahous,2`, `Ahous,1 = 0.1·B·db`, `Ahous,2 = −10 lg[1−p/100]`
    (`p ≤ 90 %`), max 10 dB, with the `Agr` interaction rule.
- **Annex B (informative) — chimney‑stack directivity `Dc`. New.** `Dc(ka, β)` from Table B.1 with
  bilinear interpolation; `ka = 2πaf / (331.4·√(1+T/273))`; downwind ray‑angle correction.
- **Annex C (informative) — `C0` from angular wind distribution. New.** (see §10.)
- **Annex D (informative) — wind turbines. New.** D.2 omnidirectional point source at hub height
  (IEC 61400‑11); D.3 `Abar` for terrain screening only, restrict to ≤ 3 dB and/or use a raised
  (tip‑height) source; D.4 use `G ≤ 0.5` for porous/mixed and a **minimum 4 m receiver height** when
  `G=0.5`; D.5 concave‑ground correction `ΔAgr = −3 dB` when `hm ≥ 1.5·(hS+hR)/2`; D.6 `Cmet`/`C0` at
  rotor‑centre height; D.7 uncertainty.

**`Amisc` implication.** 1996 `Amisc` == 2024 *simplified* `Amisc`. So `Afol/Asite/Ahous` are largely
**shared** code; the only edition‑gated `Amisc` piece is 2024's detailed forestal method. Per locked
scope, all default to **0** unless explicitly enabled. Annexes B, C, D are 2024‑only optional modules.

---

## 13. Validation strategy implication

**ISO/TR 17534‑3:2015 predates the 2024 revision and is written against ISO 9613‑2:1996.** Therefore:
- The **1996 mode** is the edition validated by 17534‑3 → it is the primary conformance target and
  must pass 17534‑3 in CI before any deploy.
- The **2024 mode** has **no official TR test suite**. Validate it by (a) reusing the shared kernels
  proven under 1996, and (b) hand‑calculated cases that specifically exercise the divergences above —
  the `Agr` `Kgeo` wrap (§6), the `Abar` `Dz`/`Kmet` changes (§8.1–8.2), the default‑`z` change
  (§8.3), reflections `α`/nth‑order/`Acurv` (§9), and source subdivision (§2).
- Per the agreed philosophy: develop against our **own** independent case suite first (to avoid
  overfitting to the TR), then gate on 17534‑3.

---

## 14. Open items to confirm when implementing

- **[verify‑at‑impl]** exact 1996 Table 4 reflection‑coefficient `ρ` entries and the cylinder `ρ`
  formula (§9.2).
- **[verify‑at‑impl]** exact 2024 `Acurv` bracket grouping in Eq (30) (§9.4).
- **[verify‑at‑impl]** 1996 Annex A `Asite` (Table A.x) and `Ahous` numeric values vs 2024 Table A.7 /
  Eqs A.4–A.6 (expected identical, but confirm).
- **[verify‑at‑impl]** 1996 Annex B worked‑example inputs/outputs (candidate extra end‑to‑end case).
- **RESOLVED — 17534‑3 case inventory** (from the TR ToC/§6): T01–T03 flat homogeneous ground
  (G = 0 / 0.5 / 1); T04 spatially varying ground factors; **T05 = T04 via the *simplified* ground
  method §7.3.2** (scope decision pending — see plan §8); T06 varying ground heights (contour lines)
  + varying G; **T07 = T06 via §7.3.2**; T08/T09 long/short barrier on varying‑G flat ground; T10
  short barrier + varying heights; T11–T13 cubic/polygonal buildings (low/high receiver); T14
  polygonal building + varying heights/G; T15 building, receiver at large height; T16/T17 three
  buildings (two source/receiver layouts); T18 complex building with backyard; **T19 reflecting
  barrier + varying heights/G**. T01–T07 need plain ISO 9613‑2 only; **T08–T19 additionally require
  the TR §5.2–§5.9 recommendations** (TR §6.1). No cylindrical‑reflector case; no extended
  (line/area) source case — those must be covered by our own suite. Step‑by‑step values are given at
  "precision 2 per ISO 17534‑1, A.2" — **we do not hold ISO 17534‑1** (needed for the precision rule
  and the DOC template).

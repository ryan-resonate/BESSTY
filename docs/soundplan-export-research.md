# SoundPLAN export — feasibility research (#19)

Question: can BESSTY export a project (sources, receivers, calculation
area, topography, settings) in a form SoundPLAN can ingest, so a user
can cross-check / continue work in SoundPLAN?

Short answer: **Yes for the geometry + source data + spectra. No for a
one-click "open this as a SoundPLAN project" file** — SoundPLAN's native
project format (binary Geo-Database) is proprietary and undocumented, so
we don't write it directly. We hand SoundPLAN the ingredients it already
knows how to import; the user runs SoundPLAN's import wizard once.

This matches how every other package (CadnaA, IMMI, Predictor) exchanges
with SoundPLAN — nobody writes each other's native project files; they
exchange shapefiles + DXF + ASCII grids + the QSI standard.

**Two viable export targets**, in order of fidelity:

1. **QSI (DIN 45687)** — the *purpose-built* German-standard interchange
   format for noise-calculation software. SoundPLAN imports it (Base
   module); CadnaA, IMMI and Predictor all read/write it. It carries
   sources + spectra + geometry in one model, which is exactly our
   problem. **This is the ideal target** — but the format is a DIN
   standard (DIN 45687), so the spec isn't freely available and writing
   a conformant QSI exporter is more work and needs the standard
   purchased / reverse-engineered from a sample QSI file. Flagged as the
   gold-standard option if cross-package exchange becomes a core
   workflow. **See the dedicated "QSI (DIN 45687) — export format,
   detailed" section below** for the full file-set architecture, the
   master-file structure, the spectra model, and the sample-file
   reverse-engineering checklist.

2. **Shapefile bundle (+ DGM grid + README)** — the pragmatic path. Uses
   only formats whose specs we already implement (shapefile writer
   exists in `exporters.ts`). SoundPLAN's import wizard maps the
   attribute columns onto its object fields, spectra included. Lower
   fidelity than QSI (one import pass per file, calc settings via the
   README) but **far less effort and zero format risk**. Recommended
   first build.

## What SoundPLAN can import (confirmed from vendor docs, May 2026)

SoundPLAN's **Geo-Database** is the central store for geometry +
acoustics (point/line/area sources, receivers, buildings, barriers,
DGM). Confirmed import paths:

| Format | Used for | Confirmed |
|---|---|---|
| **Shapefile (.shp/.dbf/.shx/.prj)** | point sources, receivers, buildings, barriers, contour lines — bi-directional ("ArcView Shape File Interface"); one file per object type; attribute table carries object properties | ✓ vendor |
| **QSI (DIN 45687)** | full noise-model interchange (sources + spectra + geometry) — Base module | ✓ vendor |
| **DXF** | CAD geometry (contours, footprints) | ✓ vendor |
| **ASCII / text** | coordinate lists, spot heights, AND "Import of point sources (ASCII)" — point sources with spectra | ✓ vendor |
| **Excel (direct)** | tabular attribute + spectrum data, pasted/imported in the Geo-Database | ✓ vendor |
| **KML** | geometry (Cartography module) | ✓ vendor |
| **DGM elevation**: ASCII files, **ESRI ASCII Grid**, ESRI Binary Grid, **GeoTIFF**, LAS/LAZ, ITF | digital ground model | ✓ vendor |

Two facts that simplify our exporter:

- **Frequency range is 1 Hz – 20 kHz, octave OR 1/3-octave**, both
  natively. So we do **not** need to drop our 16/31.5 Hz octave bands,
  and we do **not** have to fold 1/3-octave → octave — we can export in
  whichever band system the source data already uses. (A fold-to-octave
  option is still nice for users whose SoundPLAN library is octave-only,
  but it's optional, not mandatory.)
- **Point sources can be imported via ASCII or Excel directly**, not
  only via shapefile. Excel-paste is actually how many SoundPLAN users
  enter source spectra by hand, so an Excel/CSV source table with an
  octave/third-octave block is a familiar, low-friction artefact.

The shapefile/ASCII/Excel import wizard maps source-file columns →
SoundPLAN object properties, **including sound-power levels and per-band
spectra**. That attribute-mapping step is the linchpin that makes this
feasible.

## QSI (DIN 45687) — export format, detailed

This section is the deep-dive requested in #19: how we would actually
*create* a QSI dataset. Everything below is confirmed from vendor
documentation and the published national supplements; the gaps (exact
DBF column names) are called out explicitly, because those are what the
sample QSI files will close.

### What QSI actually is

"QSI" = **Q**ualitätssicherung für **S**oftware-Produkte zur
**I**mmissionsberechnung (quality assurance for immission-calculation
software). The *data format* of the same name is the GIS-based
interchange model defined alongside the QA scheme. Lineage:

- **DIN 45687:2006-05** — the parent standard (the QSI data format is
  its **Annex D**).
- **DIN 45687 Beiblatt 1 (2006-04)** — the supplement literally titled
  *"…QSI-Dataformat and QSI-Model-File"*; this is the format-spec
  document (purchasable from DIN Media / Beuth).
- **"Dokumentation 1 – QSI-Datenschnittstelle – DIN 45687"** — the
  living committee document that fully specifies the interface,
  maintained by **NA 001 BR-02 SO** (formerly NALS Bei-SoA QS). It is
  **co-authored by DataKustik (CadnaA), Wölfel (IMMI) and SoundPLAN**
  — the three major vendors jointly own the format, which is exactly
  why all three read and write it interchangeably. *This is the
  document to obtain* if we commit to a QSI exporter.
- Restructuring in progress (2024–): DIN 45687 is being recast as a
  national supplement to **DIN ISO 17534-1**, and the QSI format
  fundamentals are migrating into **DIN/TR 8998-1**. No evidence the
  format itself is changing — only where it's documented. (Buy the
  current DIN 45687 Beiblatt 1; track DIN/TR 8998-1 for the successor.)

### File-set architecture (confirmed)

QSI is **not a single file**. A QSI dataset is:

1. **One INI-style master/index file `<name>.qsi`** — plain text, with
   bracketed sections. Confirmed from the Austrian CNOSSOS-AT supplement
   (co-authored by all three vendors): a `[Meta]` section carrying
   keywords including
   - a **`fmt…` family** that declares the emission/calculation method
     per source category — e.g. `fmtflight=CNOSSOS-AT` /
     `fmtflight=CNOSSOS-DE` (and by analogy road/rail/industry tokens).
     This tells the importer *which regulation's emission model* the
     numbers follow.
   - **`YOffset`** — a coordinate offset.
   - **`epsg=<code>`** — the CRS as an EPSG code (added by the Austrian
     supplement right after `YOffset`; the base German version declares
     the CRS too). For us this is where the MGA/UTM zone goes
     (e.g. `epsg=28355` for MGA Zone 55 / GDA94).

2. **A set of ESRI-shapefile triplets (`.SHP`/`.DBF`/`.SHX`), one per
   object type**, named `<name>_XXXX.{SHP,DBF,SHX}`. The geometry rides
   in the `.SHP`; the acoustic/semantic attributes ride in the `.DBF`.

3. **DBF-only relational tables** for data that doesn't have geometry —
   crucially the **spectra** and **diurnal patterns**, referenced by ID
   from the source records.

Object-type suffixes (confirmed from CadnaA's QSI writer, which follows
the DIN suffix convention):

| Suffix | Object | Geometry |
|---|---|---|
| `_SRCP` | point source | Point |
| `_SRCL` | line source | PolyLine |
| `_SRCA` | area source | Polygon |
| `_ROAD` | road | PolyLine |
| `_RAIL` | railway | PolyLine |
| `_PARK` | parking lot | Polygon |
| `_RECV` | receivers | Point |
| `_BLDG` | buildings | Polygon |
| `_BARR` | barriers / noise walls | PolyLine |
| `_HLIN` | contour / height lines | PolyLine |
| `_HGPT` | spot heights | Point |
| `_GABS` | ground-absorption areas | Polygon |
| `_AREA` | attenuation areas (e.g. foliage, built-up) | Polygon |
| `_CROS` | crossing / signalised junction | Point |
| `_SPEC` | **spectra table** | — (DBF only) |
| `_DIPA` | **diurnal patterns** (day/evening/night PWL corrections + operating times) | — (DBF only) |
| `_TRCL` | train classes | — (DBF only) |
| `_DRCT` | directivity | — (DBF only; **CadnaA extension, not core DIN**) |

Note: **vertical area sources are not representable in QSI** and are
silently dropped by CadnaA's exporter — fine for us (we have none).

### Geometry & height conventions (confirmed)

- Coordinates live in the `.SHP` in the project CRS (declared via
  `epsg=`/`YOffset` in the master file).
- **Heights are absolute** — top edges ("Oberkanten"), *not* height
  above local ground. So when we emit a WTG hub at 100 m AGL we must
  write `groundElevation + 100` as the absolute Z. We hold the DEM, so
  this is a lookup-and-add, but it's a real conversion step (our
  internal model stores height-above-ground).
- Heights are written **in metres**.
- **Multi-receivers are expanded** into individual receiver points (one
  feature each) — matches how we'd want to emit a receiver grid anyway.

### The spectra model (the crux of a QSI writer)

This is the part that differs most from the flat shapefile-bundle plan
and is where the sample files matter most. The design is **relational**:

- A source feature in `_SRCP`/`_SRCL`/`_SRCA` carries its geometry,
  identifiers, and (almost certainly) an **overall L<sub>WA</sub> plus a
  foreign-key ID into `_SPEC.DBF`**. The per-band spectrum is *not*
  inlined as 8/31 columns on the source record (that's the
  shapefile-bundle approach) — it lives in `_SPEC.DBF`, keyed by that
  ID, so several sources can share one spectrum.
- `_DIPA.DBF` holds **day/evening/night** level corrections and
  operating times, again keyed back to the source — this is how QSI
  encodes time-of-day operation, which maps cleanly onto our
  day/evening/night periods.
- Octave **and** third-octave are both supported (consistent with the
  SoundPLAN frequency findings above), so we keep our native band
  system; no forced fold.

### What we can build today vs. what needs the spec / a sample

**Confident now (no spec needed):**

- the master `.qsi` INI writer — `[Meta]` with the right `fmt*` token,
  `epsg`, `YOffset`;
- the per-object shapefile triplets with the correct `_XXXX` suffixes
  (our shapefile writer in `exporters.ts` already produces
  `.shp/.dbf/.shx`);
- absolute-height conversion (DEM lookup + add), metre units,
  multi-receiver expansion, CRS/EPSG wiring (reuse `lib/projections.ts`).

**Cannot finalise without DIN 45687 Beiblatt 1 / Dokumentation 1, *or* a
sample QSI dataset:**

- the **exact DBF column names and types** in each object file — in
  particular the name of the foreign-key column linking a source to its
  spectrum, and which attributes are mandatory;
- the **`_SPEC.DBF` layout** — one row per band vs. one column per band;
  how bands are labelled; whether levels are L<sub>W</sub> or
  L<sub>W</sub>″ (per-metre / per-m²) for line/area sources; **Z- vs
  A-weighting** convention; the centre-frequency set;
- the **`_DIPA.DBF` layout** — column names for the D/E/N corrections
  and operating times;
- the exact **`fmt*` token for a generic ISO 9613-2 industrial point
  source** (our WTG/BESS case) as distinct from road/rail/aircraft.

### Reverse-engineering checklist (for the sample QSI files)

When you supply sample QSI datasets, here is exactly what to pull out —
ideally one sample that contains **point sources with spectra** (closest
to our WTG/BESS case):

1. **The master `.qsi`** — open it as text and capture every section
   (`[Meta]`, and any `[…]` listing the member shapefiles) and every
   keyword/value, especially the `fmt*` token(s), `epsg`, `YOffset`, and
   how the object files are referenced.
2. **`_SRCP.DBF` field schema** — dump the DBF header: every field
   name, type (C/N/F), width, decimals. Flag which field holds the
   overall level and which holds the spectrum/diurnal foreign key.
3. **`_SPEC.DBF`** — the full header *and* a couple of data rows, so we
   can see band labelling, row-vs-column layout, weighting, and how a
   row links back to a source.
4. **`_DIPA.DBF`** — header + a sample row (D/E/N corrections +
   operating-time columns).
5. **One source's geometry** — confirm the `.SHP` shape type and that
   the Z/height value is absolute (compare against the DEM).
6. **`_RECV.DBF`** — receiver field schema (name, height, any limit
   columns).
7. If present, **`_BARR.DBF`** — barrier height/absorption fields.

`pdftotext`/a DBF dump (`dbview`, or our own DBF reader) is enough; I can
write a tiny throwaway DBF-header dumper to parse them if that's easier
than opening in CadnaA/SoundPLAN.

### Effort & recommendation for QSI specifically

A conformant QSI exporter is a **multi-day** effort (vs. ~1 day for the
shapefile bundle): the master-file INI writer, the relational
source→spectrum→diurnal split, absolute-height conversion, and the
per-file DBF schemas are all new. But it reuses our existing shapefile
writer and reprojection, and it is the **only** target that hands
SoundPLAN (and CadnaA and IMMI) a *single, complete, importable model*
including spectra and time-of-day operation — no per-file wizard
mapping. Recommended sequence: **(a)** obtain a sample QSI set (fastest)
and/or DIN 45687 Beiblatt 1; **(b)** lock the DBF schemas from the
sample; **(c)** build, validating round-trip by re-importing our own
output into SoundPLAN.

## Mapping BESSTY → SoundPLAN

### 1. Point sources (WTG / BESS / auxiliary) → `sources.shp`

One point feature per materialised source (BESS-group units are already
flattened into `project.sources`, so this is natural — task #20's
materialiser does the work for us). Attribute columns:

| BESSTY field | Shapefile attr (≤10 chars) | Notes |
|---|---|---|
| `name` | `NAME` | |
| `kind` | `KIND` | wtg / bess / auxiliary |
| height (hub for WTG, elevationOffset for BESS/aux) | `HEIGHT_M` | SoundPLAN source Z / height above ground |
| overall LwA | `LWA` | A-weighted total, dB |
| per-band Lw (un-weighted, Z) | `LW63`, `LW125`, `LW250`, `LW500`, `LW1000`, `LW2000`, `LW4000`, `LW8000` | octave bands; the 10-char DBF field-name limit forces these short names |

**The octave-band columns are the crux.** SoundPLAN handles 1 Hz –
20 kHz in octave OR 1/3-octave (confirmed), so we have options:

- **Export in the source's native band system.** If a model's spectra
  are 1/3-octave (e.g. the V163 WTG data), emit 1/3-octave columns; if
  octave (e.g. the Tesla Megapack), emit octave columns. No mandatory
  fold — SoundPLAN takes both. Our 16/31.5 Hz octave bands are inside
  SoundPLAN's range, so they're kept, not dropped (this corrects an
  earlier assumption).
- **Optional fold-to-octave toggle** for users whose SoundPLAN source
  library is octave-only — we already have `foldThirdsToOctave` in
  `catalog.ts`.
- Emit **un-weighted Lw** per band (SoundPLAN expects Lw; it
  A-weights internally). This is exactly the `Z`-weighted internal
  representation our solver already uses — no conversion needed.
  (Reassuringly, this is also why the DΩ=0 validation default matters:
  SoundPLAN won't add the +3 dB either, so the two tools line up.)

Octave column names (DBF 10-char limit): `LW16 LW31 LW63 LW125 LW250
LW500 LW1000 LW2000 LW4000 LW8000`. 1/3-octave needs 31 columns
(`LW10 LW12_5 LW16 … LW20000`) — well within the DBF 255-field limit,
and the `_` in `LW12_5` is a legal DBF field-name char. If shapefile
column-count ever feels cramped, the **Excel/CSV source table** path
sidesteps the 10-char limit entirely (friendlier full headers like
`Lw 125 Hz`).

### 2. Receivers → `receivers.shp`

One point per receiver. Attributes:

| BESSTY field | Attr | Notes |
|---|---|---|
| `name` | `NAME` | |
| `heightAboveGroundM` | `HEIGHT_M` | receiver height |
| `limitDayDbA` / `limitEveningDbA` / `limitNightDbA` | `LIM_DAY` / `LIM_EVE` / `LIM_NIGHT` | optional; SoundPLAN has its own limit-handling but carrying them helps |

### 3. Calculation area → `calc_area.shp`

A single polygon feature (the rotated rectangle). SoundPLAN uses a
"calculation area" / grid-noise-map boundary; importing the polygon
gives the user the extent to set up their grid run. Rotation is baked
into the polygon corner coordinates.

### 4. Barriers / noise walls → `barriers.shp`

Polyline features with a `HEIGHT_M` attribute (top height) and optional
`DENSITY` (surface mass) / `ABSORB` (absorption). SoundPLAN imports
barriers as line objects with a height attribute — clean mapping.

### 5. Topography (DEM) → `dem.asc` (ESRI ASCII grid) or `dem.tif`

SoundPLAN builds its DGM (TIN) from contour lines, spot heights, or grid
elevation. The cleanest export from our raster DEM is an **ESRI ASCII
grid** (`.asc`) — a trivially-writable text format
(`ncols`/`nrows`/`xllcorner`/`yllcorner`/`cellsize`/`NODATA_value` header
+ the grid of elevations). SoundPLAN ingests it as DGM grid data. We
already hold the DEM as a sampled raster (`DemRaster`), so writing
`.asc` is straightforward.

Alternative: re-export the user's original uploaded GeoTIFF verbatim
(we have it in Firebase Storage once Blaze is on, or in memory this
session). SoundPLAN imports GeoTIFF too. Simplest of all when a DEM
was uploaded — just hand back the original file.

### 6. Settings / scenario → `README_soundplan.txt`

SoundPLAN doesn't import a "settings file"; calculation settings
(ground absorption G, meteorological conditions, ISO 9613-2 options,
wind speed for WTG mode) are configured inside SoundPLAN's run setup.
We export a human-readable text summary of the BESSTY scenario +
settings so the user can replicate them: wind speed + reference height,
period, ground G, DΩ, atmosphere (T/RH/pressure), the chosen
ISO 9613-2 year (once #17 lands), barrier convention, etc.

## What's lost / needs manual steps in SoundPLAN

- **Calculation settings** aren't transferred automatically — the user
  re-enters them from our README (one-time per project).
- **Source directivity / WTG specifics** — SoundPLAN models wind
  turbines with its own WTG object + the IEC mode logic. We export the
  effective Lw spectrum at the project's wind speed; if the user wants
  SoundPLAN to do its own wind-speed interpolation they'd use
  SoundPLAN's WTG library instead. Export-the-effective-spectrum is the
  pragmatic cross-check path.
- **The CRS** must be written into each shapefile's `.prj` so SoundPLAN
  georeferences correctly. We already know the project's working CRS
  (we reproject on import); we reverse that to emit shapefiles in a
  projected CRS (MGA/UTM) which SoundPLAN prefers over lat/lng.
- **One import wizard pass per file** — not a single click. Acceptable
  and standard for cross-package exchange.

## Implementation sketch (when we build it)

A new exporter in `web/src/lib/exporters.ts` (we already have
shapefile-writing there for contours — `exportContoursShp` — so the
shapefile machinery exists):

1. `exportSoundPlanBundle(project, dem, opts)` →
   produces a `.zip` containing:
   - `sources.shp/.dbf/.shx/.prj` (and/or `sources.csv` for the
     Excel-paste path)
   - `receivers.shp/...`
   - `calc_area.shp/...`
   - `barriers.shp/...` (if any)
   - `dem.asc` (ESRI ASCII grid) or the original `.tif` verbatim
   - `README_soundplan.txt`
2. Reuse `spectrumFor` to get per-source Lw in the source's native band
   system (octave or 1/3-octave — SoundPLAN takes both). Apply
   `foldThirdsToOctave` ONLY if the user ticks the optional
   "fold to octave" export option.
3. Reproject lat/lng → the project's projected CRS via the existing
   `proj4` setup (`lib/projections.ts`).
4. Wire a "Export → SoundPLAN bundle (.zip)" button into the side
   panel's export section.

Estimated effort: **~1 day** for the shapefile-bundle path. The
shapefile writer + projection + spectrum helpers all already exist; the
new work is the attribute schema, the ESRI-ASCII-grid DEM writer, the
README generator, and the zip bundling. (A QSI/DIN-45687 exporter would
be a separate, larger effort — see the two-targets note up top.)

## Recommendation

**Feasible and worth doing.** Build the shapefile-bundle exporter. It's
a high-value interoperability feature for a consultancy that cross-
checks against SoundPLAN, the format risk is low (shapefile + ASCII grid
are stable, decades-old, well-understood), and most of the hard parts
(shapefile writing, reprojection, spectrum folding) already exist in
BESSTY.

Two open questions to confirm with the user before building:
1. **Band system on export** — research resolved the original
   octave-vs-1/3 question: SoundPLAN takes both across 1–20 kHz, so the
   plan is **export in the source's native band system**, with an
   optional "fold to octave" toggle for octave-only SoundPLAN libraries.
   Confirm that's the wanted default.
2. **WTG sources** — export the effective Lw at the scenario wind speed
   (cross-check path), or also emit a separate per-wind-speed table for
   users who want SoundPLAN to interpolate? The former is simpler and
   covers the main use case.
3. **Which target first** — the shapefile bundle (recommended, ~1 day,
   low risk) or invest in a QSI/DIN-45687 exporter (higher fidelity,
   single complete model exchange — see the QSI section above)? The QSI
   path is now de-risked structurally (file-set architecture, master
   INI file, relational spectra model all mapped); the only remaining
   unknowns are the per-file **DBF column schemas**, which a **sample
   QSI dataset** (you offered to source some) would close in an
   afternoon. Best first artefact to obtain: a sample containing **point
   sources with spectra**.

## Sources consulted

- SoundPLAN GmbH vendor docs — Geo-Database + data exchange: bi-
  directional ArcView shapefile interface; DXF, QSI (DIN 45687) and
  ASCII interfaces in the Base module; direct Excel import; "Import of
  point sources (ASCII)"; KML import/export (Cartography); grid-map
  GeoTIFF export.
  - https://www.soundplan.eu/en/software/soundplannoise/modules/
  - http://www.soundplan.com/arcview.htm
  - http://www.soundplan.com/geo-database.htm
- DGM import formats (ASCII, ESRI ASCII Grid, ESRI Binary Grid,
  GeoTIFF, LAS/LAZ, ITF) — SoundPLANnoise module description (April
  2024) and SoundPLANessential 5.1 manual.
- Frequency handling (octave + 1/3-octave, 1–20 kHz) — SoundPLAN module
  descriptions; point/line/area source emission entry.
- CadnaA ↔ SoundPLAN interoperability via QSI (DIN 45687) + shapefile —
  Datakustik CadnaA documentation (QSI export, SoundPLAN receiver
  import).
- ESRI shapefile / DBF 10-char field-name limit (drives the short
  `LW63`… column naming) — Esri ArcGIS Pro documentation + knowledge
  base.
- **QSI / DIN 45687 format detail:**
  - CadnaA QSI export documentation — the `_SRCP/_SRCL/_SRCA/_ROAD/
    _RAIL/_PARK/_RECV/_BLDG/_BARR/_HLIN/_HGPT/_GABS/_AREA/_CROS` object
    suffixes and the `_SPEC/_DIPA/_TRCL/_DRCT` DBF tables; "_DIPA.DBF"
    diurnal patterns; "vertical area sources not exported".
    https://doku.datakustik.com/CadnaA/en/Export_QSI.html
  - G&P (Swiss CadnaA) QSI export page — absolute-height ("Oberkanten")
    convention, metre units, multi-receiver expansion.
    http://slip.gundp.ch/doc/G/QNNC4BFN5CY.htm
  - Austrian BMK/BMIMI "QSI-Datenschnittstelle … CNOSSOS-AT in
    Erweiterung der DIN 45687" (2021) — confirms the INI-style
    `<name>.qsi` master file with `[Meta]`, the `fmt*` keyword family,
    `YOffset`, `epsg=<code>`; names "Dokumentation 1 –
    QSI-Datenschnittstelle – DIN 45687" as the base spec and lists
    DataKustik / Wölfel / SoundPLAN as joint authors.
    https://www.bmimi.gv.at/dam/jcr:7d7773a4-136a-49ae-9dad-01071390d5eb/QSI-Datenschnittstelle_UA.pdf
  - DIN 45687 Beiblatt 1 (2006-04), *"QSI-Dataformat and QSI-Model-
    File"* — the purchasable format-spec supplement.
    https://www.dinmedia.de/en/draft-technical-rule/din-45687-beiblatt-1/87754398
  - Wölfel blog — DIN 45687 becoming a national supplement to DIN ISO
    17534-1; QSI format fundamentals moving to DIN/TR 8998-1.
    https://www.woelfel.de/en/blog/article-view/new-quality-assurance-rules-for-noise-prediction-software.html

  Note: the per-file **DBF column schemas** (field names/types, the
  source→spectrum foreign key, the `_SPEC.DBF` band layout) are *not*
  reproduced anywhere freely online — they live in the purchased DIN
  45687 Beiblatt 1 / Dokumentation 1, or can be read straight off a
  sample QSI dataset. No open-source QSI reader/writer exists.

Note: SoundPLAN's native binary project / Geo-Database format is not
publicly documented; this research deliberately targets the documented
*import* paths (shapefile / ASCII / Excel / QSI / DGM grids) rather than
reverse-engineering the native project file, which would be fragile and
version-dependent.

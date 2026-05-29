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
   workflow.

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
3. **(New) Which target first** — the shapefile bundle (recommended,
   ~1 day, low risk) or invest in a QSI/DIN-45687 exporter (higher
   fidelity, single-file model exchange, but needs the DIN standard and
   is a multi-day effort)?

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

Note: SoundPLAN's native binary project / Geo-Database format is not
publicly documented; this research deliberately targets the documented
*import* paths (shapefile / ASCII / Excel / QSI / DGM grids) rather than
reverse-engineering the native project file, which would be fragile and
version-dependent.

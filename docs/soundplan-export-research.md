# SoundPLAN export — feasibility research (#19)

Question: can BESSTY export a project (sources, receivers, calculation
area, topography, settings) in a form SoundPLAN can ingest, so a user
can cross-check / continue work in SoundPLAN?

Short answer: **Yes for the geometry + source data, via a bundle of
shapefiles (+ an ASCII/GeoTIFF DGM). No for a one-click "open this as a
SoundPLAN project" file** — SoundPLAN's native project format (`.spb`
project folders, the binary Geo-Database) is proprietary and
undocumented, so we don't write it directly. We hand SoundPLAN the
ingredients it already knows how to import; the user runs SoundPLAN's
import wizard once.

This matches how every other package (CadnaA, IMMI, Predictor) exchanges
with SoundPLAN — nobody writes each other's native project files; they
exchange shapefiles + DXF + ASCII grids.

## What SoundPLAN can import (confirmed from vendor + general GIS docs)

SoundPLAN's **Geo-Database** is the central store for geometry +
acoustics (point/line/area sources, receivers, buildings, barriers,
DGM). It imports via a mapping wizard from:

| Format | Used for |
|---|---|
| **Shapefile (.shp + .dbf + .shx + .prj)** | point sources, receivers, buildings, barriers, contour lines — with an attribute table the wizard maps onto SoundPLAN object fields |
| **DXF** | CAD geometry (contours, spot heights, footprints) |
| **ASCII / text (X Y Z, or tabular)** | spot heights, coordinate lists, tabular attributes |
| **Excel** | tabular attribute data |
| **ESRI/ASCII grid + DXF contours** | DGM (digital ground model) elevation |

The import wizard lets you map source-file attribute columns → SoundPLAN
object properties, **including sound-power levels and per-band spectra**.
That attribute-mapping step is the linchpin that makes this feasible.

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

**The octave-band columns are the crux.** SoundPLAN works natively in
octave bands 63 Hz – 8 kHz (8 bands). BESSTY stores spectra in either
octave (10 bands, 16 Hz – 8 kHz) or 1/3-octave (31 bands). On export we:

- Fold 1/3-octave → octave by energy summation (we already have
  `foldThirdsToOctave` in `catalog.ts`).
- Drop the 16 Hz and 31.5 Hz octave bands (outside SoundPLAN's standard
  63–8k industrial range) OR carry them as `LW16` / `LW31` extra columns
  if the user wants the low-frequency content — SoundPLAN can be
  configured for extended bands but the default is 63–8k. Recommend a
  toggle on export ("include 16/31.5 Hz LF bands").
- Emit **un-weighted Lw** per band (SoundPLAN expects Lw; it applies
  A-weighting internally). This is exactly the `Z`-weighted internal
  representation our solver already uses — no conversion needed beyond
  the band fold. (Reassuringly, this is also why the DΩ=0 default we
  set during validation matters: SoundPLAN won't add the +3 dB either.)

DBF field-name limit (10 chars) and field-count limit (255) are both
fine for 8–10 band columns + a handful of metadata columns.

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
   - `sources.shp/.dbf/.shx/.prj`
   - `receivers.shp/...`
   - `calc_area.shp/...`
   - `barriers.shp/...` (if any)
   - `dem.asc` (or the original `.tif`)
   - `README_soundplan.txt`
2. Reuse `spectrumFor` / `foldThirdsToOctave` to get per-source octave
   Lw in SoundPLAN's 63–8k convention.
3. Reproject lat/lng → the project's projected CRS via the existing
   `proj4` setup (`lib/projections.ts`).
4. Wire a "Export → SoundPLAN bundle (.zip)" button into the side
   panel's export section.

Estimated effort: **~1 day**. The shapefile writer + projection +
spectrum-fold are all already in the codebase; the new work is the
attribute schema, the ASCII-grid DEM writer, the README generator, and
the zip bundling.

## Recommendation

**Feasible and worth doing.** Build the shapefile-bundle exporter. It's
a high-value interoperability feature for a consultancy that cross-
checks against SoundPLAN, the format risk is low (shapefile + ASCII grid
are stable, decades-old, well-understood), and most of the hard parts
(shapefile writing, reprojection, spectrum folding) already exist in
BESSTY.

Two open questions to confirm with the user before building:
1. **Octave vs 1/3-octave export** — default to octave 63–8k
   (SoundPLAN's industrial norm), with an optional "include 16/31.5 Hz"
   toggle? Or export 1/3-octave when the source data is 1/3-octave?
2. **WTG sources** — export the effective Lw at the scenario wind speed
   (cross-check path), or also emit a separate per-wind-speed table for
   users who want SoundPLAN to interpolate? The former is simpler and
   covers the main use case.

## Sources consulted

- SoundPLAN vendor material on the Geo-Database + data exchange
  (import/export of SHP, DXF, ASCII, Excel; attribute mapping wizard).
- General GIS references on the ESRI shapefile / DBF 10-char field-name
  limit (drives the short `LW63`… column naming).
- Cross-package practice (CadnaA ↔ SoundPLAN exchange via shapefile/DXF/
  ASCII rather than native project files).

Note: SoundPLAN's exact native binary formats (`.spb` project, the
Geo-Database internal structure) are not publicly documented; this
research deliberately targets the documented *import* path rather than
attempting to reverse-engineer the native project file, which would be
fragile and version-dependent.

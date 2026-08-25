---
title: Wind-speed sweep
section: Studies
---

Re-solves the whole project at each wind speed and keeps every result, so the worst case can be **found** rather than assumed. Open it from **Results → Wind-speed sweep**.

Two things move with wind speed, and they rarely peak together:

- **The sound power** of every turbine, from its catalog spectra.
- **The limit**, when wind-speed limit tables are switched on.

A project can therefore comply comfortably at 8 m/s, fail at 10, and comply again at 12. Assessing one wind speed says nothing about the one next to it, which is what this exists to fix.

## Not the same trick as the curtailment optimiser

The optimiser reduces one solve to a transfer matrix and evaluates thousands of schedules as arithmetic. That is exact, but only because the geometry is fixed and sound power is the only thing moving.

The sweep re-solves the scene at every wind speed instead. It costs N solves rather than one, and in exchange every number in the export came out of the engine rather than out of a model of the engine — which is what a compliance table has to be able to say.

## Setting up a run

- **Periods** — day, evening, night, in any combination. Periods whose sources resolve to the **same modes** share one solve, so a project that does not use per-period modes costs one solve per wind speed, not three.
- **Wind speeds** — whole m/s. When the window opens it offers the speeds every turbine's catalog covers (the intersection: a speed one turbine has no spectrum for cannot honestly be swept). With no turbine data, and wind-speed limits switched on, it offers the speeds your limit tables name instead.

  You can type any speeds you like. One outside a turbine's catalog data is solved at the nearest speed that data *does* cover, which is an extrapolation — the run says so in its notes, and the note travels into the XLSX.
- **Receivers** and **Contour grids** — either or both.

The Run button states the number of solves before you start it. Contour grids are the expensive half: each one is a full grid at the map's current spacing, once per wind speed and period.

## While it runs

The map's automatic regrid stands down for the duration, and so does the **Run grid** button. Grid solves are newest-wins across a shared pool of workers, so a background regrid landing between two sweep states would kill the run; holding both off is what stops that. When the sweep ends, the map catches up on anything edited meanwhile.

**Cancel** stops the sweep, and closing the window — or navigating away from the project — cancels it too. A cancelled sweep keeps nothing: a table missing the wind speeds it never reached is worse than no table.

Cancelling ends a contour grid immediately, because a grid's workers are terminated outright. A receiver solve already in flight finishes first — those take seconds, not minutes — and the sweep then stops before the next one.

If something else does manage to start a grid while the sweep's own grid is running, the sweep stops and says so rather than quietly returning a partial answer.

## Reading the table

Cells show the **margin** to the limit in dB: positive is under, negative (and red) is over. Hover a cell for the level and the limit behind it. The **Worst** column is the wind speed with the least margin, which is the answer the sweep was run to get.

## Export

**Receivers → XLSX.** One sheet per period, each holding three stacked blocks of receiver rows × wind-speed columns — level, limit, margin — then a summary naming each receiver's worst wind speed and every speed it fails at.

Three blocks rather than a colour-coded single table for two reasons: the spreadsheet writer here does not produce cell styling, so a "conditional format" would be a formula whose inputs you could not see; and with limit tables in use the **limit** varies along the row too, which a single table has nowhere to show.

**Grids → shapefile / KML / GeoTIFF.** Contours are traced at the levels currently on screen, and custom lines ride along when their own export flag is set.

- **Shapefile** — one zip, every feature attributed `WS_MS`, `PERIOD`, `THRESH_DB` and `LABEL`, so you can open the whole sweep and filter to what you need.
- **KML** — the same content with one folder per period and wind speed. Only the first folder is visible on load; forty contour sets drawn at once is not a map.
- **GeoTIFF** — one raster per state in a zip (`grid_ws08_night.tif`). Periods that shared a solve produce identical files; both are written, because a missing file reads as a failed solve.

The **XLSX** carries a settings sheet recording what the run assumed — speeds, periods, spacing, weighting, limit comparison, and any notes the run raised. The shapefile and KML tag every feature with the wind speed, period and level that produced it, but record no settings; the GeoTIFF zip carries only its filenames. Send the XLSX alongside them if the assumptions need to travel.

Exports describe the project **as it was when the sweep ran**. Edit a limit afterwards and the table on screen keeps the run's own limits, so it cannot show old levels judged against new limits — but the run does become stale, and the window says so. Re-run before relying on it.

## What the sweep does not do

**Wind direction is not modelled.** Every receiver is treated as downwind of every source at every wind speed, which is what ISO 9613-2 does and what the rest of BESSTY reports. The directional correction lives in the curtailment optimiser alone — see the **Curtailment optimiser** page.

Levels are **assessed** levels: the solved level plus any tonality penalty, i.e. the number each pass/fail verdict is made on.

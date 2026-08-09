---
title: Modes per period
section: Building a model
---

Day, evening and night carry different limits, and plant is often run differently under each — a BESS dropped to a low-noise fan curve after 10pm, turbines curtailed overnight. Switch on **Modes per day / evening / night** in Settings → Calculation to set a mode per period instead of one mode for the whole project.

It is off by default, and while it is off nothing changes: every mode dropdown is the single dropdown it has always been.

## Setting them

With the setting on, every mode picker — a source's own row, the bulk "change mode to" editor, and a BESS wizard segment — gains a **D/E/N** button. Expand it for three dropdowns. Set one and the others keep the mode they were already on; set all three to the same value and it folds back to a plain single mode.

A segment whose mode varies shows it on its chip, so you don't have to open the editor to see which rows are curtailed.

## Off

Each dropdown also offers **Off**, meaning the source is not running in that period. It is dropped from the scene entirely — it contributes nothing, screens nothing and reflects nothing — and its marker greys and is struck through when the period on screen is one it is off in.

One approximation to know about: for a BESS modelled with containers, the box is dropped along with the source, so a parked unit stops screening its neighbours. That errs on the loud side.

## What gets solved

Only the period selected on the Sources tab is solved on screen. Three sets of contours and three levels per marker is more than a map can carry, so the display stays on one period and you switch between them.

Switching period only re-solves when a mode actually differs, so on a project that doesn't use per-period modes it costs nothing.

## What gets exported

The **receiver totals** export covers all three periods regardless: `level_day`, `level_evening` and `level_night`, each judged against its own limit. Beside them, `assessed_day/evening/night` carry each period's level *plus its own tonality penalty* — the number the verdict actually compared — so a night fail caused by a tone that only appears in the night mode is explainable from the row. If the modes are the same in every period the columns simply repeat one solve.

Per-source contributions and per-band spectra stay on the selected period — tripling them would triple the longest sheets in the workbook — and each now carries a leading `period` column saying which one it is. The source shapefile gains `MODE_DEN` alongside `MODE`, spelling out all three.

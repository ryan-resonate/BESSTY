---
title: Results and exports
section: Reference
---

**Run grid** computes the contour raster, showing live progress with a Cancel button. Receiver totals, per-source contributions and per-band spectra all export to CSV or XLSX. Contour lines export to KML or shapefile, and the raster to GeoTIFF. **Export PDF** produces a map with the basemap as an image and the contours, receivers and sources drawn as vectors.

## Approximations

When a solve applies an approximation — clustering distant sources, resampling terrain coarser than the DEM, dropping contributions past the cutoff — the results dock shows a row saying so. Amber means it can move levels; grey means it only bounded a resource. A clean solve shows nothing at all.

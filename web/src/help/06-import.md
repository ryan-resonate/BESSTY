---
title: Importing data
section: Building a model
---

The Import tab accepts CSV, KML and shapefile (.zip). The dialog asks which kind to import as (receivers, WTGs, BESS, auxiliary) and lets you map columns to project fields. CSV and shapefiles without a .prj accept any registered projected CRS; GeoTIFF DEMs likewise.

In the catalog editor you can also paste a spectrum straight from Excel: click the first band cell and press Ctrl+V. A copied row or column both work; a two-dimensional block is rejected rather than guessed at.

When importing a catalog spreadsheet you are asked whether the per-band levels are A-weighted or Z-weighted. The wrong answer shifts every propagated level by roughly 3 to 5 dB, so check the datasheet.

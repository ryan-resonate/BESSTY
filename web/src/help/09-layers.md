---
title: Layers
section: Reference
---

Toggle base map (satellite or OSM), contour mode (filled, lines, both), palette and step, receiver limit labels, and a debug overlay painting every grid cell centre — useful when checking alignment against another tool.

Min and Max drive both the contour thresholds and the filled colour scale. **Auto-fit** clamps them to the current grid's measured range.

## Custom lines

Named iso-lines at levels you choose — a night limit, a boundary criterion — each with its own colour, width and dash. They are traced in the same pass as the stepped contours, so a level off the step grid (37.5 dB) costs nothing extra and does not add a step at that level.

Custom lines are compliance artefacts rather than presentation, so they keep drawing when the contour grid is switched off, and they carry their name rather than their level as the label. Tick **Export** to include a line in the KML, shapefile and PDF; in the shapefile the name lands in a `LABEL` attribute beside `THRESH_DBA`, so stepped contours and named lines can be told apart downstream.

A line whose level the grid never reaches simply does not appear — including in the PDF legend, which only lists lines that were actually drawn.

Display settings are saved on the project, so reopening restores the view you left and a colleague opening the same project sees the same presentation. The debug overlay is deliberately not saved.

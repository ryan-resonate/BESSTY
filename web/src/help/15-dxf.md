---
title: DXF drawings
section: Building a model
---

**Import → Import DXF…** reads a site layout from a CAD drawing, so walls and site context come straight from the civil drawing rather than being traced by eye.

ASCII DXF only, up to 50 MB. If the file is binary, re-save it as ASCII DXF. Lines, polylines, arcs, circles, text and block references are read; block content is expanded through its rotation and scale. Everything else — splines, hatches, dimensions — is listed in the dialog and skipped, so you can see what was left behind.

## Units

A DXF often mis-states its units, and reading a millimetre drawing as metres makes the site 1000 times too big while still looking perfectly well drawn. Rather than asking which units the file uses, the dialog shows **how big your site would be under each reading** — the right one should look like your site. Sizes that could not be a site are flagged in red.

The drawing's own `$INSUNITS` is preselected when it gives a plausible answer, otherwise metres, otherwise millimetres.

## Coordinate system

DXF stores no coordinate system at all, so pick the one the drawing was set out in — usually the MGA zone for the site. The map flies to the imported geometry as soon as you import, so a wrong choice is obvious immediately rather than being discovered later.

Drawings on a local site grid (not real-world coordinates) cannot be placed automatically.

## Layers

Each layer maps to one of three things:

- **Reference** — drawn on the map, never affects levels. The default for everything, because importing a drawing should not silently add objects that change your results.
- **Walls** — becomes barriers, which screen sound. Give the layer a height. If its polylines carry Z values, you can instead treat Z as an absolute top level, and the terrain under each vertex is subtracted to get the height above ground.
- **Skip** — ignored.

Text on an imported layer becomes labelled points. The whole import lands as one step, so Ctrl+Z undoes all of it.

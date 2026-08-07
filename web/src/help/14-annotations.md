---
title: Annotations
section: Building a model
---

Drawing furniture for the figure: notes explaining something, and dimensions showing how far apart two things are. Neither reaches the solver — they carry no height and screen nothing.

Add them from **Layers → Annotations**.

- **Note** — click the map to place it, then type the text in the side panel. Drag it anywhere. **Add leader** gives it a pointer line with a draggable dot at its far end: put the dot on whatever the note describes. The leader meets the note at whichever edge faces the dot, so it never runs through the words, and that attachment follows the note as you drag it. Notes may span several lines.

- **Dimension** — click two points. It reads the distance between them automatically, to one decimal below a kilometre. Drag either end to adjust. Type in the label field to override the measurement with a nominal figure such as "6 m min."; clear the field to go back to the measured value.

Click a note or a dimension to select it; **Delete** or **Backspace** removes it. Esc clears the selection.

Text is black with a white buffer so it stays readable over satellite imagery, and dimension labels rotate to lie along their own line.

## In the PDF

Annotations export at **9 pt**, and can be switched off for a particular export in the PDF dialog. The whole figure — annotations, receiver levels, legend, title — is set in Arimo, which carries Arial's metrics exactly, so text occupies the same width it would in Arial and matches the rest of a report pack.

Annotations are part of the project, not a display preference: a colleague opening the same project sees them, and placing or moving one can be undone with Ctrl+Z.

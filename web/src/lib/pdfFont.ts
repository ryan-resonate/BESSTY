// House typeface for the PDF export.
//
// Resonate's drawings are set in Arial, and appearance matters — the exported
// figure should look like the rest of the report pack, not like a different
// document. Arial cannot be embedded (licensed), so we embed **Arimo**: the
// metric-compatible substitute with identical advance widths, so a string
// occupies exactly the width Arial would, and near-identical letterforms.
//
// The two faces are ~22 kB each of TrueType (~43 kB as base64). They are
// imported dynamically so they land in the PDF export's chunk rather than the
// main bundle — nobody who never exports a PDF should download a font.

import type { jsPDF } from 'jspdf';

/// Font family name to pass to `doc.setFont`. Registered under a single family
/// with `normal` and `bold` faces, so `setFont(PDF_FONT, 'bold')` works the way
/// it does for the built-ins.
export const PDF_FONT = 'Arimo';

/// Cached so a second export in the same session doesn't re-parse the base64.
let loaded: Promise<{ regular: string; bold: string }> | null = null;

function load() {
  if (!loaded) {
    loaded = import('./pdfFont.generated').then((m) => ({
      regular: m.ARIMO_REGULAR_B64,
      bold: m.ARIMO_BOLD_B64,
    }));
  }
  return loaded;
}

/// Register Arimo on `doc` and make it the active font.
///
/// Returns false when registration failed, having left the document on its
/// default Helvetica — a PDF in the wrong typeface beats no PDF at all, and
/// Helvetica shares Arial's metrics closely enough that nothing reflows.
export async function useHouseFont(doc: jsPDF): Promise<boolean> {
  try {
    const { regular, bold } = await load();
    doc.addFileToVFS('Arimo-Regular.ttf', regular);
    doc.addFont('Arimo-Regular.ttf', PDF_FONT, 'normal');
    doc.addFileToVFS('Arimo-Bold.ttf', bold);
    doc.addFont('Arimo-Bold.ttf', PDF_FONT, 'bold');
    doc.setFont(PDF_FONT, 'normal');
    return true;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn('house font unavailable, falling back to Helvetica:', e);
    return false;
  }
}

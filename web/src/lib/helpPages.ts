// I11 — the built help corpus.
//
// Isolated from `helpContent.ts` because `import.meta.glob` is a Vite build
// transform with no runtime equivalent: anything importing it cannot be loaded
// by plain node, which would put the markdown parser out of reach of the tests.
// Parsing lives there; only the glob lives here.

import { toHelpPage, type HelpPage } from './helpContent';

const MODULES = import.meta.glob('../help/*.md', {
  query: '?raw', import: 'default', eager: true,
});

/// Every help page, ordered by filename — the numeric prefix is the running
/// order, so renaming a file re-orders the nav without touching code.
export const HELP_PAGES: HelpPage[] = Object.entries(MODULES)
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([path, raw]) => toHelpPage(path, raw as string));

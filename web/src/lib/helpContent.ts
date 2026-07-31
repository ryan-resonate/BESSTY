// I11 — help content: markdown in the repo, indexed for search.
//
// Pages live in `src/help/*.md` with YAML-ish front matter for title/section.
// Vite inlines them at build time (`?raw`), so there's no fetch, no network
// failure mode, and the content ships with the app it documents.
//
// The markdown subset is rendered by `renderMarkdown` below rather than pulling
// in a parser dependency. It covers what the help actually uses — headings,
// paragraphs, lists, tables, code spans, bold, links — and deliberately does
// NOT support raw HTML, which is also why it's safe to render without a
// sanitiser: nothing in the pipeline can emit an element the renderer didn't
// construct itself.

export interface HelpPage {
  id: string;
  title: string;
  section: string;
  body: string;
  /// Plain text, for the search index.
  text: string;
}

interface FrontMatter { title: string; section: string; body: string }

/// Split `---\nkey: value\n---\n` front matter off the top of a document.
export function parseFrontMatter(raw: string): FrontMatter {
  const norm = raw.replace(/\r\n?/g, '\n');
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(norm);
  if (!m) return { title: 'Untitled', section: 'Reference', body: norm.trim() };
  const meta: Record<string, string> = {};
  for (const line of m[1].split('\n')) {
    const i = line.indexOf(':');
    if (i <= 0) continue;
    meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return {
    title: meta.title ?? 'Untitled',
    section: meta.section ?? 'Reference',
    body: norm.slice(m[0].length).trim(),
  };
}

/// Strip markdown to plain words, for indexing and snippets.
export function toPlainText(md: string): string {
  return md
    .replace(/`{1,3}[^`]*`{1,3}/g, ' ')
    .replace(/^[|\-: ]+$/gm, ' ')
    .replace(/[|#>*_]/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/// Build a page from its raw file contents. Kept separate from the Vite glob
/// (see `helpPages.ts`) so the parsing is testable in plain node —
/// `import.meta.glob` is a Vite transform and does not exist at runtime.
export function toHelpPage(path: string, raw: string): HelpPage {
  const fm = parseFrontMatter(raw);
  return {
    id: (path.split('/').pop() ?? path).replace(/\.md$/, ''),
    title: fm.title,
    section: fm.section,
    body: fm.body,
    text: toPlainText(fm.body),
  };
}

/// Pages grouped by section, preserving page order within each.
export function helpSections(pages: HelpPage[]): Array<{ section: string; pages: HelpPage[] }> {
  const out: Array<{ section: string; pages: HelpPage[] }> = [];
  for (const p of pages) {
    let g = out.find((x) => x.section === p.section);
    if (!g) { g = { section: p.section, pages: [] }; out.push(g); }
    g.pages.push(p);
  }
  return out;
}

// ------------------------------------------------------------------ rendering

type Node =
  | { t: 'h'; level: number; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul'; items: string[] }
  | { t: 'ol'; items: string[] }
  | { t: 'table'; head: string[]; rows: string[][] };

/// Parse the supported markdown subset into a node list. Exported for testing —
/// the renderer component just maps nodes to elements.
export function parseMarkdown(md: string): Node[] {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const out: Node[] = [];
  let i = 0;
  const isTableRow = (s: string) => s.trim().startsWith('|') && s.trim().endsWith('|');
  const cells = (s: string) => s.trim().slice(1, -1).split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i++; continue; }

    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) { out.push({ t: 'h', level: h[1].length, text: h[2].trim() }); i++; continue; }

    // Table: a header row, a separator, then body rows.
    if (isTableRow(line) && i + 1 < lines.length && /^\|[\s\-:|]+\|$/.test(lines[i + 1].trim())) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && isTableRow(lines[i])) { rows.push(cells(lines[i])); i++; }
      out.push({ t: 'table', head, rows });
      continue;
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, '').trim());
        i++;
      }
      out.push({ t: 'ul', items });
      continue;
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, '').trim());
        i++;
      }
      out.push({ t: 'ol', items });
      continue;
    }

    // Paragraph: consume until a blank line or the start of another block.
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== ''
           && !/^(#{1,4})\s+/.test(lines[i])
           && !/^\s*[-*]\s+/.test(lines[i])
           && !/^\s*\d+\.\s+/.test(lines[i])
           && !isTableRow(lines[i])) {
      para.push(lines[i].trim());
      i++;
    }
    if (para.length) out.push({ t: 'p', text: para.join(' ') });
  }
  return out;
}

export type { Node as HelpNode };

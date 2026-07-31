// I11 — help browser: nav + search + rendered markdown.
//
// Used in two places with identical content: inside a FloatingWindow over a
// running project, and full-page on the /help route. One component, so the two
// can never drift.

import { useMemo, useState, type ReactNode } from 'react';
import MiniSearch from 'minisearch';
import { helpSections, parseMarkdown, type HelpPage } from '../lib/helpContent';
import { HELP_PAGES } from '../lib/helpPages';

/// Inline markdown: `code`, **bold**, [text](href). Returns React nodes rather
/// than HTML, so nothing can inject markup.
function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\[[^\]]+\]\([^)]+\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    const key = `${keyBase}-${k++}`;
    if (tok.startsWith('`')) {
      out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('**')) {
      out.push(<b key={key}>{tok.slice(2, -2)}</b>);
    } else {
      const lm = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok)!;
      out.push(<a key={key} href={lm[2]}>{lm[1]}</a>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function Markdown({ md }: { md: string }) {
  const nodes = useMemo(() => parseMarkdown(md), [md]);
  return (
    <>
      {nodes.map((n, i) => {
        const key = `n${i}`;
        switch (n.t) {
          case 'h': {
            const Tag = (`h${Math.min(6, n.level + 1)}`) as 'h2';
            return <Tag key={key}>{inline(n.text, key)}</Tag>;
          }
          case 'p':
            return <p key={key}>{inline(n.text, key)}</p>;
          case 'ul':
            return <ul key={key}>{n.items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}</ul>;
          case 'ol':
            return <ol key={key}>{n.items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>)}</ol>;
          case 'table':
            return (
              <div key={key} style={{ overflowX: 'auto' }}>
                <table className="help-table">
                  <thead>
                    <tr>{n.head.map((h, j) => <th key={j}>{inline(h, `${key}-h${j}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {n.rows.map((r, j) => (
                      <tr key={j}>{r.map((c, l) => <td key={l}>{inline(c, `${key}-${j}-${l}`)}</td>)}</tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
        }
      })}
    </>
  );
}

/// Built once — the corpus is static, so rebuilding per keystroke would be
/// pure waste.
function buildIndex(pages: HelpPage[]) {
  const ms = new MiniSearch<HelpPage>({
    fields: ['title', 'section', 'text'],
    storeFields: ['id', 'title', 'section'],
    searchOptions: { boost: { title: 3, section: 2 }, prefix: true, fuzzy: 0.2 },
  });
  ms.addAll(pages);
  return ms;
}

export function HelpContent({ compact = false }: { compact?: boolean }) {
  const pages = HELP_PAGES;
  const index = useMemo(() => buildIndex(pages), [pages]);
  const [query, setQuery] = useState('');
  const [activeId, setActiveId] = useState(pages[0]?.id ?? '');

  const hits = useMemo(() => {
    const q = query.trim();
    if (!q) return null;
    const ids = new Set(index.search(q).map((r) => r.id as string));
    return pages.filter((p) => ids.has(p.id));
  }, [query, index, pages]);

  const active = pages.find((p) => p.id === activeId) ?? pages[0];
  const navPages = hits ?? pages;

  return (
    <div style={{
      display: 'flex', gap: 12, alignItems: 'stretch',
      height: compact ? '100%' : 'auto', minHeight: 0,
    }}>
      <nav style={{
        flex: '0 0 auto', width: compact ? 170 : 220,
        borderRight: '1px solid rgba(0,0,0,.12)', paddingRight: 10,
        overflowY: 'auto', minHeight: 0,
      }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search help…"
          style={{ width: '100%', marginBottom: 8 }}
          aria-label="Search help"
        />
        {hits && hits.length === 0 && (
          <div className="hint">No matches for “{query}”.</div>
        )}
        {helpSections(navPages).map((g) => (
          <div key={g.section} style={{ marginBottom: 10 }}>
            <div style={{
              fontSize: 10, textTransform: 'uppercase', letterSpacing: '.06em',
              color: 'var(--ink-soft, #475569)', marginBottom: 4,
            }}>{g.section}</div>
            {g.pages.map((p) => (
              <button
                key={p.id}
                className={`btn small block${p.id === active?.id ? ' on' : ''}`}
                style={{ textAlign: 'left', marginBottom: 2 }}
                onClick={() => setActiveId(p.id)}
              >{p.title}</button>
            ))}
          </div>
        ))}
      </nav>

      <article className="help-body" style={{ flex: 1, minWidth: 0, overflowY: 'auto' }}>
        {active && (
          <>
            <h2 style={{ marginTop: 0 }}>{active.title}</h2>
            <Markdown md={active.body} />
          </>
        )}
      </article>
    </div>
  );
}

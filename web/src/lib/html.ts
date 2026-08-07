// Escaping for the few places user text is interpolated into raw HTML.
//
// React escapes everything it renders, so almost nothing in BESSTY needs this.
// Leaflet's `divIcon` is the exception: it takes an HTML STRING and assigns it
// to innerHTML, so any user-typed value interpolated into one — a custom
// contour line's name, an annotation's text — arrives unescaped.

/// Escape the five characters that can break out of HTML text or an attribute
/// value. Quotes are included because the same helper is used for both
/// positions, and getting that wrong in an attribute is the easier mistake.
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => (
    c === '&' ? '&amp;'
      : c === '<' ? '&lt;'
        : c === '>' ? '&gt;'
          : c === '"' ? '&quot;'
            : '&#39;'
  ));
}

/// A colour safe to drop into a `style="…"` attribute.
///
/// Escaping is NOT enough inside a style attribute: even with quotes escaped, a
/// value like `red;background:url(…)` injects a declaration, and CSS has its
/// own escape rules. So this allows only the shape the colour pickers produce —
/// `#rgb` / `#rrggbb` — and substitutes a default for anything else.
///
/// Colours come off the project document, which a collaborator can write and
/// which no migration validates, so "the UI only ever writes a hex string" is
/// not something this can rely on.
export function safeCssColor(value: unknown, fallback = '#1f2937'): string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value.trim())
    ? value.trim()
    : fallback;
}

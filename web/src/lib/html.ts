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

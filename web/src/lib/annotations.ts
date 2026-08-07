// Annotation helpers shared by the map and the PDF.
//
// The map draws with Leaflet and the PDF with jsPDF, but both need the same
// answers — what a dimension reads, where its label sits, how a new one is
// named. Keeping that here is what stops the figure on screen and the figure in
// the report from quietly disagreeing.

import { approxDistanceM } from './geo';
import type { Annotation, DimensionAnnotation, TextAnnotation } from './types';

/// House text colour for annotations: black, per Resonate's drawing standard.
export const ANNOTATION_INK = '#000000';

/// Text size on the PDF, in points. Ryan's default for drawing annotation.
export const ANNOTATION_PT = 9;

/// Monotonic within the page session. Randomness alone is not enough: four
/// base-36 characters is 1.7 M values, and by the birthday bound a few hundred
/// annotations placed in one millisecond collide about 7 % of the time — two
/// annotations sharing an id would drag, edit and delete as one.
let annotationSeq = 0;

export function newAnnotationId(): string {
  annotationSeq += 1;
  // Counter rules out collisions within a session; the timestamp and the random
  // tail rule them out between sessions, including two tabs on one project.
  return `an-${Date.now().toString(36)}-${annotationSeq.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/// What a dimension annotation reads. An explicit `label` wins so a nominal
/// figure ("6 m min.") can override the measurement; otherwise the geodesic
/// distance, to one decimal below a kilometre and two above it.
export function dimensionLabel(d: DimensionAnnotation): string {
  if (d.label != null && d.label !== '') return d.label;
  const m = approxDistanceM(d.from, d.to);
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${m.toFixed(1)} m`;
}

/// Midpoint of a dimension, where its label goes.
export function dimensionMidpoint(d: DimensionAnnotation): [number, number] {
  return [(d.from[0] + d.to[0]) / 2, (d.from[1] + d.to[1]) / 2];
}

/// Screen-space angle of a dimension in degrees, COUNTERCLOCKWISE from east —
/// the convention jsPDF's `angle` uses, so a label rotated by it lies along its
/// own line. Kept in the range (-90, 90] so text is never upside down.
///
/// Note the sign: north is UP on screen, so increasing latitude is decreasing
/// screen y, and a counterclockwise angle is `atan2(+Δlat, Δx)`. Negating that
/// mirrors every sloped label about the horizontal — it still looks tidy in
/// isolation, which is why only rendering a descending line reveals it.
///
/// `latScale` compensates for the meridian convergence that makes a degree of
/// longitude shorter than a degree of latitude away from the equator — without
/// it a line drawn at 45° on screen would be labelled at some other angle.
export function dimensionTiltDeg(d: DimensionAnnotation): number {
  const latScale = Math.cos((d.from[0] * Math.PI) / 180);
  const dLat = d.to[0] - d.from[0];
  const dx = (d.to[1] - d.from[1]) * latScale;
  const deg = (Math.atan2(dLat, dx) * 180) / Math.PI;
  if (deg > 90) return deg - 180;
  if (deg <= -90) return deg + 180;
  return deg;
}

/// Every point an annotation occupies, for hit-testing and bounds.
export function annotationPoints(a: Annotation): Array<[number, number]> {
  return a.kind === 'text'
    ? (a.leaderTo ? [a.latLng, a.leaderTo] : [a.latLng])
    : [a.from, a.to];
}

/// Guard for reading annotations off a project document: a hand-edited or
/// partially-written array must not crash the map.
export function validAnnotation(a: Annotation | undefined | null): a is Annotation {
  if (!a || typeof a.id !== 'string') return false;
  const ok = (p: unknown): boolean =>
    Array.isArray(p) && p.length === 2
    && Number.isFinite(p[0]) && Number.isFinite(p[1]);
  // The payload is checked as well as the geometry. A missing `text` makes the
  // editor's textarea flip from controlled to uncontrolled on the first
  // keystroke, and a non-string `label` reaches `doc.text()`, which throws and
  // takes the whole PDF export with it.
  if (a.kind === 'text') {
    return typeof a.text === 'string'
      && ok(a.latLng)
      && (a.leaderTo === undefined || ok(a.leaderTo));
  }
  if (a.kind === 'dimension') {
    return (a.label === undefined || typeof a.label === 'string') && ok(a.from) && ok(a.to);
  }
  return false;
}

export function annotationsOf(project: { annotations?: Annotation[] }): Annotation[] {
  return (project.annotations ?? []).filter(validAnnotation);
}

export function isText(a: Annotation): a is TextAnnotation {
  return a.kind === 'text';
}

export function isDimension(a: Annotation): a is DimensionAnnotation {
  return a.kind === 'dimension';
}

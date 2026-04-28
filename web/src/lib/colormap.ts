// Perceptually-uniform colormaps. Viridis is the default — it prints well,
// is colour-blind-friendly, and avoids the misleading "everything red = bad"
// connotation of traffic-light palettes.

export type Palette = 'viridis' | 'magma' | 'plasma' | 'inferno' | 'rdylgn' | 'grey';

// 5-stop control points; we linear-interpolate between them.
const STOPS: Record<Palette, Array<[number, number, number]>> = {
  viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
  magma:   [[0, 0, 4], [59, 15, 112], [140, 41, 129], [222, 73, 104], [252, 253, 191]],
  plasma:  [[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 148, 65], [240, 249, 33]],
  inferno: [[0, 0, 4], [66, 10, 104], [147, 38, 103], [221, 81, 58], [252, 255, 164]],
  rdylgn:  [[26, 152, 80], [166, 217, 106], [255, 255, 191], [253, 174, 97], [215, 48, 39]],
  grey:    [[245, 245, 245], [207, 207, 207], [158, 158, 158], [94, 94, 94], [31, 31, 31]],
};

/// Return `[r, g, b]` in 0..255 for a value `t` in [0, 1].
export function paletteRgb(palette: Palette, t: number): [number, number, number] {
  const stops = STOPS[palette];
  if (t <= 0) return stops[0];
  if (t >= 1) return stops[stops.length - 1];
  const scaled = t * (stops.length - 1);
  const i = Math.floor(scaled);
  const f = scaled - i;
  const a = stops[i];
  const b = stops[i + 1];
  return [
    Math.round(a[0] + (b[0] - a[0]) * f),
    Math.round(a[1] + (b[1] - a[1]) * f),
    Math.round(a[2] + (b[2] - a[2]) * f),
  ];
}

/// CSS color string for a palette stop.
export function paletteCss(palette: Palette, t: number): string {
  const [r, g, b] = paletteRgb(palette, t);
  return `rgb(${r}, ${g}, ${b})`;
}

/// Map a dB value to a palette parameter t in [0, 1] using the contour
/// band range as the domain. Values below `domainLo` clamp to 0; above
/// `domainHi` clamp to 1.
export function tForDb(db: number, domainLo = 25, domainHi = 60): number {
  return Math.max(0, Math.min(1, (db - domainLo) / (domainHi - domainLo)));
}

/// Build a set of human-readable contour bands spanning a dB range, snapped
/// to "nice" 5 dB boundaries so the legend reads cleanly regardless of
/// whether the data covers 25-50 or 60-110 dB.
export function makeBandsForRange(
  min: number,
  max: number,
): Array<{ lo: number; hi: number; label: string }> {
  if (!isFinite(min) || !isFinite(max) || max - min < 1) {
    return [
      { lo: 25, hi: 30, label: '25 – 30' },
      { lo: 30, hi: 35, label: '30 – 35' },
      { lo: 35, hi: 40, label: '35 – 40' },
      { lo: 40, hi: 45, label: '40 – 45' },
      { lo: 45, hi: 50, label: '45 – 50' },
    ];
  }
  // Snap to multiples of 5 dB.
  const lo = Math.floor(min / 5) * 5;
  const hi = Math.ceil(max / 5) * 5;
  // Aim for 5–8 bands; widen step if range is large.
  const span = hi - lo;
  const step = span <= 30 ? 5 : span <= 60 ? 10 : 15;
  const bands = [];
  for (let v = lo; v < hi; v += step) {
    bands.push({ lo: v, hi: v + step, label: `${v} – ${v + step}` });
  }
  return bands;
}

/// Compute a sensible min/max for the colormap given a Float32 grid of dB
/// values. Strips outliers and -∞ sentinels.
export function gridDomain(dbA: Float32Array): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < dbA.length; i++) {
    const v = dbA[i];
    if (!isFinite(v) || v < -100) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!isFinite(min) || !isFinite(max)) return { min: 25, max: 60 };
  return { min, max };
}

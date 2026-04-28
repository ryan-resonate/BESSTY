// Perceptually-uniform colormaps. Viridis is the default — it prints well,
// is colour-blind-friendly, and avoids the misleading "everything red = bad"
// connotation of traffic-light palettes.
// 5-stop control points; we linear-interpolate between them.
const STOPS = {
    viridis: [[68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37]],
    magma: [[0, 0, 4], [59, 15, 112], [140, 41, 129], [222, 73, 104], [252, 253, 191]],
    plasma: [[13, 8, 135], [126, 3, 168], [204, 71, 120], [248, 148, 65], [240, 249, 33]],
    inferno: [[0, 0, 4], [66, 10, 104], [147, 38, 103], [221, 81, 58], [252, 255, 164]],
    rdylgn: [[26, 152, 80], [166, 217, 106], [255, 255, 191], [253, 174, 97], [215, 48, 39]],
    grey: [[245, 245, 245], [207, 207, 207], [158, 158, 158], [94, 94, 94], [31, 31, 31]],
};
/// Return `[r, g, b]` in 0..255 for a value `t` in [0, 1].
export function paletteRgb(palette, t) {
    const stops = STOPS[palette];
    if (t <= 0)
        return stops[0];
    if (t >= 1)
        return stops[stops.length - 1];
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
export function paletteCss(palette, t) {
    const [r, g, b] = paletteRgb(palette, t);
    return `rgb(${r}, ${g}, ${b})`;
}
/// Map a dB value to a palette parameter t in [0, 1] using the contour
/// band range as the domain. Values below `domainLo` clamp to 0; above
/// `domainHi` clamp to 1.
export function tForDb(db, domainLo = 25, domainHi = 60) {
    return Math.max(0, Math.min(1, (db - domainLo) / (domainHi - domainLo)));
}
/// Build a set of human-readable contour bands spanning a dB range. Without
/// an explicit `step`, defaults to 5 dB. Snaps the lower bound to a 5 dB
/// boundary regardless of step so the legend reads cleanly.
export function makeBandsForRange(min, max, step) {
    if (!isFinite(min) || !isFinite(max) || max - min < 1) {
        return [
            { lo: 25, hi: 30, label: '25 – 30' },
            { lo: 30, hi: 35, label: '30 – 35' },
            { lo: 35, hi: 40, label: '35 – 40' },
            { lo: 40, hi: 45, label: '40 – 45' },
            { lo: 45, hi: 50, label: '45 – 50' },
        ];
    }
    const s = step && step > 0 ? step : 5;
    const lo = Math.floor(min / 5) * 5;
    const hi = Math.ceil(max / 5) * 5;
    const bands = [];
    for (let v = lo; v < hi; v += s) {
        bands.push({ lo: v, hi: v + s, label: `${v} – ${v + s}` });
    }
    return bands;
}
// ---------- Bicubic upscaler for smoother contour rendering ----------
/// Catmull-Rom-style bicubic interpolation kernel.
function cubic(t, a, b, c, d) {
    return b + 0.5 * t * (c - a + t * (2 * a - 5 * b + 4 * c - d + t * (3 * (b - c) + d - a)));
}
/// Upscale a row-major 2D grid by an integer factor using bicubic
/// interpolation. Edges fall back to bilinear (out-of-range neighbours
/// clamped). Output array length = (cols·factor − factor + 1) × (rows·factor − factor + 1).
/// We use the simpler `cols·factor × rows·factor` size with edge clamping.
export function bicubicUpscale(src, cols, rows, factor) {
    if (factor <= 1)
        return { data: src, cols, rows };
    const newCols = (cols - 1) * factor + 1;
    const newRows = (rows - 1) * factor + 1;
    const out = new Float32Array(newCols * newRows);
    const at = (c, r) => {
        const cc = Math.max(0, Math.min(cols - 1, c));
        const rr = Math.max(0, Math.min(rows - 1, r));
        return src[rr * cols + cc];
    };
    for (let r = 0; r < newRows; r++) {
        const sr = r / factor;
        const r0 = Math.floor(sr);
        const tr = sr - r0;
        for (let c = 0; c < newCols; c++) {
            const sc = c / factor;
            const c0 = Math.floor(sc);
            const tc = sc - c0;
            // Sample a 4×4 neighbourhood.
            const row0 = cubic(tc, at(c0 - 1, r0 - 1), at(c0, r0 - 1), at(c0 + 1, r0 - 1), at(c0 + 2, r0 - 1));
            const row1 = cubic(tc, at(c0 - 1, r0 + 0), at(c0, r0 + 0), at(c0 + 1, r0 + 0), at(c0 + 2, r0 + 0));
            const row2 = cubic(tc, at(c0 - 1, r0 + 1), at(c0, r0 + 1), at(c0 + 1, r0 + 1), at(c0 + 2, r0 + 1));
            const row3 = cubic(tc, at(c0 - 1, r0 + 2), at(c0, r0 + 2), at(c0 + 1, r0 + 2), at(c0 + 2, r0 + 2));
            out[r * newCols + c] = cubic(tr, row0, row1, row2, row3);
        }
    }
    return { data: out, cols: newCols, rows: newRows };
}
/// Compute a sensible min/max for the colormap given a Float32 grid of dB
/// values. Strips outliers and -∞ sentinels.
export function gridDomain(dbA) {
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < dbA.length; i++) {
        const v = dbA[i];
        if (!isFinite(v) || v < -100)
            continue;
        if (v < min)
            min = v;
        if (v > max)
            max = v;
    }
    if (!isFinite(min) || !isFinite(max))
        return { min: 25, max: 60 };
    return { min, max };
}

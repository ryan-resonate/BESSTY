// Minimal CSV import for receiver and source location lists.
//
// Two-step UX (handled by the consumer):
//   1. parseCsv(text) → { headers, rows }
//   2. user maps headers → fields (X, Y, name, limits, model, …)
//   3. consumer constructs Source / Receiver objects from each row
//
// Coordinate systems for v1: WGS84 lat/lng (X = lng, Y = lat) only. UTM and
// other projected CRSs land when proj4js is added — currently the user must
// pre-convert to WGS84.
/// Tolerant CSV parser — handles quoted fields, escaped quotes, and the
/// common CR/LF line-ending mix. Assumes the first row is the header.
export function parseCsv(text) {
    const lines = [];
    let row = [];
    let cell = '';
    let inQuotes = false;
    function pushCell() { row.push(cell); cell = ''; }
    function pushRow() { lines.push(row); row = []; }
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (inQuotes) {
            if (c === '"' && text[i + 1] === '"') {
                cell += '"';
                i++;
            }
            else if (c === '"')
                inQuotes = false;
            else
                cell += c;
        }
        else {
            if (c === '"')
                inQuotes = true;
            else if (c === ',')
                pushCell();
            else if (c === '\r') { /* skip — \n handles row break */ }
            else if (c === '\n') {
                pushCell();
                pushRow();
            }
            else
                cell += c;
        }
    }
    if (cell.length > 0 || row.length > 0) {
        pushCell();
        pushRow();
    }
    if (lines.length === 0)
        return { headers: [], rows: [] };
    const headers = lines[0].map((h) => h.trim());
    const rows = [];
    for (let r = 1; r < lines.length; r++) {
        if (lines[r].length === 1 && lines[r][0] === '')
            continue; // blank line
        const obj = {};
        for (let c = 0; c < headers.length; c++) {
            obj[headers[c]] = (lines[r][c] ?? '').trim();
        }
        rows.push(obj);
    }
    return { headers, rows };
}
/// Default mapping by name-matching — covers the common header conventions.
/// User can override in the import dialog.
export function guessMapping(headers, kind) {
    const lower = headers.map((h) => h.toLowerCase());
    function find(...candidates) {
        for (const cand of candidates) {
            const idx = lower.indexOf(cand.toLowerCase());
            if (idx >= 0)
                return headers[idx];
        }
        return null;
    }
    if (kind === 'receiver') {
        return {
            name: find('name', 'id', 'receiver', 'label'),
            x: find('x', 'lng', 'lon', 'longitude', 'easting'),
            y: find('y', 'lat', 'latitude', 'northing'),
            heightAboveGroundM: find('height', 'h', 'z', 'height_m'),
            limitDayDbA: find('limit_day', 'day', 'l_day', 'day_limit'),
            limitEveningDbA: find('limit_evening', 'evening', 'l_eve', 'evening_limit'),
            limitNightDbA: find('limit_night', 'night', 'l_night', 'night_limit'),
        };
    }
    return {
        name: find('name', 'id', 'source', 'turbine', 'label'),
        x: find('x', 'lng', 'lon', 'longitude', 'easting'),
        y: find('y', 'lat', 'latitude', 'northing'),
        modelId: find('model', 'modelid', 'type'),
        mode: find('mode', 'noise_mode', 'op_mode'),
        hubHeight: find('hub_height', 'hub', 'hubheight', 'h'),
    };
}

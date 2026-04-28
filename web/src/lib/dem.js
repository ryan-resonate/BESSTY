// DEM auto-loader using the public AWS Terrain Tiles "terrarium" PNG
// encoding. Free, no key required.
//
// Pixel decode (per Mapzen / AWS spec):
//   elevation_m = (R * 256 + G + B / 256) - 32768
//
// Tile URL: https://elevation-tiles-prod.s3.amazonaws.com/terrarium/{z}/{x}/{y}.png
//
// We pick a zoom level that gives roughly 30 m ground resolution at the
// project latitude (z=12 ≈ 38 m at the equator, finer toward the poles).
const TILE_BASE = 'https://elevation-tiles-prod.s3.amazonaws.com/terrarium';
const TILE_SIZE = 256;
const DEFAULT_ZOOM = 13;
const tileCache = new Map();
function tileKey(t) {
    return `${t.z}/${t.x}/${t.y}`;
}
function lng2tileX(lng, z) {
    return ((lng + 180) / 360) * Math.pow(2, z);
}
function lat2tileY(lat, z) {
    const sinLat = Math.sin((lat * Math.PI) / 180);
    return ((1 - Math.log((1 + sinLat) / (1 - sinLat)) / (2 * Math.PI)) / 2) * Math.pow(2, z);
}
function tileX2lng(x, z) {
    return (x / Math.pow(2, z)) * 360 - 180;
}
function tileY2lat(y, z) {
    const n = Math.PI - (2 * Math.PI * y) / Math.pow(2, z);
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
}
async function loadTile(t) {
    const key = tileKey(t);
    if (tileCache.has(key))
        return tileCache.get(key);
    const promise = (async () => {
        const url = `${TILE_BASE}/${t.z}/${t.x}/${t.y}.png`;
        const resp = await fetch(url);
        if (!resp.ok) {
            throw new Error(`DEM tile ${t.z}/${t.x}/${t.y} fetch failed: ${resp.status}`);
        }
        const blob = await resp.blob();
        const img = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const px = ctx.getImageData(0, 0, TILE_SIZE, TILE_SIZE).data;
        const data = new Float32Array(TILE_SIZE * TILE_SIZE);
        for (let i = 0; i < TILE_SIZE * TILE_SIZE; i++) {
            const r = px[i * 4];
            const g = px[i * 4 + 1];
            const b = px[i * 4 + 2];
            data[i] = r * 256 + g + b / 256 - 32768;
        }
        const lngW = tileX2lng(t.x, t.z);
        const lngE = tileX2lng(t.x + 1, t.z);
        const latN = tileY2lat(t.y, t.z);
        const latS = tileY2lat(t.y + 1, t.z);
        const bounds = [[latS, lngW], [latN, lngE]];
        return { data, bounds };
    })();
    tileCache.set(key, promise);
    return promise;
}
/// Fetch DEM tiles covering the given lat/lng bounding box, return an
/// elevation lookup raster. Caches tiles in memory so repeated calls within
/// one project session don't re-download.
export async function loadDemForBounds(sw, ne, zoom = DEFAULT_ZOOM) {
    const xMin = Math.floor(lng2tileX(sw[1], zoom));
    const xMax = Math.floor(lng2tileX(ne[1], zoom));
    const yMin = Math.floor(lat2tileY(ne[0], zoom));
    const yMax = Math.floor(lat2tileY(sw[0], zoom));
    const tilesToFetch = [];
    for (let y = yMin; y <= yMax; y++) {
        for (let x = xMin; x <= xMax; x++) {
            tilesToFetch.push({ z: zoom, x, y });
        }
    }
    const tiles = await Promise.all(tilesToFetch.map(loadTile));
    // Build a 2D index of tiles for O(1) lookup.
    const grid = new Map();
    for (let i = 0; i < tiles.length; i++) {
        const t = tilesToFetch[i];
        grid.set(`${t.x},${t.y}`, tiles[i]);
    }
    return {
        elevation(lat, lng) {
            const tx = lng2tileX(lng, zoom);
            const ty = lat2tileY(lat, zoom);
            const tileX = Math.floor(tx);
            const tileY = Math.floor(ty);
            const tile = grid.get(`${tileX},${tileY}`);
            if (!tile)
                return 0;
            const localX = (tx - tileX) * TILE_SIZE;
            const localY = (ty - tileY) * TILE_SIZE;
            // Bilinear interpolation across cell.
            const x0 = Math.floor(localX);
            const y0 = Math.floor(localY);
            const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
            const y1 = Math.min(y0 + 1, TILE_SIZE - 1);
            const fx = localX - x0;
            const fy = localY - y0;
            const e00 = tile.data[y0 * TILE_SIZE + x0];
            const e10 = tile.data[y0 * TILE_SIZE + x1];
            const e01 = tile.data[y1 * TILE_SIZE + x0];
            const e11 = tile.data[y1 * TILE_SIZE + x1];
            return (e00 * (1 - fx) * (1 - fy) +
                e10 * fx * (1 - fy) +
                e01 * (1 - fx) * fy +
                e11 * fx * fy);
        },
        bounds: { sw, ne },
        tilesLoaded: tiles.length,
    };
}

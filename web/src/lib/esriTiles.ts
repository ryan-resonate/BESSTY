// Tile resolution for the custom Esri base layer.
//
// Esri's World Imagery answers with a grey "Map data not yet available"
// placeholder PNG and HTTP 200 in poorly-covered areas, so there is no status
// code to filter on. `MapView` draws the base map into <canvas> tiles instead
// of <img> tiles so it can sample each one, and when a tile turns out to be
// the placeholder it climbs the zoom tree looking for real imagery to upscale
// in its place.
//
// The climb lives here, apart from the canvas work, because it is the part
// with the interesting edge cases — and because a bug in it blanks the base
// map without erroring, which is exactly the sort of thing a unit test catches
// and a glance at the screen does not.

/// A tile address. `z` is the zoom, `x`/`y` the tile column and row.
export interface TileCoords {
  z: number;
  x: number;
  y: number;
}

/// What to draw for one requested tile: the source image, and the rect within
/// it to stretch across the tile. When the image came from the requested zoom,
/// `levelsUp` is 0 and the rect is the whole thing.
export interface TileDrawPlan<T> {
  img: T;
  /// How many zoom levels above the requested tile this image came from.
  /// 0 means native resolution; each level doubles the upscale factor.
  levelsUp: number;
  srcX: number;
  srcY: number;
  srcSize: number;
}

/// How far up the zoom tree the search may climb for a tile at `requestedZ`.
///
/// The floor exists to stop the climb running away towards z=0 in a region
/// with no imagery at all. It must never sit ABOVE the tile actually being
/// asked for: a floor of 10 applied to a z=6 request would mean the search
/// could not make even one attempt, and the tile would come back empty. That
/// is not hypothetical — it is the bug this function was extracted to fix,
/// and it blanked the whole base map at zoom 9 and below.
export function climbFloor(requestedZ: number, floorZoom: number): number {
  return Math.min(requestedZ, floorZoom);
}

/// Find real imagery for `coords`, climbing towards lower zooms while the
/// loader returns nothing or the placeholder is detected.
///
/// `load` and `isPlaceholder` are injected so this is testable without a
/// network or a canvas; `MapView` passes its caching image loader and its
/// pixel-sampling placeholder detector.
///
/// Returns `null` only when every zoom from `coords.z` down to the floor
/// failed — a region with genuinely no imagery, which the caller renders as an
/// empty tile rather than as Esri's grey card.
export async function resolveTile<T>(
  coords: TileCoords,
  floorZoom: number,
  load: (z: number, x: number, y: number) => Promise<T | null>,
  isPlaceholder: (img: T) => boolean,
  tileSize = 256,
): Promise<TileDrawPlan<T> | null> {
  const floor = climbFloor(coords.z, floorZoom);
  let { z, x, y } = coords;
  let levelsUp = 0;

  while (z >= floor) {
    const img = await load(z, x, y);
    if (img && !isPlaceholder(img)) {
      // Which quadrant of the ancestor covers the tile we were asked for.
      // Climbing halves the coordinate each step, so the low bits that were
      // shifted away are exactly the sub-tile index within the ancestor.
      const subTilesPerSide = 2 ** levelsUp;
      const srcSize = tileSize / subTilesPerSide;
      const localX = coords.x & (subTilesPerSide - 1);
      const localY = coords.y & (subTilesPerSide - 1);
      return { img, levelsUp, srcX: localX * srcSize, srcY: localY * srcSize, srcSize };
    }
    z -= 1;
    // Math.floor rather than >>1 so a negative column — Leaflet hands out
    // unwrapped coordinates when panning past the antimeridian — halves the
    // way the tile grid expects rather than rounding towards zero.
    x = Math.floor(x / 2);
    y = Math.floor(y / 2);
    levelsUp += 1;
  }
  return null;
}

/// Insertion-ordered cache with a hard size limit.
///
/// The Esri layer caches decoded tile images so that one ancestor fetched on
/// behalf of a quadrant is reused by its siblings. Without a bound that cache
/// keeps every image ever fetched for the life of the layer, and zooming
/// around is precisely the operation that requests new tiles fastest — a
/// decoded 256x256 tile is a quarter of a megabyte, so a long session can
/// starve the browser of memory until image decodes start failing and tiles
/// simply stop appearing.
///
/// Eviction is FIFO, not LRU. The children of an ancestor are requested in a
/// burst, so the ancestor stays resident for as long as it is being reused
/// without needing its recency tracked.
export class BoundedCache<V> {
  private readonly entries = new Map<string, V>();

  constructor(private readonly limit: number) {}

  get size(): number {
    return this.entries.size;
  }

  get(key: string): V | undefined {
    return this.entries.get(key);
  }

  set(key: string, value: V): void {
    // Overwriting an existing key does not grow the cache, so it must not
    // evict — otherwise a refresh of the hottest entry drops the oldest one.
    if (!this.entries.has(key)) {
      while (this.entries.size >= this.limit) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
      }
    }
    this.entries.set(key, value);
  }

  clear(): void {
    this.entries.clear();
  }
}

"""One-shot extractor for the demo project coordinates.

Reads:
  - Tarong WTGs (shapefile, GDA2020 MGA Zone 56) → WGS84 lat/lng
  - Tarong receivers (CSV, GDA94 MGA Zone 56)    → WGS84 lat/lng
  - GP BESS new + existing (shapefile, GDA2020 MGA Zone 54) → WGS84 lat/lng
  - GP BESS receivers (shapefile, GDA2020 MGA Zone 54)      → WGS84 lat/lng

Emits a single TS-friendly Python dict at stdout that I'll hand-paste
into web/src/lib/demoProject.ts. Skips the manual mapping work and
guarantees correct projection.

No external shapefile lib — we parse the .shp Point format inline (it's
a tiny binary format and these files only have point geometry).
"""

import csv
import struct
import zipfile
from pathlib import Path
from pyproj import Transformer

ROOT = Path(__file__).parent

# Reusable transformers. axis-order swap is needed because GDA2020 / GDA94
# define lat-lon order in their CRS, but pyproj's `transform(x, y)` always
# returns (x, y) by default; we ask for (lon, lat) explicitly via
# `always_xy=True` to keep it simple.
T_MGA56_GDA2020 = Transformer.from_crs("EPSG:7856", "EPSG:4326", always_xy=True)
T_MGA56_GDA94   = Transformer.from_crs("EPSG:28356", "EPSG:4326", always_xy=True)
T_MGA54_GDA2020 = Transformer.from_crs("EPSG:7854", "EPSG:4326", always_xy=True)


def read_shp_points_from_zip(zip_path: Path):
    """Return [(x, y), ...] for every record in a Point .shp file packed
    inside a zip. Looks for the first `.shp` inside the archive."""
    with zipfile.ZipFile(zip_path) as zf:
        shp_name = next(n for n in zf.namelist() if n.lower().endswith(".shp"))
        return _parse_shp_points(zf.read(shp_name))


def _parse_shp_points(data: bytes):
    """Return [(x, y), ...] for every record in a Point/PointZ/PointM
    .shp. Strips Z/M from PointZ records — we project from horizontals
    only."""
    pts = []
    cur = 100
    while cur < len(data):
        _, content_len_w = struct.unpack(">II", data[cur:cur+8])
        cur += 8
        shape_type = struct.unpack("<I", data[cur:cur+4])[0]
        if shape_type == 0:        # Null
            pass
        elif shape_type in (1, 11, 21):    # Point, PointZ, PointM
            x, y = struct.unpack("<dd", data[cur+4:cur+20])
            pts.append((x, y))
        else:
            raise ValueError(f"Unsupported shape type {shape_type}")
        cur += content_len_w * 2   # content length is in 16-bit words
    return pts


def emit_pts(label, pts_lonlat):
    print(f"# {label} ({len(pts_lonlat)} points)")
    for i, (lon, lat) in enumerate(pts_lonlat, start=1):
        print(f"  {i:3d}: [{lat:.6f}, {lon:.6f}]")
    print()


def emit_ts_array(label, pts_lonlat):
    """TS-friendly array of [lat, lng] tuples — paste straight into
    demoProject.ts as the source / receiver coordinate list."""
    print(f"// {label} ({len(pts_lonlat)} points)")
    print(f"const {label.upper()}_LATLNG: Array<[number, number]> = [")
    for lon, lat in pts_lonlat:
        print(f"  [{lat:.6f}, {lon:.6f}],")
    print("];")
    print()


def emit_ts_receivers_with_id(label, pts_lonlat, ids):
    """TS-friendly array of {id, lat, lng} — matches CSVs that carry an
    explicit receiver number we want to preserve in the demo."""
    print(f"// {label} ({len(pts_lonlat)} points)")
    print(f"const {label.upper()}: Array<{{ id: string; lat: number; lng: number }}> = [")
    for rid, (lon, lat) in zip(ids, pts_lonlat):
        print(f"  {{ id: '{rid}', lat: {lat:.6f}, lng: {lon:.6f} }},")
    print("];")
    print()


# ---------- Tarong WF ----------
print("=" * 60)
print("Tarong WF")
print("=" * 60)

wtg_xy = read_shp_points_from_zip(ROOT / "Tarong WF" / "TarongWestWTGs.zip")
wtg_lonlat = [T_MGA56_GDA2020.transform(x, y) for x, y in wtg_xy]
emit_ts_array("Tarong_WTG", wtg_lonlat)

# Tarong receivers — CSV with Location,Easting,Northing in MGA56 GDA94.
recv_rows = []
with open(ROOT / "Tarong WF" / "NonHostLosts.csv", newline="") as f:
    reader = csv.reader(f)
    next(reader, None)        # header
    for row in reader:
        if len(row) < 3 or not row[0].strip():
            continue
        rid = row[0].strip()
        try:
            e = float(row[1])
            n = float(row[2])
        except ValueError:
            continue
        recv_rows.append((rid, e, n))

tarong_recv_ll = [(T_MGA56_GDA94.transform(e, n)) for _, e, n in recv_rows]
tarong_recv_ids = [rid for rid, _, _ in recv_rows]
emit_ts_receivers_with_id("TARONG_RECEIVERS", tarong_recv_ll, tarong_recv_ids)

# ---------- GP BESS ----------
print("=" * 60)
print("GP BESS")
print("=" * 60)

new_bess_xy = read_shp_points_from_zip(ROOT / "GP BESS" / "20260206_BESS_Centroids.zip")
new_bess_lonlat = [T_MGA54_GDA2020.transform(x, y) for x, y in new_bess_xy]
emit_ts_array("GP_NEW_BESS", new_bess_lonlat)

old_bess_xy = read_shp_points_from_zip(ROOT / "GP BESS" / "20260206_existing_BESS_Centroids.zip")
old_bess_lonlat = [T_MGA54_GDA2020.transform(x, y) for x, y in old_bess_xy]
emit_ts_array("GP_EXISTING_BESS", old_bess_lonlat)

recv_xy = read_shp_points_from_zip(ROOT / "GP BESS" / "Receivers_.zip")
recv_lonlat = [T_MGA54_GDA2020.transform(x, y) for x, y in recv_xy]
emit_ts_array("GP_RECEIVERS", recv_lonlat)

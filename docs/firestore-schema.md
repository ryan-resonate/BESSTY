# Firestore + Storage schema

## 1. Top-level structure

```
projects/
  {projectId}/                    one document per project (single source of truth)
    results/                      subcollection — cached result rasters
      latest                      most recent solver run, for fast first paint
      {scenarioId}                user-saved scenarios

catalog/
  wtg/{modelId}                   WTG catalog entries (read-only in v1)
  bess/{modelId}                  BESS catalog entries
  inverter/{modelId}              Inverter catalog entries
  transformer/{modelId}           Transformer catalog entries

dem-tiles/                        Cloud Storage bucket
  {z}/{x}/{y}.tif                 COG tiles, slippy-map XYZ scheme

user-uploads/{projectId}/         Cloud Storage bucket
  dem/{filename}                  user-uploaded DEM files
  spectra/{filename}              user-uploaded spectra
```

## 2. Project document

`projects/{projectId}` — embedded document, single round-trip load. Sub-MB target.

```json
{
  "schemaVersion": 1,
  "name": "Mt Brown Wind Farm",
  "description": "Stage 2 layout review",
  "createdAt": "2026-04-27T03:14:00Z",
  "updatedAt": "2026-04-27T14:22:00Z",
  "owner": "anonymous",

  "coordinateSystem": {
    "datum": "WGS84",
    "projection": "UTM",
    "utmZone": 54,
    "utmHemisphere": "S",
    "originLatLng": [-33.5950, 138.7400]
  },

  "scenario": {
    "windSpeed": 8.0,
    "windSpeedReferenceHeight": 10.0,
    "period": "night",
    "bandSystem": "octave"
  },

  "settings": {
    "atmosphere": {
      "temperatureC": 10.0,
      "humidityPct": 70.0
    },
    "ground": {
      "defaultG": 0.5
    },
    "annexD": {
      "barrierAbarCapDb": 3.0,
      "useElevatedSourceForBarrier": true,
      "applyConcaveCorrection": true,
      "wtReceiverHeightMin": 4.0
    },
    "general": {
      "defaultReceiverHeight": 1.5
    },
    "reflection": {
      "orderCap": 3,
      "maxSearchRadiusM": 20000,
      "maxReflectorReceiverM": 200,
      "maxSourceReflectorM": 50,
      "toleranceDb": 0.3
    },
    "grid": {
      "baseSpacingM": 50,
      "refinementFactor": 4,
      "refineRadiusFromSourceM": 200,
      "refineRadiusFromBarrierM": 100
    }
  },

  "calculationArea": {
    "centerLatLng": [-33.5950, 138.7400],
    "widthM": 9000,
    "heightM": 7000,
    "rotationDeg": 18
  },

  "sources": [
    {
      "id": "WTG-01",
      "kind": "wtg",
      "name": "WTG-01",
      "latLng": [-33.5910, 138.7320],
      "modelId": "v163",
      "hubHeight": 148,
      "modeOverride": null
    },
    {
      "id": "BESS-A-01",
      "kind": "bess",
      "name": "BESS-A unit 01",
      "latLng": [-33.5760, 138.7100],
      "elevationOffset": 1.5,
      "modelId": "mp2xl",
      "modeOverride": null,
      "yawDeg": 35
    },
    {
      "id": "INV-01",
      "kind": "inverter",
      "name": "Inverter 01",
      "latLng": [-33.5765, 138.7105],
      "elevationOffset": 1.5,
      "modelId": "sg-inv-3300",
      "modeOverride": null
    }
  ],

  "barriers": [
    {
      "id": "B-01",
      "name": "Acoustic barrier south",
      "type": "wall",
      "polylineLatLng": [
        [-33.5800, 138.7140],
        [-33.5805, 138.7180],
        [-33.5810, 138.7220]
      ],
      "topHeightsM": [4.0, 4.0, 4.0],
      "baseFromGroundM": 0.0,
      "surfaceDensityKgM2": 25.0,
      "absorptionCoeff": 0.1
    }
  ],

  "receivers": [
    {
      "id": "R01",
      "name": "Farmstead 12",
      "latLng": [-33.5680, 138.7050],
      "heightAboveGroundM": 1.5,
      "limitDbA": 40,
      "period": "night"
    }
  ],

  "demReference": {
    "source": "service",
    "serviceProvider": "nasadem",
    "userUploadedRef": null,
    "boundsLatLng": [[-33.65, 138.65], [-33.55, 138.80]]
  }
}
```

## 3. Catalog documents

### 3.1 `catalog/wtg/{modelId}`

```json
{
  "modelId": "v163",
  "displayName": "Vestas V163-4.5 MW",
  "manufacturer": "Vestas",
  "rotorDiameterM": 163,
  "ratedPowerKw": 4500,
  "hubHeights": [119, 148, 166],
  "modes": ["PO4500-0S", "PO4500", "SO1", "SO2", "SO3", "SO11", "SO12", "SO13"],
  "spectra": [
    {
      "mode": "PO4500",
      "windSpeed": 6.0,
      "bandSystem": "octave",
      "values": [98.0, 99.0, 101.0, 104.0, 105.0, 102.0, 96.0, 88.0]
    },
    {
      "mode": "PO4500",
      "windSpeed": 8.0,
      "bandSystem": "octave",
      "values": [99.0, 100.0, 102.0, 105.0, 106.5, 103.0, 97.0, 89.0]
    }
    // ... per mode × wind speed
    // bandSystem may be "octave" (8 values) or "oneThirdOctave" (24 values).
    // A single catalog entry may mix systems (e.g. some modes octave, some
    // third-octave) — at solve time, mismatches are resolved per project's
    // chosen system: third-octave-into-octave by energy summation; the reverse
    // is not supported and surfaces an error.
  ],
  "source": "Vestas datasheet v2.3",
  "verified": false,
  "notes": "Placeholder for v1 — replace with vendor-supplied spectra."
}
```

### 3.2 `catalog/bess/{modelId}`

```json
{
  "modelId": "mp2xl",
  "displayName": "Tesla Megapack 2 XL",
  "manufacturer": "Tesla",
  "modes": ["2-hr / 9-fan", "4-hr / 5-fan", "Idle / cooling"],
  "spectra": [
    {
      "mode": "2-hr / 9-fan",
      "bandSystem": "octave",
      "values": [82.0, 85.0, 88.0, 91.0, 93.0, 90.0, 86.0, 80.0]
    }
    // ...
  ],
  "directivity": null,
  "verified": false
}
```

`directivity` is null for omnidirectional. If present:

```json
"directivity": {
  "type": "polarBroadband",
  "anglesDeg": [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330],
  "valuesDb":  [0, -1, -3, -6, -8, -6, -3, -1,   0,  -1,  -3,  -1]
}
```

`type: polarBroadband` means the same correction applies to all bands (your stated requirement).

### 3.3 `catalog/inverter/{modelId}` and `catalog/transformer/{modelId}`

Same schema as BESS — point source with octave-band spectra per mode.

## 4. Cached results

`projects/{projectId}/results/latest`:

```json
{
  "computedAt": "2026-04-27T14:22:00Z",
  "scenarioHash": "sha256:...",
  "gridSpec": {
    "originUtm": [284321.0, 6285430.0],
    "rotationDeg": 18,
    "spacingM": 50,
    "cols": 180,
    "rows": 140
  },
  "rasterRef": "user-uploads/{projectId}/results/latest.f32"
}
```

The actual raster (cols × rows × f32) is stored in Cloud Storage rather than Firestore (Firestore has a 1 MB doc limit; even modest grids exceed that). The raster is `cols × rows` f32 values of A-weighted total dB.

`scenarioHash` is computed from the project's `scenario`, `sources`, `barriers`, and relevant `settings` — when the user opens the project, if the hash matches, paint the cached raster immediately while a fresh solve runs in background.

## 5. Schema versioning

`schemaVersion: 1` at the project document root. Migrations are forward-only — when we bump to v2, a one-time migration function reads v1 docs, transforms, writes back.

## 6. Indexes

Firestore composite indexes needed:

- `projects` ordered by `updatedAt desc` for the project list screen.
- `catalog/wtg` ordered by `manufacturer asc`, `displayName asc` for dropdowns.

No queries over project subcollections needed in v1.

## 7. Security rules (v1, no auth)

Single anonymous bucket. Permissive rules:

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /projects/{projectId} {
      allow read, write: if true;
      match /results/{resultId} {
        allow read, write: if true;
      }
    }
    match /catalog/{kind}/{modelId} {
      allow read: if true;
      allow write: if false;  // catalog seeded by admin script only
    }
  }
}
```

When auth is added, `if true` becomes `if request.auth != null && resource.data.owner == request.auth.uid` (or membership-based).

## 8. Storage rules

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /dem-tiles/{allPaths=**} { allow read: if true; allow write: if false; }
    match /user-uploads/{projectId}/{allPaths=**} { allow read, write: if true; }
  }
}
```

## 9. Size projections

- A typical project document with 30 WTGs, 5 BESS, 5 receivers, 2 barriers, full settings: ~12 KB JSON, well under the 1 MB doc limit.
- A WTG catalog entry with 8 modes × 10 wind speeds × 8 bands = 640 floats ≈ 8 KB. Easy.
- A 180 × 140 result raster at f32 = 100 KB binary, stored in Storage.
- DEM tiles per the COG spec: 256 × 256 × f32 = 256 KB per tile, gzipped to ~80 KB. A 15 × 15 km region at 30 m needs 16 tiles ≈ 1.3 MB transferred.

// Sample projects pre-installed on first launch so users have something
// to click Run on. Two demos:
//
//   - **GP BESS** — 168 × Tesla Megapack units (84 new + 84 existing)
//     plus 72 receivers around an Australian site. All BESS imported
//     with their default mode; receivers at 1.5 m HAG.
//
//   - **Tarong WF** — 97 × V163 4.5 MW WTGs at 174 m hub height in
//     PO4500 mode, plus 59 dwelling receivers from the non-host-lots
//     CSV. Receivers at 4 m HAG (per the Annex D wind-farm convention).
//
// Coordinates were extracted from the Examples/ shapefiles + CSV via
// `Examples/extract_demo_data.py` (pyproj reprojects from MGA Zone 54
// or 56 to WGS84). Each demo's calculation area is pre-fitted to wrap
// every source + receiver with a ~10% buffer.
//
// See `lib/storage.ts::ensureDemoSeeded` for the install-on-first-launch
// hook.
//
// (Repo histroy note: the previous Mt Brown synthetic demo lived here
// before the real-data examples landed. Old projects with that demo
// already in localStorage are left alone on upgrade.)

import type { Project, ProjectSettings, Source, Receiver } from './types';

// Defaults shared by both demos: matches what `makeEmptyProject` in
// storage.ts produces for new projects, kept in lockstep so the demos
// don't drift on a settings tweak.
function commonSettings(): ProjectSettings {
  return {
    ground: { defaultG: 0.5 },
    dOmegaDb: 3,
    annexD: {
      barrierAbarCapDb: 3.0,
      useElevatedSourceForBarrier: true,
      applyConcaveCorrection: true,
      wtReceiverHeightMin: 4.0,
    },
    barrierConvention: 'dz-minus-max-agr-0',
    general: { defaultReceiverHeight: 1.5 },
    extrapolation: { capPerBandDb: 6, capTotalDbA: 3 },
    propagation: {
      maxContributionDistanceM: 20000,
      treeAcceptanceTheta: 0.25,
    },
    topography: {
      pathSamples: 12,
      virtualBarrierMinHeightM: 2,
    },
  };
}

/// Compute a calc area that wraps every supplied lat/lng with a 10%
/// buffer on each side. Mirrors `ProjectScreen.fitCalcAreaToObjects`,
/// but inlined here so the demo is self-contained.
function autoFitCalcArea(
  points: Array<[number, number]>,
): NonNullable<Project['calculationArea']> {
  let minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
  for (const [la, ln] of points) {
    if (la < minLat) minLat = la; if (la > maxLat) maxLat = la;
    if (ln < minLng) minLng = ln; if (ln > maxLng) maxLng = ln;
  }
  const centreLat = (minLat + maxLat) / 2;
  const centreLng = (minLng + maxLng) / 2;
  const R = 6371008.8;
  const lat0Rad = (centreLat * Math.PI) / 180;
  const heightM = Math.max(500, (maxLat - minLat) * (Math.PI / 180) * R);
  const widthM  = Math.max(500, (maxLng - minLng) * (Math.PI / 180) * R * Math.cos(lat0Rad));
  const padded = (m: number) => Math.max(500, m * 1.1);
  return {
    centerLatLng: [centreLat, centreLng],
    widthM: padded(widthM),
    heightM: padded(heightM),
    rotationDeg: 0,
  };
}

// ---------------------------------------------------------------- GP BESS

// Coordinates extracted from `20260206_BESS_Centroids.zip` — 84 new
// Tesla Megapack centroids in GDA2020 MGA Zone 54.
const GP_NEW_BESS_LATLNG: Array<[number, number]> = [
  [-37.969611, 143.780127], [-37.969620, 143.780200], [-37.969629, 143.780274],
  [-37.969638, 143.780345], [-37.969645, 143.780421], [-37.969653, 143.780494],
  [-37.969662, 143.780565], [-37.969753, 143.780104], [-37.969759, 143.780178],
  [-37.969770, 143.780254], [-37.969778, 143.780325], [-37.969785, 143.780397],
  [-37.969792, 143.780471], [-37.969800, 143.780546], [-37.969686, 143.780790],
  [-37.969827, 143.780767], [-37.969694, 143.780863], [-37.969702, 143.780936],
  [-37.969711, 143.781011], [-37.969718, 143.781081], [-37.969728, 143.781155],
  [-37.969735, 143.781227], [-37.969834, 143.780839], [-37.969842, 143.780914],
  [-37.969851, 143.780988], [-37.969860, 143.781058], [-37.969868, 143.781132],
  [-37.969874, 143.781206], [-37.969752, 143.781377], [-37.969759, 143.781449],
  [-37.969769, 143.781522], [-37.969778, 143.781597], [-37.969785, 143.781668],
  [-37.969794, 143.781744], [-37.969803, 143.781818], [-37.969893, 143.781354],
  [-37.969900, 143.781426], [-37.969908, 143.781502], [-37.969917, 143.781575],
  [-37.969925, 143.781649], [-37.969933, 143.781722], [-37.969941, 143.781794],
  [-37.969932, 143.780077], [-37.969941, 143.780150], [-37.969949, 143.780223],
  [-37.969958, 143.780298], [-37.969965, 143.780371], [-37.969974, 143.780445],
  [-37.969982, 143.780517], [-37.970071, 143.780056], [-37.970080, 143.780129],
  [-37.970087, 143.780198], [-37.970096, 143.780274], [-37.970104, 143.780348],
  [-37.970114, 143.780423], [-37.970122, 143.780495], [-37.970004, 143.780738],
  [-37.970015, 143.780812], [-37.970024, 143.780884], [-37.970030, 143.780960],
  [-37.970040, 143.781033], [-37.970047, 143.781105], [-37.970055, 143.781179],
  [-37.970146, 143.780717], [-37.970154, 143.780791], [-37.970161, 143.780865],
  [-37.970169, 143.780936], [-37.970179, 143.781009], [-37.970188, 143.781085],
  [-37.970197, 143.781157], [-37.970073, 143.781326], [-37.970083, 143.781399],
  [-37.970089, 143.781472], [-37.970098, 143.781546], [-37.970107, 143.781619],
  [-37.970115, 143.781694], [-37.970122, 143.781765], [-37.970212, 143.781306],
  [-37.970221, 143.781379], [-37.970229, 143.781450], [-37.970238, 143.781524],
  [-37.970246, 143.781598], [-37.970255, 143.781668], [-37.970262, 143.781744],
];

// `20260206_existing_BESS_Centroids.zip` — 84 existing Megapack centroids.
const GP_EXISTING_BESS_LATLNG: Array<[number, number]> = [
  [-37.970836, 143.779938], [-37.970845, 143.780011], [-37.970853, 143.780085],
  [-37.970860, 143.780158], [-37.970869, 143.780230], [-37.970876, 143.780303],
  [-37.970886, 143.780376], [-37.970976, 143.779916], [-37.970985, 143.779989],
  [-37.970993, 143.780062], [-37.971001, 143.780136], [-37.971009, 143.780209],
  [-37.971017, 143.780282], [-37.971027, 143.780355], [-37.970911, 143.780601],
  [-37.970918, 143.780673], [-37.970927, 143.780745], [-37.970935, 143.780819],
  [-37.970943, 143.780892], [-37.970951, 143.780965], [-37.970958, 143.781038],
  [-37.971050, 143.780577], [-37.971059, 143.780650], [-37.971067, 143.780726],
  [-37.971077, 143.780798], [-37.971085, 143.780871], [-37.971092, 143.780945],
  [-37.971100, 143.781017], [-37.970975, 143.781185], [-37.970984, 143.781260],
  [-37.970992, 143.781334], [-37.971001, 143.781407], [-37.971010, 143.781481],
  [-37.971018, 143.781553], [-37.971025, 143.781626], [-37.971117, 143.781163],
  [-37.971125, 143.781236], [-37.971134, 143.781311], [-37.971142, 143.781385],
  [-37.971149, 143.781457], [-37.971157, 143.781531], [-37.971166, 143.781603],
  [-37.971156, 143.779888], [-37.971165, 143.779961], [-37.971174, 143.780035],
  [-37.971181, 143.780107], [-37.971189, 143.780179], [-37.971199, 143.780254],
  [-37.971207, 143.780327], [-37.971296, 143.779867], [-37.971305, 143.779940],
  [-37.971314, 143.780012], [-37.971321, 143.780085], [-37.971331, 143.780157],
  [-37.971339, 143.780233], [-37.971346, 143.780305], [-37.971230, 143.780548],
  [-37.971240, 143.780622], [-37.971248, 143.780697], [-37.971256, 143.780769],
  [-37.971264, 143.780842], [-37.971271, 143.780914], [-37.971280, 143.780989],
  [-37.971371, 143.780528], [-37.971378, 143.780601], [-37.971388, 143.780675],
  [-37.971398, 143.780747], [-37.971406, 143.780820], [-37.971412, 143.780894],
  [-37.971420, 143.780967], [-37.971296, 143.781137], [-37.971304, 143.781210],
  [-37.971313, 143.781284], [-37.971322, 143.781357], [-37.971331, 143.781429],
  [-37.971338, 143.781503], [-37.971346, 143.781576], [-37.971437, 143.781115],
  [-37.971446, 143.781188], [-37.971454, 143.781261], [-37.971462, 143.781335],
  [-37.971471, 143.781408], [-37.971479, 143.781481], [-37.971486, 143.781553],
];

// `Receivers_.zip` — 72 receiver locations around the GP BESS site.
const GP_RECEIVERS_LATLNG: Array<[number, number]> = [
  [-37.933312, 143.785983], [-37.956359, 143.824928], [-37.983328, 143.854484],
  [-37.959700, 143.862637], [-37.946264, 143.681756], [-37.955005, 143.703877],
  [-37.936026, 143.719635], [-37.960823, 143.748902], [-37.936142, 143.753601],
  [-38.018097, 143.776327], [-38.001600, 143.777183], [-38.000651, 143.780120],
  [-37.992085, 143.779459], [-37.989483, 143.782489], [-37.958077, 143.785331],
  [-37.958304, 143.786803], [-37.998470, 143.814320], [-37.997737, 143.816380],
  [-37.955572, 143.822362], [-38.019763, 143.797619], [-37.951243, 143.705212],
  [-37.945162, 143.752705], [-37.945551, 143.752004], [-37.924784, 143.756602],
  [-38.018628, 143.775012], [-37.940188, 143.832854], [-38.012478, 143.857734],
  [-37.983023, 143.856476], [-37.969827, 143.859000], [-37.949251, 143.864821],
  [-37.955933, 143.683137], [-37.955729, 143.681551], [-38.020957, 143.827299],
  [-37.936666, 143.824554], [-38.021694, 143.855857], [-37.995344, 143.856846],
  [-37.947112, 143.855807], [-37.946743, 143.855691], [-37.944924, 143.855960],
  [-37.948398, 143.855449], [-37.943791, 143.859723], [-37.944364, 143.857787],
  [-37.927884, 143.865846], [-37.928623, 143.865850], [-38.022067, 143.760840],
  [-38.016513, 143.758407], [-38.016703, 143.757906], [-38.024254, 143.790834],
  [-37.932155, 143.786418], [-37.928673, 143.803699], [-37.926329, 143.806262],
  [-37.930596, 143.812893], [-38.024778, 143.749167], [-38.024254, 143.748243],
  [-38.005326, 143.728948], [-37.998812, 143.709546], [-38.021204, 143.843705],
  [-38.022213, 143.857875], [-37.931898, 143.860869], [-37.933462, 143.863343],
  [-38.018445, 143.872853], [-38.004460, 143.725473], [-37.932491, 143.863321],
  [-37.930807, 143.865059], [-38.002789, 143.687354], [-37.998924, 143.683563],
  [-37.964623, 143.694903], [-37.964553, 143.698225], [-37.961945, 143.701094],
  [-38.020960, 143.827297], [-37.940185, 143.832855], [-37.936663, 143.824552],
];

export function makeGpBessProject(): Project {
  const now = new Date().toISOString();
  // Tesla Megapack — kind / scope / mode all match the seed catalog
  // entry. Each unit is its own source so the solver can show the per-
  // unit contribution rather than a lumped pad.
  const newSources: Source[] = GP_NEW_BESS_LATLNG.map((latLng, i) => ({
    id: `BESS-N${i + 1}`,
    kind: 'bess',
    catalogScope: 'global',
    name: `New BESS-${i + 1}`,
    latLng,
    modelId: 'tesla-megapack',
    elevationOffset: 3.3,
    modeOverride: '100% fan speed 4-hour 5 Fan',
  }));
  const existingSources: Source[] = GP_EXISTING_BESS_LATLNG.map((latLng, i) => ({
    id: `BESS-E${i + 1}`,
    kind: 'bess',
    catalogScope: 'global',
    name: `Existing BESS-${i + 1}`,
    latLng,
    modelId: 'tesla-megapack',
    elevationOffset: 3.3,
    modeOverride: '100% fan speed 4-hour 5 Fan',
  }));
  const sources = [...newSources, ...existingSources];
  const receivers: Receiver[] = GP_RECEIVERS_LATLNG.map((latLng, i) => ({
    id: `R-G${i + 1}`,
    name: `Receiver ${i + 1}`,
    latLng,
    heightAboveGroundM: 1.5,
    limitDayDbA: 50,
    limitEveningDbA: 45,
    limitNightDbA: 40,
  }));

  const allPoints: Array<[number, number]> = [
    ...sources.map((s) => s.latLng),
    ...receivers.map((r) => r.latLng),
  ];

  return {
    schemaVersion: 1,
    name: 'GP BESS — example',
    description:
      '168 Tesla Megapack units (84 new + 84 existing) with 72 receivers. ' +
      'Imported from the example shapefiles in Examples/GP BESS.',
    createdAt: now,
    updatedAt: now,
    owner: 'anonymous',
    scenario: {
      windSpeed: 10,
      windSpeedReferenceHeight: 10,
      period: 'night',
      bandSystem: 'octave',
    },
    settings: commonSettings(),
    calculationArea: autoFitCalcArea(allPoints),
    sources,
    barriers: [],
    receivers,
    groups: [
      {
        id: 'g-gp-new',
        name: 'New BESS',
        memberIds: newSources.map((s) => s.id),
        color: '#5e35b1',
      },
      {
        id: 'g-gp-existing',
        name: 'Existing BESS',
        memberIds: existingSources.map((s) => s.id),
        color: '#1565c0',
      },
    ],
  };
}

// ---------------------------------------------------------------- Tarong WF

// `TarongWestWTGs.zip` — 97 WTG locations in GDA2020 MGA Zone 56.
const TARONG_WTG_LATLNG: Array<[number, number]> = [
  [-26.685911, 151.576559], [-26.681300, 151.574023], [-26.680569, 151.533294],
  [-26.680477, 151.540138], [-26.678775, 151.545787], [-26.676359, 151.570166],
  [-26.568472, 151.557493], [-26.576118, 151.569114], [-26.671525, 151.568839],
  [-26.668699, 151.538610], [-26.664954, 151.547540], [-26.661123, 151.491757],
  [-26.661213, 151.551566], [-26.656765, 151.494507], [-26.656220, 151.533857],
  [-26.654862, 151.551154], [-26.653361, 151.479190], [-26.651948, 151.494881],
  [-26.652054, 151.522969], [-26.647400, 151.498447], [-26.647219, 151.519907],
  [-26.646618, 151.555367], [-26.643552, 151.487919], [-26.643126, 151.502260],
  [-26.642437, 151.509763], [-26.640763, 151.531071], [-26.641087, 151.556491],
  [-26.639588, 151.514431], [-26.636658, 151.506131], [-26.636619, 151.533635],
  [-26.635511, 151.495840], [-26.634731, 151.525643], [-26.632670, 151.511467],
  [-26.631628, 151.501646], [-26.630464, 151.532076], [-26.630503, 151.542010],
  [-26.630158, 151.522538], [-26.627905, 151.507290], [-26.623811, 151.547830],
  [-26.615414, 151.469349], [-26.609679, 151.522038], [-26.607517, 151.470358],
  [-26.607991, 151.560764], [-26.602569, 151.535455], [-26.601746, 151.516988],
  [-26.600825, 151.465888], [-26.601900, 151.562788], [-26.597183, 151.472272],
  [-26.598726, 151.536609], [-26.596605, 151.451354], [-26.597185, 151.544742],
  [-26.594523, 151.509952], [-26.594575, 151.562428], [-26.592624, 151.459611],
  [-26.591956, 151.451356], [-26.592441, 151.549602], [-26.589058, 151.509672],
  [-26.586408, 151.498912], [-26.585399, 151.478674], [-26.586447, 151.556746],
  [-26.585041, 151.462935], [-26.586144, 151.564260], [-26.585103, 151.505255],
  [-26.583661, 151.515876], [-26.581681, 151.494084], [-26.580981, 151.551031],
  [-26.578524, 151.509708], [-26.578162, 151.533999], [-26.578434, 151.561585],
  [-26.575621, 151.490429], [-26.574724, 151.473966], [-26.573934, 151.511022],
  [-26.656555, 151.564977], [-26.570880, 151.467431], [-26.570702, 151.529315],
  [-26.569002, 151.473269], [-26.567737, 151.508954], [-26.564977, 151.460784],
  [-26.562144, 151.504991], [-26.560645, 151.478539], [-26.560888, 151.488624],
  [-26.547533, 151.451341], [-26.559848, 151.459808], [-26.555013, 151.460114],
  [-26.550800, 151.484852], [-26.548864, 151.471719], [-26.543627, 151.500493],
  [-26.543056, 151.457193], [-26.539911, 151.463487], [-26.603001, 151.480249],
  [-26.540073, 151.510275], [-26.539665, 151.481807], [-26.535510, 151.470661],
  [-26.528455, 151.478623], [-26.527140, 151.486508], [-26.521271, 151.488110],
  [-26.517038, 151.491587],
];

// `NonHostLosts.csv` — 59 receivers (Location IDs are not contiguous;
// gaps in the original numbering are preserved as the receiver name).
const TARONG_RECEIVERS: Array<{ id: string; lat: number; lng: number }> = [
  { id: '1',   lat: -26.681003, lng: 151.492802 },
  { id: '2',   lat: -26.601400, lng: 151.416997 },
  { id: '3',   lat: -26.622797, lng: 151.420499 },
  { id: '4',   lat: -26.669701, lng: 151.463299 },
  { id: '5',   lat: -26.507898, lng: 151.514403 },
  { id: '6',   lat: -26.516798, lng: 151.544101 },
  { id: '7',   lat: -26.527904, lng: 151.532902 },
  { id: '8',   lat: -26.520500, lng: 151.447500 },
  { id: '9',   lat: -26.550998, lng: 151.425599 },
  { id: '10',  lat: -26.669299, lng: 151.461998 },
  { id: '11',  lat: -26.620604, lng: 151.430401 },
  { id: '12',  lat: -26.571501, lng: 151.399097 },
  { id: '13',  lat: -26.680901, lng: 151.511403 },
  { id: '14',  lat: -26.634204, lng: 151.455598 },
  { id: '16',  lat: -26.613497, lng: 151.429303 },
  { id: '20',  lat: -26.635167, lng: 151.598223 },
  { id: '21',  lat: -26.641642, lng: 151.603920 },
  { id: '22',  lat: -26.639214, lng: 151.609474 },
  { id: '23',  lat: -26.626749, lng: 151.603217 },
  { id: '24',  lat: -26.622843, lng: 151.609110 },
  { id: '25',  lat: -26.702017, lng: 151.541050 },
  { id: '26',  lat: -26.710405, lng: 151.563398 },
  { id: '28',  lat: -26.697349, lng: 151.602015 },
  { id: '29',  lat: -26.690854, lng: 151.607059 },
  { id: '30',  lat: -26.683757, lng: 151.609668 },
  { id: '31',  lat: -26.680813, lng: 151.616055 },
  { id: '32',  lat: -26.669106, lng: 151.606972 },
  { id: '33',  lat: -26.660220, lng: 151.606648 },
  { id: '34',  lat: -26.656343, lng: 151.605258 },
  { id: '35',  lat: -26.659204, lng: 151.613542 },
  { id: '36',  lat: -26.658637, lng: 151.617397 },
  { id: '37',  lat: -26.652062, lng: 151.609731 },
  { id: '38',  lat: -26.649338, lng: 151.605373 },
  { id: '39',  lat: -26.635177, lng: 151.619498 },
  { id: '40',  lat: -26.632918, lng: 151.611861 },
  { id: '41',  lat: -26.628874, lng: 151.605491 },
  { id: '42',  lat: -26.618019, lng: 151.605010 },
  { id: '43',  lat: -26.610005, lng: 151.604364 },
  { id: '44',  lat: -26.606979, lng: 151.606058 },
  { id: '45',  lat: -26.601895, lng: 151.614174 },
  { id: '46',  lat: -26.600931, lng: 151.614366 },
  { id: '47',  lat: -26.594107, lng: 151.607128 },
  { id: '48',  lat: -26.593393, lng: 151.607880 },
  { id: '49',  lat: -26.591374, lng: 151.618397 },
  { id: '50',  lat: -26.580875, lng: 151.622198 },
  { id: '51',  lat: -26.520225, lng: 151.451294 },
  { id: '52',  lat: -26.502765, lng: 151.439916 },
  { id: '53',  lat: -26.502497, lng: 151.441293 },
  { id: '54',  lat: -26.494891, lng: 151.467015 },
  { id: '55',  lat: -26.493537, lng: 151.473502 },
  { id: '56',  lat: -26.482450, lng: 151.462578 },
  { id: '57',  lat: -26.554876, lng: 151.422006 },
  { id: '100', lat: -26.694119, lng: 151.617189 },
  { id: '101', lat: -26.691933, lng: 151.615901 },
  { id: '102', lat: -26.697896, lng: 151.607544 },
  { id: '105', lat: -26.691605, lng: 151.620810 },
  { id: '110', lat: -26.634553, lng: 151.456194 },
  { id: '111', lat: -26.634502, lng: 151.456479 },
  { id: '128', lat: -26.547928, lng: 151.527907 },
];

// One-off note: the receiver CSV is GDA94 MGA Zone 56 and the WTG shapefile
// is GDA2020 MGA Zone 56. The two datums agree to within ~1 m at this site,
// which is well below the noise model's per-receiver uncertainty — kept
// the projections distinct in the extractor for fidelity, but downstream
// they're treated as the same WGS84 coordinate frame.

export function makeTarongWfProject(): Project {
  const now = new Date().toISOString();
  const sources: Source[] = TARONG_WTG_LATLNG.map((latLng, i) => ({
    id: `WTG-T${i + 1}`,
    kind: 'wtg',
    catalogScope: 'global',
    name: `WTG-${i + 1}`,
    latLng,
    modelId: 'v163-4-5-mw',
    hubHeight: 174,
    modeOverride: 'PO4500',
  }));
  const receivers: Receiver[] = TARONG_RECEIVERS.map((r) => ({
    id: `R-T${r.id}`,
    name: `Receiver ${r.id}`,
    latLng: [r.lat, r.lng],
    heightAboveGroundM: 4,
    limitDayDbA: 40,
    limitEveningDbA: 40,
    limitNightDbA: 40,
  }));

  const allPoints: Array<[number, number]> = [
    ...sources.map((s) => s.latLng),
    ...receivers.map((rx) => rx.latLng),
  ];

  return {
    schemaVersion: 1,
    name: 'Tarong WF — example',
    description:
      '97 × Vestas V163 4.5 MW WTGs (174 m hub, PO4500 mode) with 59 ' +
      'non-host-lot receivers at 4 m HAG. Imported from Examples/Tarong WF.',
    createdAt: now,
    updatedAt: now,
    owner: 'anonymous',
    scenario: {
      windSpeed: 10,
      windSpeedReferenceHeight: 10,
      period: 'night',
      bandSystem: 'octave',
    },
    settings: commonSettings(),
    calculationArea: autoFitCalcArea(allPoints),
    sources,
    barriers: [],
    receivers,
    groups: [],
  };
}

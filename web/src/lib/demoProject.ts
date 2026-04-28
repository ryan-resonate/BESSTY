// Sample project used for the v0.4 interactive demo. Pre-populates the
// workspace with a small WTG cluster + a BESS pad + a few receivers around
// Goyder, SA so the user can immediately click Run and see results.

import type { Project } from './types';

export function makeDemoProject(): Project {
  return {
    schemaVersion: 1,
    name: 'Demo project — Mt Brown',
    description: 'Synthetic 8 × WTG + 1 × BESS layout for first-look testing.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    owner: 'anonymous',
    scenario: {
      windSpeed: 8,
      windSpeedReferenceHeight: 10,
      period: 'night',
      bandSystem: 'octave',
    },
    settings: {
      ground: { defaultG: 0.5 },
      annexD: {
        barrierAbarCapDb: 3.0,
        useElevatedSourceForBarrier: true,
        applyConcaveCorrection: true,
        wtReceiverHeightMin: 4.0,
      },
      general: { defaultReceiverHeight: 1.5 },
      extrapolation: { capPerBandDb: 6, capTotalDbA: 3 },
    },
    calculationArea: {
      centerLatLng: [-33.595, 138.74],
      widthM: 9000,
      heightM: 7000,
      rotationDeg: 0,
    },
    sources: [
      // V163 4.5 MW seeded from imported xlsx — id is the slugified model name.
      { id: 'WTG-01', kind: 'wtg', catalogScope: 'global', name: 'WTG-01', latLng: [-33.5910, 138.7320], modelId: 'v163-4-5-mw', hubHeight: 148, modeOverride: 'PO4500' },
      { id: 'WTG-02', kind: 'wtg', catalogScope: 'global', name: 'WTG-02', latLng: [-33.5945, 138.7390], modelId: 'v163-4-5-mw', hubHeight: 148, modeOverride: 'PO4500' },
      { id: 'WTG-03', kind: 'wtg', catalogScope: 'global', name: 'WTG-03', latLng: [-33.5980, 138.7460], modelId: 'v163-4-5-mw', hubHeight: 148, modeOverride: 'PO4500' },
      { id: 'WTG-04', kind: 'wtg', catalogScope: 'global', name: 'WTG-04', latLng: [-33.6015, 138.7530], modelId: 'v163-4-5-mw', hubHeight: 148, modeOverride: 'PO4500' },
      { id: 'WTG-05', kind: 'wtg', catalogScope: 'global', name: 'WTG-05', latLng: [-33.6050, 138.7600], modelId: 'v163-4-5-mw', hubHeight: 148, modeOverride: 'PO4500' },
      // GE 3.6-137 — single mode 'Normal Operation (NO)'.
      { id: 'WTG-06', kind: 'wtg', catalogScope: 'global', name: 'WTG-06', latLng: [-33.5870, 138.7250], modelId: 'ge-3-6-137', hubHeight: 110 },
      { id: 'WTG-07', kind: 'wtg', catalogScope: 'global', name: 'WTG-07', latLng: [-33.5830, 138.7180], modelId: 'ge-3-6-137', hubHeight: 110 },
      // Tesla Megapack BESS pad.
      { id: 'BESS-01', kind: 'bess', catalogScope: 'global', name: 'BESS-01', latLng: [-33.5760, 138.7100], modelId: 'tesla-megapack', elevationOffset: 1.5, modeOverride: '100% fan speed 4-hour 5 Fan' },
    ],
    receivers: [
      { id: 'R01', name: 'Farmstead 12', latLng: [-33.5680, 138.7050], heightAboveGroundM: 1.5, limitDayDbA: 50, limitEveningDbA: 45, limitNightDbA: 40 },
      { id: 'R02', name: 'Cottage Lane', latLng: [-33.5750, 138.7530], heightAboveGroundM: 1.5, limitDayDbA: 50, limitEveningDbA: 45, limitNightDbA: 40 },
      { id: 'R03', name: 'Hill House',   latLng: [-33.6000, 138.6970], heightAboveGroundM: 1.5, limitDayDbA: 50, limitEveningDbA: 45, limitNightDbA: 40 },
      { id: 'R04', name: 'Smith Property', latLng: [-33.6180, 138.7600], heightAboveGroundM: 1.5, limitDayDbA: 50, limitEveningDbA: 45, limitNightDbA: 40 },
      { id: 'R05', name: 'School',       latLng: [-33.5860, 138.7700], heightAboveGroundM: 1.5, limitDayDbA: 50, limitEveningDbA: 45, limitNightDbA: 40 },
    ],
    barriers: [],
    groups: [],
  };
}

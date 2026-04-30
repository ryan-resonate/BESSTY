// Local-storage project persistence. Stand-in for Firestore until the
// back end is wired. Same shape as the eventual Firestore documents
// (see docs/firestore-schema.md), so swap-in is mechanical.

import type { Project, ProjectSummary } from './types';
import { makeDemoProject } from './demoProject';

const INDEX_KEY = 'bessty.projects.index';
const PROJECT_KEY = (id: string) => `bessty.projects.${id}`;

// One-time rename from the old "beesty.*" storage namespace. Runs at
// module load and is a no-op once the new keys exist. Kept inline rather
// than gated by a feature flag so the migration is impossible to forget.
(function migrateLegacyKeys() {
  if (typeof localStorage === 'undefined') return;
  try {
    if (!localStorage.getItem(INDEX_KEY) && localStorage.getItem('beesty.projects.index')) {
      const movedKeys: string[] = [];
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (!k || !k.startsWith('beesty.')) continue;
        const newK = 'bessty.' + k.slice('beesty.'.length);
        const v = localStorage.getItem(k);
        if (v != null) {
          localStorage.setItem(newK, v);
          localStorage.removeItem(k);
          movedKeys.push(`${k} → ${newK}`);
        }
      }
      if (movedKeys.length > 0) {
        // eslint-disable-next-line no-console
        console.info(`[BESSTY] migrated ${movedKeys.length} legacy localStorage key(s) from beesty.* to bessty.*`);
      }
    }
  } catch {
    /* migration is best-effort — never block app load */
  }
})();

interface IndexEntry {
  id: string;
  name: string;
  description: string;
  updatedAt: string;
  sourceCount: number;
  receiverCount: number;
}

function readIndex(): IndexEntry[] {
  try {
    const raw = localStorage.getItem(INDEX_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as IndexEntry[];
  } catch {
    return [];
  }
}

function writeIndex(entries: IndexEntry[]) {
  localStorage.setItem(INDEX_KEY, JSON.stringify(entries));
}

function entryOf(id: string, p: Project): IndexEntry {
  return {
    id,
    name: p.name,
    description: p.description,
    updatedAt: p.updatedAt,
    sourceCount: p.sources.length,
    receiverCount: p.receivers.length,
  };
}

/// Read project summaries for the project list screen.
export function listLocalProjects(): ProjectSummary[] {
  return readIndex()
    .map((e) => ({
      id: e.id,
      name: e.name,
      description: e.description,
      updatedAt: e.updatedAt,
      sourceCount: e.sourceCount,
      receiverCount: e.receiverCount,
    }))
    .sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
}

export function loadProject(id: string): Project | null {
  try {
    const raw = localStorage.getItem(PROJECT_KEY(id));
    if (!raw) return null;
    const p = JSON.parse(raw) as Project;
    // Forward-compat: backfill fields added after the project was saved.
    if (p.settings && !p.settings.extrapolation) {
      p.settings.extrapolation = { capPerBandDb: 6, capTotalDbA: 3 };
    }
    if (p.settings && !p.settings.propagation) {
      p.settings.propagation = {
        maxContributionDistanceM: 20000,
        treeAcceptanceTheta: 0.25,
      };
    } else if (p.settings && p.settings.propagation && p.settings.propagation.treeAcceptanceTheta == null) {
      // v0.x projects had `clusterBeyondM`/`maxClustersPerReceiver` only.
      // Backfill the new theta knob with a conservative default that
      // keeps geometric error well under 1 dB.
      p.settings.propagation.treeAcceptanceTheta = 0.25;
    }
    if (p.settings && !p.settings.topography) {
      p.settings.topography = {
        pathSamples: 12,
        virtualBarrierMinHeightM: 2,
      };
    }
    if (!p.groups) p.groups = [];
    // Backfill per-period receiver limits from legacy single `limitDbA`.
    for (const r of p.receivers) {
      if (r.limitDayDbA == null)     r.limitDayDbA     = r.limitDbA ?? 50;
      if (r.limitEveningDbA == null) r.limitEveningDbA = r.limitDbA ?? 45;
      if (r.limitNightDbA == null)   r.limitNightDbA   = r.limitDbA ?? 40;
    }
    // Migrate sources to the new catalog model.
    // - kind: inverter/transformer collapse to 'auxiliary'
    // - catalogScope: default 'global' when missing
    // - modelId: rewrite the old in-code stub IDs to the seeded catalog IDs
    const ID_MIGRATION: Record<string, string> = {
      'v163':  'v163-4-5-mw',
      'v150':  'v163-4-5-mw',   // old stub, fall back to V163 entry
      'n149':  'v163-4-5-mw',
      'mp2xl': 'tesla-megapack',
      'pwt':   'tesla-megapack',
    };
    for (const s of p.sources as Array<{
      kind: string; catalogScope?: string; modelId: string;
    }>) {
      if (s.kind === 'inverter' || s.kind === 'transformer') s.kind = 'auxiliary';
      if (!s.catalogScope) s.catalogScope = 'global';
      if (ID_MIGRATION[s.modelId]) s.modelId = ID_MIGRATION[s.modelId];
    }
    return p;
  } catch {
    return null;
  }
}

export function saveProject(id: string, project: Project) {
  const next: Project = { ...project, updatedAt: new Date().toISOString() };
  localStorage.setItem(PROJECT_KEY(id), JSON.stringify(next));
  const idx = readIndex().filter((e) => e.id !== id);
  idx.push(entryOf(id, next));
  writeIndex(idx);
}

export function deleteProject(id: string) {
  localStorage.removeItem(PROJECT_KEY(id));
  writeIndex(readIndex().filter((e) => e.id !== id));
}

export function newProjectId(): string {
  return `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/// Build an empty project shell — no sources, no receivers, no calc area.
/// The first-launch demo (`ensureDemoSeeded`) is the only place that drops
/// in pre-populated content. Everywhere else gets this blank slate so users
/// don't have to delete the demo before starting a real project.
function makeEmptyProject(name: string): Project {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    name,
    description: 'New project — add sources / receivers, set the calculation area, then Run grid.',
    createdAt: now,
    updatedAt: now,
    owner: 'anonymous',
    scenario: {
      windSpeed: 10,
      windSpeedReferenceHeight: 10,
      period: 'night',
      bandSystem: 'octave',
    },
    settings: {
      ground: { defaultG: 0.5 },
      // +3 dB hemispherical / common-practice DΩ as the new default —
      // matches the reference output of most Australian / European
      // wind-farm tools the team benchmarks against.
      dOmegaDb: 3,
      annexD: {
        barrierAbarCapDb: 3.0,
        useElevatedSourceForBarrier: true,
        applyConcaveCorrection: true,
        wtReceiverHeightMin: 4.0,
      },
      // Default to the simpler bookkeeping convention (Abar = Dz − max(Agr, 0)).
      // Numerically equivalent to strict ISO Eq 16/17 in every case; just
      // easier to reconcile with reference tools.
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
    },
    sources: [],
    barriers: [],
    receivers: [],
    groups: [],
  };
}

/// Create a brand-new empty project. Returns the new project id + the
/// freshly-saved project document.
export function createProject(name: string): { id: string; project: Project } {
  const id = newProjectId();
  const project = makeEmptyProject(name);
  saveProject(id, project);
  return { id, project };
}

/// One-shot seed: if no projects exist, drop in a demo so first launch isn't
/// an empty list.
export function ensureDemoSeeded() {
  if (readIndex().length === 0) {
    const id = 'demo-mtbrown';
    const base = makeDemoProject();
    saveProject(id, base);
  }
}

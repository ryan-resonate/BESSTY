// Local-storage project persistence. Stand-in for Firestore until the
// back end is wired. Same shape as the eventual Firestore documents
// (see docs/firestore-schema.md), so swap-in is mechanical.

import type { Project, ProjectSummary } from './types';
import { makeDemoProject } from './demoProject';

const INDEX_KEY = 'beesty.projects.index';
const PROJECT_KEY = (id: string) => `beesty.projects.${id}`;

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

/// Seed a brand-new project with the demo content (so first-time users have
/// something to look at immediately). The caller chooses the name.
export function createProject(name: string): { id: string; project: Project } {
  const id = newProjectId();
  const base = makeDemoProject();
  const project: Project = {
    ...base,
    name,
    description: 'New project — adjust sources and receivers, then Run grid.',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
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

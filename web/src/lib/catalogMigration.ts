// I2 — migrate project-local catalogs into the global (Firestore) catalog.
//
// Local catalogs are per-project copies of source models. They made sense when
// projects lived in localStorage; now they fragment the library and mean the
// same product exists under N slightly different definitions. This module plans
// the move: every local entry becomes a global one, and the project's sources
// are repointed at it.
//
// The planning is PURE and returns a description of what would change, so it
// can be unit-tested and inspected before anything is written. Actually
// committing the upserts is the caller's job.
//
// Collision rule: a local entry whose id already exists globally is reused when
// the definitions match, and written under a derived id when they DON'T —
// silently adopting a global entry with different sound power would change a
// project's computed levels, which a catalog migration has no business doing.

import type { CatalogEntry, Project, Source } from './types';

/// Fields that don't affect what the entry MEANS acoustically or dimensionally.
/// Two entries differing only in these are the same product.
const VOLATILE: Array<keyof CatalogEntry> = ['origin', 'source', 'displayName'];

/// Structural comparison ignoring bookkeeping fields. Key order is normalised
/// so two entries built by different code paths still compare equal.
export function sameEntryContent(a: CatalogEntry, b: CatalogEntry): boolean {
  const strip = (e: CatalogEntry) => {
    const c = { ...e } as Record<string, unknown>;
    for (const k of VOLATILE) delete c[k as string];
    return stableStringify(c);
  };
  return strip(a) === strip(b);
}

function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}

export interface LocalCatalogMigration {
  /// Entries to write into the global catalog (may carry a derived id).
  upserts: CatalogEntry[];
  /// Local entries that already exist globally, unchanged — nothing to write.
  reused: string[];
  /// Local id → global id, where the two differ because of a collision.
  renamed: Array<{ from: string; to: string }>;
  /// The project with sources repointed at global and `localCatalog` dropped.
  project: Project;
  /// Sources whose model reference changed.
  sourcesRepointed: number;
}

/// Work out how a project's local catalog folds into the global one.
///
/// `projectKey` disambiguates derived ids on collision — pass the project id so
/// two projects colliding on the same local id don't then collide with each
/// other.
export function planLocalCatalogMigration(
  project: Project,
  globalEntries: readonly CatalogEntry[],
  projectKey: string,
): LocalCatalogMigration {
  const locals = project.localCatalog ?? [];
  const byGlobalId = new Map(globalEntries.map((e) => [e.id, e]));

  const upserts: CatalogEntry[] = [];
  const reused: string[] = [];
  const renamed: Array<{ from: string; to: string }> = [];
  /// local id → the global id its sources should now point at.
  const idMap = new Map<string, string>();

  for (const local of locals) {
    const clash = byGlobalId.get(local.id);
    if (!clash) {
      upserts.push({ ...local, origin: 'user' });
      idMap.set(local.id, local.id);
      continue;
    }
    if (sameEntryContent(clash, local)) {
      // Same product already in the global library — point at it, write nothing.
      reused.push(local.id);
      idMap.set(local.id, local.id);
      continue;
    }
    // Same id, different definition. Adopting the global one would silently
    // change this project's levels, so keep the project's own version under a
    // derived id.
    const derived = `${local.id}-from-${projectKey}`;
    upserts.push({ ...local, id: derived, origin: 'user' });
    renamed.push({ from: local.id, to: derived });
    idMap.set(local.id, derived);
  }

  let sourcesRepointed = 0;
  const sources: Source[] = project.sources.map((s) => {
    if (s.catalogScope !== 'local') return s;
    const target = idMap.get(s.modelId);
    // A source pointing at a local id that isn't in localCatalog is already
    // broken; leave it exactly as-is rather than inventing a target.
    if (!target) return s;
    sourcesRepointed++;
    return { ...s, catalogScope: 'global' as const, modelId: target };
  });

  // BESS group segments carry their own catalog references and must move too,
  // or a group re-materialises against a model that no longer resolves.
  const bessGroups = (project.bessGroups ?? []).map((g) => ({
    ...g,
    sequence: g.sequence ? repointSequence(g.sequence, idMap) : g.sequence,
  }));

  const next = { ...project, sources, bessGroups };
  delete (next as { localCatalog?: unknown }).localCatalog;

  return { upserts, reused, renamed, project: next, sourcesRepointed };
}

/// Repoint every segment in a (possibly nested) BESS sequence.
function repointSequence<T>(items: T[], idMap: Map<string, string>): T[] {
  return (items as unknown[]).map((it) => {
    const item = it as { kind?: string; row?: { segments?: unknown[] }; items?: unknown[] };
    if (item.kind === 'row' && item.row?.segments) {
      return {
        ...item,
        row: {
          ...item.row,
          segments: item.row.segments.map((sgRaw) => {
            const sg = sgRaw as { catalogScope?: string; modelId?: string };
            if (sg.catalogScope !== 'local') return sgRaw;
            const target = idMap.get(sg.modelId ?? '');
            if (!target) return sgRaw;
            return { ...sg, catalogScope: 'global', modelId: target };
          }),
        },
      };
    }
    if (item.items) return { ...item, items: repointSequence(item.items, idMap) };
    return it;
  }) as T[];
}

/// Which bundled seed entries are missing from the global catalog.
///
/// Idempotent by construction: run it twice and the second run returns nothing.
/// Compares by id only — a seed entry someone has since EDITED globally must
/// not be reverted to the bundled version.
export function seedEntriesToUpsert(
  seed: readonly CatalogEntry[],
  globalEntries: readonly CatalogEntry[],
): CatalogEntry[] {
  const have = new Set(globalEntries.map((e) => e.id));
  return seed.filter((e) => !have.has(e.id));
}

/// One-line summary for the migration toast.
export function describeMigration(m: LocalCatalogMigration): string {
  const bits: string[] = [];
  if (m.upserts.length) bits.push(`${m.upserts.length} model${m.upserts.length === 1 ? '' : 's'} moved to the global catalog`);
  if (m.reused.length) bits.push(`${m.reused.length} already there`);
  if (m.renamed.length) bits.push(`${m.renamed.length} renamed to avoid a clash`);
  if (bits.length === 0) return 'No local models to migrate.';
  return `${bits.join(', ')}. ${m.sourcesRepointed} source${m.sourcesRepointed === 1 ? '' : 's'} repointed.`;
}

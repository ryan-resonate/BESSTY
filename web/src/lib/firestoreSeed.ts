// One-shot seeding of the example projects into Firestore.
//
// The GP BESS + Tarong WF examples used to live in localStorage via
// `storage.ts::ensureDemoSeeded`. With the Firestore migration we want them
// to live in the cloud so every signed-in user (not just whoever happens
// to have visited before) sees them in their "All projects" tab.
//
// This is a manual admin action (not auto-run) for two reasons:
//   1. Idempotency — auto-seed would have to detect "already done", which
//      is fragile given the projects could be renamed/deleted/customised
//      by the admin after seeding.
//   2. Authorship — the seeded projects show up as owned by whichever
//      account triggered the seed. Letting the admin pick the moment
//      makes that intentional.
//
// Invoked from the ProjectListScreen "Seed examples" button, which only
// appears when the caller is admin AND the project list is empty.

import { createProject } from './firestoreProjects';
import { makeGpBessProject, makeTarongWfProject } from './demoProject';

export interface SeedOwner {
  uid: string;
  displayName: string;
  email: string;
}

/// Seed both demos and return the created project ids.
export async function seedExampleProjects(owner: SeedOwner): Promise<string[]> {
  const gpBess = makeGpBessProject();
  const tarong = makeTarongWfProject();
  const ids: string[] = [];

  // Done sequentially rather than in parallel to keep the per-doc
  // updatedAt strictly ordered (newest first when listed) and to surface
  // a single error cleanly if either write fails.
  ids.push(await createProject(gpBess.name, gpBess, owner));
  ids.push(await createProject(tarong.name, tarong, owner));
  return ids;
}

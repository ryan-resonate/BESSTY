// Security rules for `shares/{token}`, run against the Firestore emulator.
//
// These are the only tests in the repo that exercise the thing that ACTUALLY
// protects a share. Everything else — the token generator, the allowlist in the
// Cloud Function, the viewer's expiry check — is a layer on top. If the rules
// are wrong, all of it is decoration: anyone can read the collection, or write
// to it, and no amount of client-side care matters.
//
// Run with:  npm run test:rules   (from web/)
// which starts the emulator, runs this file, and shuts the emulator down.
//
// REQUIRES A JDK 21+ ON PATH. The Firestore emulator is a Java program, and
// firebase-tools 15 refuses anything older; this machine currently has JRE 1.8
// only, so the suite is written and wired but has never been run here. That
// matters more than a normal "TODO": the plan makes a green emulator suite a
// non-negotiable gate before share links ship, precisely because these rules
// are the only thing actually protecting a public URL. Treat every claim in
// this file as unverified until it has run.
//
//   winget install Microsoft.OpenJDK.21     (or any JDK 21+)
//   cd web && npm run test:rules
//
// The five denials the plan names are each a separate test below, plus the
// grants, because a rule that denies everything would pass a deny-only suite.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from '@firebase/rules-unit-testing';
import {
  collection, deleteDoc, doc, getDoc, getDocs, setDoc, updateDoc,
} from 'firebase/firestore';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..');

const OWNER = 'owner-uid';
const STRANGER = 'stranger-uid';
const TOKEN = 'A'.repeat(32);
const OTHER_TOKEN = 'B'.repeat(32);

/// Far enough out that the test cannot fail by sitting in CI for an hour.
const FUTURE = new Date(Date.now() + 90 * 864e5);
const PAST = new Date(Date.now() - 1 * 864e5);

let env;

before(async () => {
  env = await initializeTestEnvironment({
    projectId: 'rc-beesty-rules-test',
    firestore: {
      rules: readFileSync(join(REPO, 'firestore.rules'), 'utf8'),
      host: '127.0.0.1',
      port: 8080,
    },
  });
});

after(async () => { await env?.cleanup(); });

/// Seed documents with rules DISABLED, so a fixture cannot be shaped by the
/// very rules under test.
async function seed(docs) {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    for (const [path, data] of Object.entries(docs)) {
      await setDoc(doc(db, path), data);
    }
  });
}

function liveShare(over = {}) {
  return {
    ownerUid: OWNER,
    createdAt: new Date().toISOString(),
    expiresAt: FUTURE,
    revoked: false,
    label: 'Site A',
    draftOrFinal: 'draft',
    payload: { projectName: 'Site A', states: [] },
    ...over,
  };
}

const anon = () => env.unauthenticatedContext().firestore();
const owner = () => env.authenticatedContext(OWNER).firestore();
const stranger = () => env.authenticatedContext(STRANGER).firestore();

// ------------------------------------------------------------------ grants

test('a signed-out reader can fetch a live share by its exact token', async () => {
  // The whole feature: a client with the link and no account reads the share.
  await seed({ [`shares/${TOKEN}`]: liveShare() });
  const snap = await assertSucceeds(getDoc(doc(anon(), 'shares', TOKEN)));
  assert.equal(snap.data().label, 'Site A');
});

// ---------------------------------------------------------------- denials

test('LIST is denied — the collection cannot be enumerated', async () => {
  // The single most important rule here. A token is only a secret while the
  // collection cannot be walked; with `list` granted, anyone could harvest
  // every live share in one query and the ~190 bits would protect nothing.
  //
  // Note `allow read` would have granted BOTH get and list, which is exactly
  // how this gets reintroduced by someone tidying the rules.
  await seed({
    [`shares/${TOKEN}`]: liveShare(),
    [`shares/${OTHER_TOKEN}`]: liveShare({ label: 'Site B' }),
  });
  await assertFails(getDocs(collection(anon(), 'shares')));
  // Not merely an anonymous restriction — nobody may enumerate, including the
  // owner of every share in it.
  await assertFails(getDocs(collection(owner(), 'shares')));
});

test('an EXPIRED share is denied, not merely hidden by the viewer', async () => {
  await seed({ [`shares/${TOKEN}`]: liveShare({ expiresAt: PAST }) });
  await assertFails(getDoc(doc(anon(), 'shares', TOKEN)));
  // Expiry binds the owner too: it is the share that has lapsed, not the
  // reader's permission to see it.
  await assertFails(getDoc(doc(owner(), 'shares', TOKEN)));
});

test('a REVOKED share is denied while it is still within its expiry', async () => {
  await seed({ [`shares/${TOKEN}`]: liveShare({ revoked: true }) });
  await assertFails(getDoc(doc(anon(), 'shares', TOKEN)));
  await assertFails(getDoc(doc(owner(), 'shares', TOKEN)));
});

test('a share cannot be CREATED from a client, even by a signed-in user', async () => {
  // Creation is the Cloud Function's job because the function is what holds
  // the field allowlist. A client that could create a share doc could put
  // anything in it — including fields copied straight off a project.
  await seed({});
  await assertFails(setDoc(doc(owner(), 'shares', TOKEN), liveShare()));
  await assertFails(setDoc(doc(anon(), 'shares', TOKEN), liveShare()));
});

test('a share cannot be DELETED from a client', async () => {
  // Deleting would orphan any Storage payload; revoking is the supported way
  // to kill a link.
  await seed({ [`shares/${TOKEN}`]: liveShare() });
  await assertFails(deleteDoc(doc(owner(), 'shares', TOKEN)));
  await assertFails(deleteDoc(doc(stranger(), 'shares', TOKEN)));
});

// ------------------------------------------------------ revoke, and tamper

test('the owner may revoke, and that is the ONLY field they may touch', async () => {
  await seed({ [`shares/${TOKEN}`]: liveShare() });
  await assertSucceeds(updateDoc(doc(owner(), 'shares', TOKEN), { revoked: true }));
});

test('a stranger cannot revoke someone else’s share', async () => {
  await seed({ [`shares/${TOKEN}`]: liveShare() });
  await assertFails(updateDoc(doc(stranger(), 'shares', TOKEN), { revoked: true }));
  await assertFails(updateDoc(doc(anon(), 'shares', TOKEN), { revoked: true }));
});

test('revoking cannot be UNDONE by a client', async () => {
  // `revoked` is one-way from a client. Un-revoking is republishing, which
  // mints a fresh token — so a link that was withdrawn stays dead even if the
  // owner's account is later compromised.
  await seed({ [`shares/${TOKEN}`]: liveShare({ revoked: true }) });
  await assertFails(updateDoc(doc(owner(), 'shares', TOKEN), { revoked: false }));
});

test('TAMPER: the owner cannot extend expiry, rewrite the payload, or reassign ownership', async () => {
  // Each of these is a separate escalation:
  //   - expiresAt  → a share that outlives what the rules will enforce
  //   - payload    → arbitrary content on a public URL, bypassing the allowlist
  //   - ownerUid   → handing revocation rights to someone else
  //   - label      → cosmetic, but it is rendered in the viewer, and the point
  //                  of the rule is that NOTHING but `revoked` moves
  await seed({ [`shares/${TOKEN}`]: liveShare() });
  const d = doc(owner(), 'shares', TOKEN);
  await assertFails(updateDoc(d, { expiresAt: new Date(Date.now() + 3650 * 864e5) }));
  await assertFails(updateDoc(d, { payload: { projectName: 'anything', states: [] } }));
  await assertFails(updateDoc(d, { ownerUid: STRANGER }));
  await assertFails(updateDoc(d, { label: 'Renamed' }));
  await assertFails(updateDoc(d, { draftOrFinal: 'final' }));
  // …including alongside a legitimate revoke, which is the shape someone would
  // actually try: piggy-back the change on the one write that is allowed.
  await assertFails(updateDoc(d, { revoked: true, expiresAt: new Date(Date.now() + 3650 * 864e5) }));
  await assertFails(updateDoc(d, { revoked: true, payload: { projectName: 'x', states: [] } }));
  // A new field nobody has thought of yet is refused for the same reason: the
  // rule names what may CHANGE, not what may exist.
  await assertFails(updateDoc(d, { revoked: true, somethingNew: 1 }));
});

// -------------------------------------------------------------- cross-path

test('a share grants nothing anywhere else in the database', async () => {
  // The share collection is the only publicly readable thing here. An
  // unauthenticated reader holding a token must not gain a foothold on
  // projects, users, or the catalog — the data the share was carefully built
  // to summarise without exposing.
  await seed({
    [`shares/${TOKEN}`]: liveShare(),
    'projects/p1': { ownerUid: OWNER, name: 'Site A', visibility: 'public' },
    [`users/${OWNER}`]: { email: 'someone@resonate-consultants.com', allowed: true },
    'catalogsGlobal/c1': { displayName: 'V163' },
  });
  const db = anon();
  await assertFails(getDoc(doc(db, 'projects', 'p1')));
  await assertFails(getDoc(doc(db, 'users', OWNER)));
  await assertFails(getDoc(doc(db, 'catalogsGlobal', 'c1')));
  await assertFails(getDocs(collection(db, 'projects')));
  // A public project is readable by SIGNED-IN users only — the share path does
  // not widen that.
  await assertSucceeds(getDoc(doc(stranger(), 'projects', 'p1')));
});

test('a share document is not a subcollection foothold', async () => {
  // Rules do not cascade to subcollections, but a future refactor that adds
  // `match /{document=**}` under shares would be a silent hole. Pin it.
  await seed({ [`shares/${TOKEN}`]: liveShare() });
  await env.withSecurityRulesDisabled(async (ctx) => {
    await setDoc(doc(ctx.firestore(), `shares/${TOKEN}/secret/s1`), { x: 1 });
  });
  await assertFails(getDoc(doc(anon(), `shares/${TOKEN}/secret/s1`)));
});

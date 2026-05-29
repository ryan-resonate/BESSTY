# Upgrading rc-beesty to the Blaze plan (deferred)

The BESSTY Firebase project (`rc-beesty`) is currently on the **Spark
(free) plan**. Most of the app works on Spark, but two whole areas are
gated behind a Blaze upgrade for newly-created projects:

1. **Cloud Functions** (`functions/src/index.ts`) — Functions Gen 1
   and Gen 2 both need Cloud Build, Artifact Registry, and Cloud Run,
   which Spark doesn't include.
2. **Firebase Storage** (DEM persistence, `storage.rules` +
   `web/src/lib/firestoreStorage.ts`) — as of late 2024, Google
   started requiring Blaze for Storage on newly-created projects
   (existing projects with Storage already enabled were grandfathered
   in). `rc-beesty` was created after the change, so its Storage
   bucket can't be set up without upgrading.

This document records the state, the workarounds we've adopted, and
the steps to upgrade if/when we move to Blaze.

## Current deploy command (Spark)

While on Spark, deploy only the Firestore pieces:

```powershell
firebase deploy --only firestore:rules,firestore:indexes
```

**Do NOT** include `storage` or `functions` in the `--only` list — both
will fail their pre-flight API enablement on Spark. The rules / indexes
file in the repo will quietly diverge from production until the upgrade
day, which is fine: the source of truth stays in git either way.

## What's deferred while on Spark

### Cloud Functions

The two functions in `functions/src/index.ts` are written, type-checked,
and ready to deploy, but **not running in production**:

- **`onAuthUserCreate`** — Gen 1 auth trigger. Would run on every new
  Firebase Auth account creation to:
  - check the email domain is `@resonate-consultants.com` OR is
    present in the `authAllowlist` Firestore collection,
  - upsert the canonical `users/{uid}` profile doc with the right
    `allowed` flag,
  - disable the Auth account if the email is not allowed (so
    bypassers can't sign in even after verifying).

- **`adminSetUserFlag`** — Gen 2 callable. Would let an existing
  admin promote / demote other users (toggle `flags.admin` etc.)
  from an in-app admin UI without touching the Firebase Console.

### Firebase Storage — DEM persistence

The DEM-persistence feature (`web/src/lib/firestoreStorage.ts` +
`storage.rules`) writes uploaded GeoTIFFs to
`projects/{projectId}/dem/...` in the Firebase Storage bucket. On Spark
the bucket can't be enabled at all (`firebasestorage.googleapis.com`
won't enable; `firebase deploy --only storage` fails with
"Firebase Storage has not been set up on project").

**User-visible impact on Spark**: a user can still upload a DEM in the
Import tab and use it for the session. The parse succeeds, the
DemRaster lives in browser memory, both the point and grid solvers see
it, and the DEM survives normal editor activity. What fails is the
upload-to-cloud step — SidePanel surfaces a yellow warning
("DEM loaded for this session but cloud save failed: ..."). Reloading
the page or opening the project on another machine loses the DEM and
falls back to AWS Terrain Tiles.

Workaround: re-upload the DEM each session. Annoying but not blocking.

## Workarounds in place (Spark-mode behaviour)

Because the server-side gate isn't running, we lean on three
client-side / manual mitigations:

1. **The LoginScreen signup form rejects non-Resonate emails**
   (`web/src/lib/auth.ts::signUp` calls `isResonateEmail` before
   `createUserWithEmailAndPassword`). This blocks the normal path
   — anyone using the form sees a clear "self-signup is currently
   limited" error.
2. **`ensureProfileDoc` on first verified sign-in** writes the
   `users/{uid}` document with `allowed: isResonateEmail(email)`. A
   non-Resonate user who bypasses the form (e.g. via direct SDK
   calls) would land with `allowed: false`.
3. **Admin promotion is manual**: bump `flags.admin = true` directly
   in Firestore Console → Data → users/{uid}. Same workflow as the
   initial bootstrap. Documented in the project setup notes.

### Residual risk

A determined non-Resonate user could:
- Create an Auth account via the Firebase Auth REST API or SDK
  (bypassing our form). They'd still need to verify their email.
- Write their `users/{uid}` doc themselves with `allowed: true`
  (the current security rules don't enforce a domain check on
  this field).

If this matters, periodically check **Firebase Console →
Authentication → Users** for unexpected accounts and disable them
manually (⋮ menu → Disable account). With the team this small the
risk of an unnoticed signup is low.

A stricter Spark-mode option is to add a domain regex to the
`users/{uid}` create rule in `firestore.rules`. That blocks profile
creation for non-Resonate emails entirely, at the cost of breaking
the future allowlist flow. We've not done this — it's an easy
follow-up if you decide you want it.

## When to upgrade to Blaze

Consider upgrading if any of these become true:

- You want **persistent DEMs** — the bigger of the two papercuts in
  daily use. Without Blaze, every session loses the uploaded GeoTIFF
  and falls back to AWS Terrain Tiles. With Blaze, uploads land in
  Firebase Storage and auto-download on project open.
- You want to extend BESSTY access to non-Resonate collaborators
  (i.e. you want the `authAllowlist` flow to work).
- You want server-side enforcement of the domain rule (closes the
  SDK-bypass loophole described above).
- You want an in-app admin UI for managing user flags and the
  allowlist (no more Console-clicking).
- You're approaching Spark's free-tier quotas
  (50K Firestore reads/day, 20K writes/day, 1 GB storage). At
  BESSTY's expected usage we're a long way off, but the cap is real.

## Expected cost on Blaze

For an app of BESSTY's scale (a small team, a handful of projects,
infrequent edits) Blaze is **likely $0–$5/month** because the free
tier carries over and covers most/all of the usage. Set a budget
alert at AUD $10/month in the Firebase Console as insurance.

## Upgrade procedure (when you're ready)

1. Firebase Console → bottom of the left sidebar → **Upgrade →
   Blaze (Pay as you go)**.
2. Add a billing card. Set a budget alert (AUD $10/month
   recommended).
3. **Enable Firebase Storage**: Console → Build → Storage → Get
   started → Production mode → Location: `australia-southeast1`
   (matches Firestore). Now possible because Blaze unblocks it.
4. Back at a PowerShell prompt in the repo root:

   ```powershell
   firebase deploy --only functions,storage
   ```

   The first run will:
   - prompt to enable Cloud Build, Artifact Registry, and Cloud Run
     (say yes to all),
   - install the functions' dependencies on the server,
   - push the `storage.rules` file from the repo to the new bucket,
   - take ~3–5 minutes total.

5. Verify the deploy in **Firebase Console → Functions** — you
   should see `onAuthUserCreate` and `adminSetUserFlag` listed.
   Verify Storage rules in **Console → Storage → Rules**.

## What changes after upgrading

- **DEMs persist** — uploads land in Firebase Storage, auto-download
  on project open. The "Loaded for this session but cloud save
  failed" warning in SidePanel disappears; new users opening a
  project with a saved DEM see "Loading saved DEM…" and then the
  raster materialises automatically.
- **Self-signup tightens** — the `onAuthUserCreate` trigger runs on
  every new account; non-allowed accounts are immediately disabled.
  The client-side form check stays as a UX courtesy.
- **`authAllowlist` becomes useful** — admins can drop emails into
  the collection (via Console or, eventually, an admin UI) and
  those users will be permitted to sign up.
- **`ensureProfileDoc` no longer races the function** — the function
  writes the profile before the client gets a chance, with the
  correct `allowed` value. Client-side `setDoc` uses `merge: true`
  so the harmless echo is a no-op.
- **`adminSetUserFlag` is callable from the app** — wiring a small
  admin UI on top of it is a follow-up task (5–6 hour estimate).

## What to test after upgrading

Quick sanity-check pass:

1. Sign up with a `@resonate-consultants.com` email → verification
   email arrives → verify → land in the app. (Should work
   identically to Spark mode.)
2. Try to sign up with a non-Resonate email (e.g. via the form's
   error path or directly through the SDK from the browser
   console). Either rejection or disabled account is the
   expected outcome — they shouldn't be able to sign in.
3. From the Firebase Console, add an `authAllowlist/{hash}` doc
   for a colleague's external email. Have them sign up — they
   should be allowed through.
4. Verify your admin flag still works (Project tab → ability to
   delete others' projects via admin override etc.).
5. **DEM round-trip**: open a project, upload a GeoTIFF in the
   Import tab → progress bar reaches 100% → "Cloud-saved · X MB"
   appears. Reload the page → "Loading saved DEM…" → DEM
   re-appears without re-prompting. Open the same project from
   another browser / signed-in account that can read it → same
   auto-load behaviour.

## Files involved

Cloud Functions:
- `functions/src/index.ts` — the function code itself
- `functions/package.json` / `tsconfig.json` — function build setup
- `firebase.json` — Functions codebase declaration
- `firestore.rules` — references `flags.admin` (already deployed)
- `web/src/lib/auth.ts` — client-side `isResonateEmail` check that
  pairs with the server-side enforcement

Firebase Storage (DEM persistence):
- `storage.rules` — read/write gating per project access rules,
  200 MB cap. Ready to deploy; held back until Blaze enables the
  Storage bucket.
- `firebase.json` — `storage` block already references the rules
  file. Safe to leave in place; deploy commands just have to
  exclude it via `--only firestore:rules,firestore:indexes`.
- `web/src/lib/firestoreStorage.ts` — uploadProjectDem /
  downloadProjectDem / deleteProjectDem. On Spark the upload call
  fails at the SDK level (no bucket) and SidePanel falls through
  to the "loaded for session only" warning path.

## Other Blaze-only things on the wishlist

Beyond the two functions above, a couple of nice-to-haves that
become possible only once we're on Blaze:

- **Project-delete Storage cleanup function.** Currently `ProjectListScreen.handleDelete`
  best-effort deletes the project's DEM from Firebase Storage before
  deleting the project doc. If the user has the tab open while
  offline, or the storage delete fails for any reason, the storage
  object is orphaned. On Blaze we can add a `functions/v2/firestore`
  trigger on `projects/{id}` onDelete that scans
  `projects/{id}/dem/*` and deletes anything left. Pairs neatly with
  the rules' "writer can delete" path so the cleanup is authorised
  even after the project doc is gone.

- **Periodic orphan-storage sweep.** A scheduled function that lists
  the `projects/` prefix in Storage and deletes anything whose
  parent doc doesn't exist in Firestore. Insurance for the case
  above.

- **Admin allowlist editor UI.** Pairs with `adminSetUserFlag` to give
  admins a real screen for promoting / demoting users and adding
  external collaborators to `authAllowlist`. Right now those flows
  are Console-only.

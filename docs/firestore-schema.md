# Firestore schema (rc-beesty)

This doc is the source of truth for the Firestore data model. Mirrors
the shapes used by `web/src/lib/firestoreProjects.ts`,
`web/src/lib/firestoreCatalog.ts`, and `web/src/lib/auth.ts`.

## 1. Top-level structure

```
users/
  {uid}                              user profile + flags
    catalogs/
      {entryId}                      personal library entries (per-user)

projects/
  {projectId}                        the live project document
    versions/
      {versionId}                    immutable save-point snapshots

catalogsGlobal/
  {entryId}                          shared library, RW by any signed-in user

authAllowlist/
  {hashedEmail}                      manually-added non-Resonate emails
                                     (admin-only writes; read by Cloud Functions)
```

Cloud Storage (for future raw-asset uploads, not yet wired):

```
user-uploads/{projectId}/dem/{filename}
user-uploads/{projectId}/spectra/{filename}
```

## 2. User profile — `users/{uid}`

Created on first verified sign-in by the client; mutated by Cloud
Functions (allowlist enforcement, admin promotion).

```jsonc
{
  "email": "first.last@resonate-consultants.com",
  "displayName": "First Last",
  "createdAt": <serverTimestamp>,
  "allowed": true,        // set by Cloud Function based on domain or allowlist
  "flags": {
    "admin": false        // manual one-time bootstrap, then via admin UI
  }
}
```

Rules: owner can read/write their own profile EXCEPT `flags` (admin-only).
Other signed-in users can read `displayName` + `email` for the projects
list owner column.

## 3. Project document — `projects/{projectId}`

The same `Project` shape as `web/src/lib/types.ts`, plus a small set of
Firestore-specific fields needed for security rules + the list view.
The whole project is a single doc — sub-MB target as before.

```jsonc
{
  "schemaVersion": 1,
  "name": "Tarong WF",
  "description": "...",

  // --- ownership + visibility (Firestore-specific) ---
  "ownerUid": "Abc123…",
  "ownerDisplayName": "Ryan McKay",     // denormalised for the project list
  "visibility": "public",                // "public" | "private"
  "allowedUserIds": [],                  // additional editors when private

  // --- timestamps ---
  "createdAt": <serverTimestamp>,
  "updatedAt": <serverTimestamp>,
  "updatedByUid": "Abc123…",

  // --- the project payload (unchanged from the local-storage version) ---
  "scenario":         { ... },           // see types.ts::Scenario
  "settings":         { ... },           // see types.ts::ProjectSettings
  "sources":          [ ... ],           // see types.ts::Source[]
  "barriers":         [ ... ],           // see types.ts::Barrier[]
  "receivers":        [ ... ],           // see types.ts::Receiver[]
  "groups":           [ ... ],           // see types.ts::Group[]
  "calculationArea":  { ... },           // see types.ts::CalculationArea
  "localCatalog":     [ ... ]            // see types.ts::CatalogEntry[]
}
```

### Visibility semantics

| Field | Read access | Write access |
|---|---|---|
| `visibility: 'public'` | any signed-in user | owner + `allowedUserIds` + admins |
| `visibility: 'private'` | owner + `allowedUserIds` + admins | owner + `allowedUserIds` + admins |

Owner is always implicitly on the allowlist. Admins always have full
access regardless of visibility.

## 4. Version snapshots — `projects/{projectId}/versions/{versionId}`

Immutable save points. Created on demand from the live project doc.
Reverting clones a snapshot back into the live doc (the snapshot
itself stays put).

```jsonc
{
  "label": "Pre-rezoning revision",
  "createdAt": <serverTimestamp>,
  "createdByUid": "Abc123…",
  "createdByDisplayName": "Ryan McKay",
  "snapshot": { /* whole `Project` payload from §3 */ }
}
```

Rules: read = parent project's read access; create = parent's write
access; **no update, no delete** (snapshots are forever — admins can
hard-delete via the Console if absolutely needed).

## 5. Catalog — global + personal

`catalogsGlobal/{entryId}` and `users/{uid}/catalogs/{entryId}` share
the `CatalogEntry` shape from `types.ts`, plus two Firestore-specific
fields:

```jsonc
{
  "id": "v163-4-5-mw",
  "kind": "wtg",
  "displayName": "Vestas V163-4.5 MW",
  "manufacturer": "Vestas",
  "defaultMode": "PO4500",
  "rotorDiameterM": 163,
  "hubHeights": [119, 148, 166, 174],
  "modes": [ ... ],                      // see types.ts::CatalogModeData
  "source": "imported from V163.xlsx",
  "origin": "user",                      // "seed" | "user"

  "createdByUid": "Abc123…",             // global library only
  "updatedAt": <serverTimestamp>
}
```

Per the agreed model: **global library is writable by any signed-in
user**, personal library is writable only by its owner.

## 6. Auth allowlist — `authAllowlist/{hashedEmail}`

Used by the `onUserCreate` Cloud Function to permit non-Resonate sign-ups.
Admin-only writes; never read directly by client code (the function
reads it with admin SDK credentials).

```jsonc
{
  "email": "consultant@other-firm.com",
  "addedByUid": "Abc123…",
  "addedAt": <serverTimestamp>,
  "note": "External reviewer for Tarong WF project"
}
```

Document ID = SHA-256 of the email (lowercase, trimmed) — keeps the
collection name from leaking email addresses in URLs.

## 7. Indexes

Composite indexes the project-list queries need:

- `projects` ordered by `updatedAt desc`, filtered by `ownerUid` (My projects tab).
- `projects` ordered by `updatedAt desc`, filtered by `visibility == 'public'` (All projects tab — fast path).
- `projects` ordered by `updatedAt desc`, filtered by `allowedUserIds array-contains <uid>` (private-with-me tab merge).

Firestore prompts for these on first query via a console link if
missing — we'll deploy them properly via `firestore.indexes.json` in
task #10.

## 8. Size projections

- Project doc with ~100 WTGs, 60 receivers, full settings: ~100 KB JSON, well under the 1 MB doc limit.
- Version snapshot: same as the project doc above (~100 KB). 10 versions per project = 1 MB total in the subcollection — fine.
- Catalog entry (WTG with 3 modes × 10 wind speeds × 10 bands): ~5 KB. The whole global library is unlikely to exceed 1 MB.

## 9. Security rules (target)

Stage-1 (deployed now in the Console) is permissive: any signed-in
user can read/write everything. The full ruleset (task #10) implements
the visibility + admin model above. Tracked in `firestore.rules` at
the repo root once Cloud Functions / CLI deploy is set up.

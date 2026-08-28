# Share links — pre-ship audit

Share links publish project data to a **public URL with no authentication**.
The token in the address is the entire access control. That makes this the
highest-consequence feature in BESSTY: every other bug produces a wrong number,
this one can produce a disclosure.

The plan (`docs/beesty-feature-plans.md`, idea 8) makes this checklist a
**non-negotiable gate before the feature is enabled for users**. Nothing below
is ticked on the strength of having written the code carefully.

Status keys: **[✓]** verified · **[ ]** not yet verified · **[!]** blocked ·
**[?]** open decision for Ryan.

---

## 0. Blockers — the feature cannot run at all until these clear

- **[!] Cloud Functions are not deployed.** `rc-beesty` is on the Spark plan.
  `publishShare` is written and type-checks but has never executed. Publishing
  fails with a message pointing at `docs/blaze-upgrade.md`.
  *Why it is not worked around:* Q32 puts payload construction in a function so
  the field allowlist runs somewhere a client cannot influence. Moving it
  client-side to dodge the billing tier would remove the feature's only real
  defence.

- **[!] Firebase Storage has no bucket.** The overflow path for payloads over
  800 kB is written but unreachable; publishing refuses at that size with an
  actionable message rather than writing a share whose payload cannot be
  fetched. Storage rules for `shares/{token}/…` are in the repo, undeployed.

- **[!] The rules emulator suite cannot run on the development machine.**
  Diagnosed 2026-08-28, and recorded here so it is not re-derived:

  1. `firebase-tools` 15 requires a JDK 21+. JDK 21 **is** installed
     (`C:\Program Files\Microsoft\jdk-21.0.12.101-hotspot`), but `java`
     resolves to the Oracle `java8path` shim, which sits earlier on PATH — so
     `java -version` reports 1.8 and the emulator refuses to start.
  2. With JDK 21 forced onto PATH, the emulator still dies. The cause is not
     Firebase: `Selector.open()` fails in a six-line Java program with
     "Unable to establish loopback connection", under BOTH the WEPoll and the
     legacy Windows selector providers. Node opens loopback sockets on the same
     machine without complaint, so this is endpoint security scoped to
     `java.exe`. No emulator version, temp directory or JVM flag works around
     it.

  **Resolved by running the suite in CI instead** —
  `.github/workflows/rules-tests.yml`, on every push touching the rules. Until
  that workflow has gone green at least once, **every claim in section 2 below
  remains unverified.** Check the Actions tab.

  To run locally anyway, an IT exclusion allowing `java.exe` to open loopback
  connections would do it; `netsh winsock reset` (admin, then reboot) is worth
  trying if the machine has stale Winsock LSPs.

---

## 1. Token

- **[✓] Entropy ≥190 bits.** 32 base62 characters = 190.4 bits.
  Test: `share.test.ts`, "a token carries more than 190 bits of entropy".
- **[✓] CSPRNG, not `Math.random`.** `crypto.getRandomValues` in the client,
  `crypto.randomBytes` in the function.
- **[✓] Uniform draw.** 256 % 62 = 8, so bytes 248–255 are rejected rather than
  folded; a plain modulo would make A–H ~3% likelier.
  Test: "every character is drawn uniformly — no biased tail folded back in".
- **[✓] Shape validated before use.** `isShareToken` requires exactly
  `[A-Za-z0-9]{32}` before anything addresses a document path, so a token can
  never contain a path separator or traversal segment.
- **[✓] Never logged.** The function logs `uid`, `projectId`, state count and
  size — never the token. `revokeShare` redacts it in its warning path.
  **[ ] Re-check after any change to logging**, including error paths.
- **[✓] Kept out of the document title** so it does not land in browser history
  UI or screen recordings.
- **[✓] Not sent to a server.** The app uses a HashRouter, so the token lives
  in the URL fragment and is never transmitted — it cannot appear in a web
  server access log.
- **[✓] Analytics is disabled on share routes.** FOUND AND FIXED during this
  audit, not by inspection of intent: `measurementId` is set in `.env.local`,
  `maybeLoadAnalytics()` fires from `getApp()`, and the viewer reaches
  `getApp()` via `db()`. GA4's automatic `page_view` reports `page_location` —
  the full URL **including the fragment**, which is the live token — so every
  opened share would have handed its token to Google, retained there long after
  the share was withdrawn. `maybeLoadAnalytics` now returns early on a
  `#/share/` route.
  *Residual, accepted:* a signed-in user who edits the address bar into a share
  link already has analytics loaded from the previous page. The protected case
  is the one that matters — a client opening a link in a fresh tab.

## 2. Firestore rules — UNVERIFIED until the emulator runs

Written in `firestore.rules`, tested in `tests/rules/shares.rules.test.mjs`:

- **[ ] `list` is denied absolutely** on `shares`. This is the one that matters:
  a listable collection of live tokens makes the tokens meaningless. Note
  `allow read` would grant `get` **and** `list`, so this collection must always
  spell out `get` alone.
- **[ ] `get` requires `!revoked && request.time < expiresAt`** — enforced by
  the database, not merely by the viewer.
- **[ ] Client `create` and `delete` are refused**, including for the owner.
- **[ ] Owner `update` is limited to `revoked → true`**, expressed as
  `diff().affectedKeys().hasOnly(['revoked'])` so a field added later cannot
  become client-writable by omission.
- **[ ] Tamper attempts fail**: extending `expiresAt`, rewriting `payload`,
  reassigning `ownerUid`, renaming `label`, and each of those piggy-backed on a
  legitimate revoke.
- **[ ] Revoking cannot be undone** from a client.
- **[ ] No cross-path foothold**: an anonymous reader holding a token still
  cannot read `projects`, `users` or `catalogsGlobal`, and cannot read a
  subcollection under the share document.
- **[ ] The owner index** `users/{uid}/shares/{token}` is readable only by that
  user, is not admin-readable (the document ids are live tokens), and accepts
  the same `revoked`-only update.

## 3. The payload allowlist

`functions/src/share.ts` → `buildPayload`. Reviewed field by field against Q27
on 2026-08-25:

- **[✓] Built by copying named fields**, never by spreading a project and
  deleting. No `...project`, no `delete payload.x`.
- **[✓] Forbidden fields are absent by construction**: `owner` (an email),
  `ownerUid`, `ownerDisplayName`, `allowedUserIds`, `updatedByUid`,
  `localCatalog`, DEM references, per-source contributions.
- **[✓] `perSource` contributions never leave the client.** `ShareReceiverLevel`
  carries level, assessed level, limit and a boolean — nothing per-source.
- **[✓] Client-supplied states are re-shaped field by field**, arrays bounded
  (≤60 states, ≤8 MB), every number coerced, unknown periods refused. The
  states come from the client, so unlike the project half they cannot be
  trusted.
- **[✓] `ownerUid` is on the share document** (the rules need it) but is not in
  `payload` and is not rendered by the viewer.
- **[ ] Re-review this function line by line** whenever `Project` gains a field,
  and before first deploy.

- **[?] OPEN — source levels / spectra are not included.** Q27 permits them and
  the plan's allowlist names "per-band Lw of the modes used"; the current
  payload carries model and mode **names** only. Resolving spectra server-side
  means the function reading three catalog scopes — `catalogsGlobal`, the
  project's legacy `localCatalog`, and `users/{uid}/catalogs`, the last of
  which is another user's private data. That is a security-sensitive lookup
  that deserves its own review rather than being appended quietly.
  *Direction of the gap is safe:* a client sees less than Q27 allows, so the
  failure mode is "the client asks for the source data", not a disclosure.
  **Ryan's call:** add it before ship, or accept names-only for v1.

## 4. Viewer

- **[✓] Public route sits above the auth gate** — `/share/:token` renders
  without an account and without running the auth machinery.
- **[✓] Structurally cannot calculate.** No solver, catalog, spectra,
  curtailment, sweep, MapView or project import; no Firestore write of any
  kind. Enforced by a wiring test, verified red by adding a solver import.
- **[✓] Written from scratch rather than MapView in read-only mode**, so the
  guarantee does not rest on ~40 props being passed correctly forever.
- **[✓] Expiry and revocation are re-checked client-side** so the reader gets an
  explanation rather than a raw permission error.
- **[✓] Denial messages do not distinguish** "expired", "withdrawn" and "never
  existed" — spelling out which would confirm that a token exists.
- **[✓] Names are escaped** before reaching Leaflet tooltips.
- **[ ] Confirm no third-party request carries the URL.** Map tiles are fetched
  from OSM/Esri; `referrer: no-referrer` is set document-wide, **verify in
  DevTools** that no `Referer` header goes out on a live share.

## 5. Crawlers and caching

- **[✓] `noindex, nofollow`** meta on the document. **This is the effective
  control**, see below.
- **[✓] `robots.txt`** disallows `/share/` and `/` — but **it is inert on the
  current deployment**, and this was checked rather than assumed. CI builds with
  `BESSTY_BASE=/BESSTY/`, so the file is served at `/BESSTY/robots.txt`;
  crawlers only honour a **root-level** `/robots.txt`, which belongs to the
  `ryan-resonate.github.io` root and is not ours to write. The file is kept
  because it becomes effective the moment this is served from a domain root.
- **[✓] The token is not in the crawl request anyway.** Hash routing means a
  crawler fetching `…/BESSTY/#/share/TOKEN` sends only `/BESSTY/` to the
  server; the fragment never leaves the browser. A crawler that executes JS
  then meets the `noindex` tag.

## 6. Manual end-to-end, once deployed

- **[ ] Publish → open in a private window with no session** → renders.
- **[ ] Inspect the fetched document** in DevTools and confirm, by eye, that no
  email, UID or `perSource` array is present.
- **[ ] Switch period and wind speed** and confirm each shows its own embedded
  state and its own limit.
- **[ ] Withdraw → reload → denied.**
- **[ ] Set a 1-day expiry, move the clock forward, confirm denied.**
- **[ ] Try `list`** from a browser console against `shares` and confirm it is
  refused.
- **[ ] Try a token that differs by one character** and confirm nothing leaks.

## 7. App Check

- **[?] Not evaluated.** App Check would bind the callable function to genuine
  app instances, limiting automated publish attempts by a stolen session. It
  does not protect the share document itself (which is public by design). Worth
  considering with the Blaze upgrade; not a blocker for read-only shares.

## 8. Adversarial review

- **[ ] Fable review aimed at the rules, the function, and the viewer** — the
  standing practice after each batch, and the plan names it explicitly here.
  Should run **after** the emulator suite is green, so the reviewer is checking
  behaviour rather than intent.

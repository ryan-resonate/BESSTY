# Deploying BESSTY to GitHub Pages

This guide takes you from "code on your laptop" to "running at
`https://<your-account>.github.io/<repo-name>/`" in about 10 minutes.

The infrastructure is fully automated: every push to `main` rebuilds and
republishes the site. You don't need to run any deploy commands manually.

---

## Prerequisites

- The repository has been pushed to GitHub (private or public).
- You have **Owner** or **Maintain** access to the repository (you need
  it to enable Pages and inspect Action runs).

If the repo isn't on GitHub yet, do that first:

```bash
# From the repo root, after creating an empty repo on github.com
git remote add origin https://github.com/<your-account>/<repo-name>.git
git push -u origin main
```

---

## One-time setup

### 1. Merge the `gh-pages-setup` branch into `main`

This branch contains everything Pages needs:
- `.github/workflows/deploy-pages.yml` — the build + publish workflow.
- `web/vite.config.ts` — `base` set from the `BESSTY_BASE` env var.
- `web/src/main.tsx` — `HashRouter` (URLs like `/#/projects/foo`).
- `web/src/components/LoginScreen.tsx` + `web/src/lib/auth.ts` — Stage-1 auth.

Either open a PR and merge it, or fast-forward locally:

```bash
git checkout main
git merge gh-pages-setup --ff-only
git push origin main
```

### 2. Turn on GitHub Pages with the Actions source

1. Go to your repo on github.com → **Settings** → **Pages** (left sidebar).
2. Under **Build and deployment** → **Source**, choose **GitHub Actions**
   (NOT "Deploy from a branch").
3. That's it for the Pages settings page — the workflow handles the rest.

> The "GitHub Actions" source is the modern path. The older "Deploy from
> a branch / gh-pages branch" approach also works but requires an extra
> branch and gives you less control over the build environment. We use
> the Actions source.

### 3. Push or trigger the workflow

The workflow runs automatically on every push to `main`, so the merge
above already kicked off the first build. Confirm it ran:

1. Go to the **Actions** tab.
2. Click the most recent **"Deploy to GitHub Pages"** run.
3. Wait for both jobs (`build` and `deploy`) to finish — usually 2–3 min.

If the run is green, the deploy job's summary shows the live URL, e.g.
`https://innovation-resonate.github.io/bessty/`.

### 4. Sign in

The first thing you'll see is the Stage-1 login screen.

- **Username:** `Resonate`
- **Password:** `Resonate`

(Username is case-insensitive; password is case-sensitive.)

The login state persists in browser localStorage, so subsequent visits
skip the screen until you click the **⎋** sign-out button in the header.

---

## How the build works

```
push to main
   │
   ▼
.github/workflows/deploy-pages.yml
   │
   ├─ checkout
   ├─ npm ci             (web/)
   ├─ npm run lint       (tsc --noEmit)
   ├─ BESSTY_BASE=/<repo>/ npm run build   (vite → web/dist)
   ├─ upload-pages-artifact (web/dist)
   ▼
deploy-pages action  →  https://<account>.github.io/<repo>/
```

The `BESSTY_BASE` env var is read by `vite.config.ts` and becomes the
prefix on every asset URL. Without it, the bundled `index.html` would
point at `/assets/index-XXX.js` and 404 (because Pages serves us from
`/<repo-name>/`, not `/`).

---

## Switching to a custom domain

If you want to serve from a Resonate-owned domain (say
`bessty.resonate-consultants.com`):

1. Add a `CNAME` file to `web/public/` containing just the domain
   (one line, no protocol):
   ```
   bessty.resonate-consultants.com
   ```
2. In your DNS, add a `CNAME` record pointing your subdomain at
   `<your-account>.github.io`.
3. Edit `.github/workflows/deploy-pages.yml` and change
   `BESSTY_BASE: /${{ github.event.repository.name }}/` to
   `BESSTY_BASE: /` — assets now live at the domain root.
4. In **Settings → Pages**, set the **Custom domain** field to your
   subdomain and tick **Enforce HTTPS** once the cert provisions
   (a few minutes).

---

## Troubleshooting

**The site loads but every asset 404s.**
The `base` prefix doesn't match the URL the site is served from. Open
DevTools → Network and check what path the `.js` and `.css` files are
being requested from. They should start with `/<repo-name>/`. If they
start with `/`, the workflow built without the `BESSTY_BASE` env var —
re-run the workflow from the Actions tab.

**The page is blank with no console errors.**
You probably loaded a deep URL like `/projects/foo` instead of the root.
GitHub Pages doesn't fall back to `index.html` for unknown paths. Use
`#/` URLs (we ship HashRouter for exactly this reason): the URL
`https://.../<repo>/#/projects/foo` should work.

**Login screen appears every visit even after signing in.**
Browser blocks third-party storage on this domain (corporate / strict
privacy mode). The session marker lives in localStorage; if it can't
persist, the gate re-shows on every page load. Whitelist the site or
sign in fresh each time.

**Workflow fails at "Type-check" step.**
Run `cd web && npm run lint` locally to see the same errors. The
workflow uses Node 20 — if you're on a much older Node version
(< 18) the local results may differ.

**WASM file fails to load.**
GitHub Pages serves `.wasm` with `Content-Type: application/wasm` —
this is correct. If you see a CORS or MIME-type error, hard-refresh the
page (`Ctrl+Shift+R`) — Vite's WASM plugin needs the loader and binary
to come from the same origin, which they do.

---

## Updating the site

Just push to `main`:

```bash
git push origin main
```

The workflow runs, the new build replaces the old, and the URL stays the
same. Cached assets are content-hashed so users get the new version on
their next refresh without any cache-busting tricks.

---

## Replacing the placeholder auth

When you're ready for real auth, edit `web/src/lib/auth.ts`. The whole
module is ~30 lines — three exports (`isAuthenticated`, `tryLogin`,
`logout`) that the rest of the app consumes. Swap the implementation for
Firebase / Auth0 / Cloudflare Access without touching any other file.

For Firebase Auth specifically, the `web/src/lib/firebase.ts` stub is
already wired — drop the API keys into `.env.local`, replace the
contents of `auth.ts` with calls to `firebase/auth`, and you're done.

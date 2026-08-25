// Publishing a read-only share link.
//
// !! NOT DEPLOYED -- see docs/blaze-upgrade.md. Written, type-checked, and
// waiting on the Blaze upgrade like the rest of this codebase's functions.
//
// THIS FILE IS THE SECURITY BOUNDARY OF THE SHARE FEATURE. A share link is a
// public capability URL: anyone holding the token reads whatever is in the
// document, without signing in. What ends up in that document is decided here
// and nowhere else.
//
// The one rule that matters: the payload is built by COPYING AN ALLOWLIST out
// of the project, never by deleting fields from it. The difference is not
// stylistic. A `Project` today carries `owner` (an email address), `ownerUid`,
// `ownerDisplayName`, `allowedUserIds` and `updatedByUid` — all of which Q27
// forbids a client from seeing — and it will carry more fields next quarter.
// A strip-list has to be updated in step with every one of them, and the
// failure mode of forgetting is silent publication. An allowlist's failure
// mode is a field missing from the viewer, which someone notices and fixes.
//
// So: no spread of the project. No `delete payload.x`. Every field that
// reaches a share is named below, in `buildPayload`, one at a time.

import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import * as admin from 'firebase-admin';

const db = admin.firestore();

/// Mirrors `web/src/lib/share.ts`. Deliberately re-declared rather than
/// imported: `functions/` is a separate package, and a shared type would make
/// the client's shape authoritative over the server's. The server decides what
/// a share contains.
const MAX_EXPIRY_DAYS = 365;
const DEFAULT_EXPIRY_DAYS = 90;
const TOKEN_LENGTH = 32;
const PAYLOAD_INLINE_LIMIT = 800 * 1024;

/// Hard ceiling on what one share may carry, before we even look at where it
/// would live. Without this a client could hand us an arbitrarily large states
/// array and make the function allocate it — the request body cap is 10 MB and
/// there is no reason a legitimate share approaches it.
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

/// Cap on how many states a share may embed. 3 periods × 20 wind speeds is
/// already far past what anyone reads.
const MAX_STATES = 60;

interface ShareStateIn {
  period: string;
  windSpeed: number;
  receivers: unknown[];
  contours?: unknown[];
  grid?: { cols: number; rows: number; bounds: unknown; dbA: number[] };
}

const PERIODS = ['day', 'evening', 'night'];

/// Publish a share.
///
/// Takes a PROJECT ID, not a project. The caller cannot influence what is
/// copied out of the project — only which project, and only one they may
/// already read.
export const publishShare = onCall(
  { region: 'australia-southeast1', memory: '512MiB' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }
    const uid = request.auth.uid;

    const {
      projectId, label, expiryDays, draftOrFinal, states,
    } = (request.data ?? {}) as {
      projectId?: unknown; label?: unknown; expiryDays?: unknown;
      draftOrFinal?: unknown; states?: unknown;
    };

    if (typeof projectId !== 'string' || !projectId || projectId.includes('/')) {
      throw new HttpsError('invalid-argument', 'projectId is required.');
    }
    if (draftOrFinal !== 'draft' && draftOrFinal !== 'final') {
      throw new HttpsError('invalid-argument', 'draftOrFinal must be "draft" or "final".');
    }
    if (!Array.isArray(states) || states.length === 0) {
      throw new HttpsError('invalid-argument', 'A share needs at least one state.');
    }
    if (states.length > MAX_STATES) {
      throw new HttpsError('invalid-argument', `A share may hold at most ${MAX_STATES} states.`);
    }

    // The label is rendered in the viewer's watermark strip. Length-capped and
    // stripped of control characters; the viewer renders it as text (never as
    // markup), so this is depth rather than the only defence.
    const safeLabel = typeof label === 'string'
      ? label.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120).trim()
      : '';

    // Expiry is computed HERE from a day count. Taking an absolute timestamp
    // from the client would let a wrong clock — or a hostile caller — mint a
    // share that outlives what the user picked, and the rules trust this field.
    const days = Number.isFinite(expiryDays as number)
      ? Math.min(MAX_EXPIRY_DAYS, Math.max(1, Math.round(expiryDays as number)))
      : DEFAULT_EXPIRY_DAYS;

    // ---- Authorisation: may this caller share this project? ----
    //
    // Read with the admin SDK, then check access explicitly. Sharing is an
    // EDITOR-level act, not a reader-level one: a public project is readable by
    // every signed-in user, and any of them being able to publish it to the
    // open internet is not what "public" means inside the app.
    const projectSnap = await db.collection('projects').doc(projectId).get();
    if (!projectSnap.exists) {
      throw new HttpsError('not-found', 'No such project.');
    }
    const project = projectSnap.data() ?? {};
    const allowed = Array.isArray(project.allowedUserIds) ? project.allowedUserIds : [];
    const isEditor = project.ownerUid === uid || allowed.includes(uid);
    if (!isEditor && !(await isAdmin(uid))) {
      throw new HttpsError(
        'permission-denied',
        'Only the project owner or a collaborator can publish a share link.',
      );
    }

    const cleanStates = (states as ShareStateIn[]).map(cleanState);

    const payload = buildPayload(project, cleanStates, draftOrFinal);
    const bytes = Buffer.byteLength(JSON.stringify(payload), 'utf8');
    if (bytes > MAX_PAYLOAD_BYTES) {
      throw new HttpsError(
        'invalid-argument',
        `This share is ${(bytes / 1024 / 1024).toFixed(1)} MB, over the ${MAX_PAYLOAD_BYTES / 1024 / 1024} MB limit. `
        + 'Include fewer wind speeds or periods, or share contour lines without the filled grid.',
      );
    }
    if (bytes > PAYLOAD_INLINE_LIMIT) {
      // The Storage overflow path the plan describes. Firebase Storage is not
      // enabled on this project (Spark plan — see docs/blaze-upgrade.md), so
      // rather than write a share whose payload cannot be fetched, refuse and
      // say what to drop. Wiring the upload here is a small change once the
      // bucket exists; publishing a broken link is not recoverable.
      throw new HttpsError(
        'failed-precondition',
        `This share is ${Math.round(bytes / 1024)} kB, over the ${PAYLOAD_INLINE_LIMIT / 1024} kB `
        + 'that fits in a share document. Larger shares need Firebase Storage, which is not '
        + 'enabled yet. Include fewer states, or leave the filled grid out and share the '
        + 'contour lines alone.',
      );
    }

    const token = mintToken();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

    await db.collection('shares').doc(token).create({
      ownerUid: uid,
      createdAt: now.toISOString(),
      expiresAt: admin.firestore.Timestamp.fromDate(expiresAt),
      revoked: false,
      label: safeLabel,
      draftOrFinal,
      payload,
    });

    // The token is the credential. It is never logged — not here, not in an
    // error, not in analytics. A log line naming it would put a live capability
    // into Cloud Logging, readable by anyone with project viewer access, and
    // retained long after the share is revoked.
    logger.info('share published', {
      uid, projectId, states: cleanStates.length, bytes, days,
    });

    return { token, expiresAt: expiresAt.toISOString() };
  },
);

/// Revoke a share and remove any overflow payload.
///
/// The rules also let an owner flip `revoked` directly, which is what the
/// management UI uses. This exists for the Storage cleanup that a client
/// cannot do, and is the path to use once overflow payloads are real.
export const revokeShare = onCall(
  { region: 'australia-southeast1' },
  async (request) => {
    if (!request.auth) throw new HttpsError('unauthenticated', 'Sign in required.');
    const { token } = (request.data ?? {}) as { token?: unknown };
    if (typeof token !== 'string' || !/^[A-Za-z0-9]{32}$/.test(token)) {
      throw new HttpsError('invalid-argument', 'Bad token.');
    }
    const ref = db.collection('shares').doc(token);
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'No such share.');
    const data = snap.data() ?? {};
    if (data.ownerUid !== request.auth.uid && !(await isAdmin(request.auth.uid))) {
      throw new HttpsError('permission-denied', 'Only the share’s owner can revoke it.');
    }
    await ref.update({ revoked: true });
    if (typeof data.payloadPath === 'string' && data.payloadPath.startsWith(`shares/${token}/`)) {
      // Storage rules serve share payloads to anyone holding the path, so the
      // flag flip alone is not enough — the object has to go.
      try {
        await admin.storage().bucket().file(data.payloadPath).delete();
      } catch (e) {
        logger.warn('share payload delete failed', { token: '[redacted]', error: String(e) });
      }
    }
    logger.info('share revoked', { uid: request.auth.uid });
    return { ok: true };
  },
);

async function isAdmin(uid: string): Promise<boolean> {
  const snap = await db.collection('users').doc(uid).get();
  return snap.exists && snap.data()?.flags?.admin === true;
}

function mintToken(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const limit = 256 - (256 % alphabet.length);
  const { randomBytes } = require('crypto') as typeof import('crypto');
  let out = '';
  while (out.length < TOKEN_LENGTH) {
    for (const b of randomBytes(TOKEN_LENGTH * 2)) {
      if (b >= limit) continue;
      out += alphabet[b % alphabet.length];
      if (out.length === TOKEN_LENGTH) break;
    }
  }
  return out;
}

// ------------------------------------------------------- the allowlist

/// Build the share payload.
///
/// EVERY FIELD THAT REACHES A CLIENT IS NAMED HERE. Read this function as the
/// answer to "what can someone with the link see?" — if it is not written out
/// below, it is not in the share, by construction rather than by deletion.
///
/// Against Q27's list:
///   visible — contours, receivers with limits, source positions, noise walls,
///             model/mode names, source levels, annotations, project label
///   never   — emails, UIDs, per-source contributions, DEM, collaborator lists
function buildPayload(
  project: Record<string, unknown>,
  states: ShareStateIn[],
  draftOrFinal: 'draft' | 'final',
): Record<string, unknown> {
  const settings = asRecord(project.settings) ?? {};
  const display = asRecord(project.display);

  return {
    // --- identity: the LABEL only. Never `owner` (an email), `ownerUid`,
    // `ownerDisplayName`, `allowedUserIds` or `updatedByUid`.
    projectName: str(project.name) ?? 'Untitled project',
    publishedAt: new Date().toISOString(),
    draftOrFinal,
    weighting: str(asRecord(settings.weighting)?.mode) ?? 'A',
    standard: str(settings.standard) ?? '2024',

    receivers: arr(project.receivers).map((raw) => {
      const r = asRecord(raw) ?? {};
      const table = asRecord(r.limitTable);
      const limits = asRecord(table?.limits);
      return {
        id: str(r.id) ?? '',
        name: str(r.name) ?? '',
        latLng: latLng(r.latLng),
        heightAboveGroundM: num(r.heightAboveGroundM) ?? 1.5,
        limitDayDbA: num(r.limitDayDbA) ?? 0,
        limitEveningDbA: num(r.limitEveningDbA) ?? 0,
        limitNightDbA: num(r.limitNightDbA) ?? 0,
        // Limit tables are explicitly shareable (Q27: "receivers with limits").
        ...(table && limits ? {
          limitTable: {
            windSpeeds: nums(table.windSpeeds),
            limits: {
              day: nums(limits.day),
              evening: nums(limits.evening),
              night: nums(limits.night),
            },
          },
        } : {}),
      };
    }),

    // Positions, kinds and the NAMES of the model and mode. Not the catalog
    // entry, not the spectra keyed by every mode the model has — only what the
    // map needs to label a marker.
    sources: arr(project.sources).map((raw) => {
      const s = asRecord(raw) ?? {};
      return {
        id: str(s.id) ?? '',
        name: str(s.name) ?? '',
        kind: str(s.kind) ?? '',
        latLng: latLng(s.latLng),
        ...(str(s.modelId) ? { modelName: str(s.modelId) } : {}),
        ...(typeof s.modeOverride === 'string' ? { modeName: s.modeOverride } : {}),
        ...(num(s.hubHeight) != null ? { heightM: num(s.hubHeight) } : {}),
      };
    }),

    barriers: arr(project.barriers).map((raw) => {
      const b = asRecord(raw) ?? {};
      return {
        id: str(b.id) ?? '',
        name: str(b.name) ?? '',
        polylineLatLng: arr(b.polylineLatLng).map(latLng),
        topHeightsM: nums(b.topHeightsM),
        baseFromGroundM: num(b.baseFromGroundM) ?? 0,
        absorptionCoeff: num(b.absorptionCoeff) ?? 0,
      };
    }),

    customContours: arr(project.customContours).map((raw) => {
      const c = asRecord(raw) ?? {};
      return {
        id: str(c.id) ?? '',
        ...(str(c.label) ? { label: str(c.label) } : {}),
        levelDb: num(c.levelDb) ?? 0,
        ...(str(c.color) ? { color: str(c.color) } : {}),
        ...(num(c.widthPx) != null ? { widthPx: num(c.widthPx) } : {}),
        ...(c.dashed === true ? { dashed: true } : {}),
      };
    }),

    annotations: arr(project.annotations).map((raw) => {
      const a = asRecord(raw) ?? {};
      return {
        id: str(a.id) ?? '',
        kind: str(a.kind) ?? '',
        text: str(a.text) ?? '',
        latLng: latLng(a.latLng),
        ...(a.leaderLatLng ? { leaderLatLng: latLng(a.leaderLatLng) } : {}),
        ...(Array.isArray(a.pointsLatLng)
          ? { pointsLatLng: arr(a.pointsLatLng).map(latLng) } : {}),
      };
    }),

    // Presentation only — never the DEM, and never a basemap key or token.
    display: {
      palette: str(display?.palette) ?? 'viridis',
      contourMin: num(asRecord(display?.contourBounds)?.min) ?? 25,
      contourMax: num(asRecord(display?.contourBounds)?.max) ?? 60,
      contourStep: num(asRecord(display?.contourBounds)?.step) ?? 5,
      baseMap: str(display?.baseMap) ?? 'osm',
    },

    states,
  };
}

/// Re-shape one state, keeping only the fields the viewer draws.
///
/// The states come FROM the client, so unlike the project half they cannot be
/// read from a trusted source — which makes shaping them here the only thing
/// standing between a hostile caller and arbitrary content in a public
/// document. Numbers are coerced, arrays are bounded, everything else is
/// dropped.
function cleanState(raw: ShareStateIn): ShareStateIn {
  const s = asRecord(raw) ?? {};
  const period = str(s.period);
  if (!period || !PERIODS.includes(period)) {
    throw new HttpsError('invalid-argument', `Unknown period "${String(s.period)}".`);
  }
  const grid = asRecord(s.grid);
  return {
    period,
    windSpeed: num(s.windSpeed) ?? 0,
    receivers: arr(s.receivers).map((r) => {
      const x = asRecord(r) ?? {};
      return {
        id: str(x.id) ?? '',
        levelDb: num(x.levelDb),
        assessedDb: num(x.assessedDb),
        limitDb: num(x.limitDb) ?? 0,
        exceeds: x.exceeds === true,
      };
    }),
    ...(Array.isArray(s.contours) ? {
      contours: arr(s.contours).map((c) => {
        const x = asRecord(c) ?? {};
        return {
          threshold: num(x.threshold) ?? 0,
          ...(str(x.label) ? { label: str(x.label) } : {}),
          lines: arr(x.lines).map((line) => arr(line).map(latLng)),
        };
      }),
    } : {}),
    ...(grid ? {
      grid: {
        cols: num(grid.cols) ?? 0,
        rows: num(grid.rows) ?? 0,
        bounds: {
          sw: latLng(asRecord(grid.bounds)?.sw),
          ne: latLng(asRecord(grid.bounds)?.ne),
        },
        dbA: nums(grid.dbA),
      },
    } : {}),
  };
}

// ------------------------------------------------------------- coercion

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === 'object' && !Array.isArray(v)
    ? v as Record<string, unknown>
    : undefined;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}
function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function nums(v: unknown): number[] {
  return arr(v).map((x) => num(x) ?? 0);
}
function latLng(v: unknown): [number, number] {
  const a = arr(v);
  return [num(a[0]) ?? 0, num(a[1]) ?? 0];
}

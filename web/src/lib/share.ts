// Read-only share links: the client half.
//
// A share is a FROZEN SNAPSHOT published to a public capability URL. Anyone
// holding the link can read it; nobody can enumerate links, and nobody can
// edit anything through one. Republishing is how a share is updated.
//
// Two rules shape everything here, and both are security properties rather
// than preferences:
//
//   1. THE CLIENT NEVER BUILDS THE PROJECT PAYLOAD. A Cloud Function reads the
//      project with the admin SDK and copies an explicit ALLOWLIST of fields
//      into the share. This module sends a project id and the computed results;
//      it does not send the project. A `Project` carries `owner` (an email),
//      `ownerUid`, `ownerDisplayName`, `allowedUserIds` and `updatedByUid` —
//      and will carry more one day. Anything built by subtraction leaks the
//      next field someone adds, on the day they add it.
//   2. THE VIEWER DOES NOT CALCULATE. It has no solver, no catalog and no
//      project. Every level and every contour it can show has to be embedded at
//      publish time, which is why a share carries STATES: one per (period, wind
//      speed) the publisher chose to include. The viewer's dropdowns swap
//      between them and nothing else.
//
// Rule 2 is what makes size a design problem: a 10-speed × 3-period share with
// full rasters is megabytes, and a Firestore document stops at 1 MB. The
// publish dialog therefore prices every state before anything is sent.

import type { ContourLineSet } from './contourLines';
import type { GridResult } from './solver';
import type { Period } from './types';

/// Characters a token is drawn from. Base62: no separators, no case-folding
/// surprises, safe in a URL path without escaping, and double-clickable.
const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/// Token length. 62^32 ≈ 2^190.4, so a token carries just over 190 bits —
/// unguessable by any margin that matters, and short enough to paste into an
/// email without wrapping.
export const TOKEN_LENGTH = 32;

/// Mint a share token.
///
/// The token IS the capability: holding it grants read access, so it must come
/// from a CSPRNG. `Math.random` is seeded predictably in several engines and
/// has nothing like 190 bits of state — it would make links guessable from one
/// another, which is the whole threat model.
///
/// The modulo here is unbiased because 256 is not a multiple of 62: bytes
/// landing in the biased tail are rejected and redrawn rather than folded, so
/// every character is uniform.
export function mintShareToken(
  randomBytes: (n: number) => Uint8Array = cryptoBytes,
): string {
  const limit = 256 - (256 % TOKEN_ALPHABET.length);   // 248
  let out = '';
  while (out.length < TOKEN_LENGTH) {
    for (const b of randomBytes(TOKEN_LENGTH)) {
      if (b >= limit) continue;                        // biased tail — redraw
      out += TOKEN_ALPHABET[b % TOKEN_ALPHABET.length];
      if (out.length === TOKEN_LENGTH) break;
    }
  }
  return out;
}

function cryptoBytes(n: number): Uint8Array {
  const buf = new Uint8Array(n);
  crypto.getRandomValues(buf);
  return buf;
}

/// Is this string shaped like a token we minted?
///
/// Checked before a lookup so a malformed path is refused locally instead of
/// becoming a Firestore read — and so a token can never contain a character
/// that would change what document path it addresses.
export function isShareToken(v: unknown): v is string {
  return typeof v === 'string'
    && v.length === TOKEN_LENGTH
    && /^[A-Za-z0-9]+$/.test(v);
}

// ------------------------------------------------------------------ states

/// One receiver, as the viewer shows it. Levels only — no spectra, no
/// per-source contributions (Q27 forbids contributions outright).
export interface ShareReceiverLevel {
  id: string;
  /// The solved level in the project's assessment weighting, or null when the
  /// receiver did not solve. Null is NOT "compliant" — the viewer shows a dash.
  levelDb: number | null;
  /// The level the verdict was made on: `levelDb` plus any tonality penalty.
  assessedDb: number | null;
  /// The limit that applied in THIS state. With wind-speed limit tables in use
  /// this differs between states, so it travels with the state rather than
  /// with the receiver.
  limitDb: number;
  exceeds: boolean;
}

/// One (period, wind speed) the viewer can switch to.
///
/// `grid` and `contours` are both optional and both carried when available:
/// contours draw crisply at any zoom, the raster gives the filled view, and a
/// publisher who wants a small share can include the lines alone.
export interface ShareState {
  period: Period;
  windSpeed: number;
  receivers: ShareReceiverLevel[];
  contours?: ShareContourSet[];
  grid?: ShareGrid;
}

export interface ShareContourSet {
  threshold: number;
  label?: string;
  lines: Array<Array<[number, number]>>;
}

/// A raster, JSON-safe.
///
/// `dbA` is a plain number array rather than a Float32Array because the payload
/// crosses a callable-function boundary and lands in Firestore or as a JSON
/// object in Storage — a typed array would arrive as `{"0":30.1,...}` and be
/// silently wrong-shaped at the far end.
export interface ShareGrid {
  cols: number;
  rows: number;
  bounds: { sw: [number, number]; ne: [number, number] };
  dbA: number[];
}

/// Turn a solved grid into its shareable form, rounded.
///
/// One decimal is below anything the model can defend and cuts the JSON to
/// roughly half the size of full float text — on a 200×200 raster that is the
/// difference between ~500 kB and ~250 kB, which decides whether a share fits
/// in a Firestore document at all.
export function shareGridOf(grid: GridResult): ShareGrid {
  const dbA = new Array<number>(grid.dbA.length);
  for (let i = 0; i < grid.dbA.length; i++) {
    const v = grid.dbA[i];
    // A non-finite cell means "no result here"; JSON has no NaN, and `null`
    // would change the array's type. The viewer treats the sentinel as a hole.
    dbA[i] = Number.isFinite(v) ? Math.round(v * 10) / 10 : NO_RESULT;
  }
  return { cols: grid.cols, rows: grid.rows, bounds: grid.bounds, dbA };
}

/// Sentinel for a cell that did not solve. Far below any real sound level, and
/// finite so it survives JSON intact.
export const NO_RESULT = -9999;

export function shareContoursOf(sets: readonly ContourLineSet[]): ShareContourSet[] {
  return sets.map((s) => ({
    threshold: s.threshold,
    ...(s.label ? { label: s.label } : {}),
    // Coordinates rounded to ~1 cm. Contour vertices come out of a tracer at
    // full double precision, which is 17 characters per number for detail no
    // map can draw and no reader can use.
    lines: s.lines.map((line) => line.map(
      ([lat, lng]) => [round7(lat), round7(lng)] as [number, number],
    )),
  }));
}

function round7(v: number): number {
  return Math.round(v * 1e7) / 1e7;
}

// -------------------------------------------------------------------- size

/// Bytes a value occupies as UTF-8 JSON.
///
/// Measured rather than estimated: the publish dialog is promising the user
/// that a share will fit, and a wrong guess is discovered only at the far end
/// of a slow upload.
export function jsonBytes(v: unknown): number {
  return new TextEncoder().encode(JSON.stringify(v)).length;
}

/// Firestore's hard document limit.
export const FIRESTORE_DOC_LIMIT = 1024 * 1024;

/// What a payload may occupy before it has to overflow to Storage.
///
/// Deliberately well under the 1 MB ceiling. The document also carries the
/// share's own metadata, and Firestore counts field names, index entries and
/// its own encoding overhead toward the limit — not just the JSON we can see.
/// A share that publishes and then fails to save is the worst outcome here.
export const PAYLOAD_INLINE_LIMIT = 800 * 1024;

export interface StateSize {
  /// Bytes this state adds, as it would be sent.
  bytes: number;
  /// What it is made of, so the dialog can suggest dropping the expensive half.
  gridBytes: number;
  contourBytes: number;
}

export function sizeOfState(state: ShareState): StateSize {
  const gridBytes = state.grid ? jsonBytes(state.grid) : 0;
  const contourBytes = state.contours ? jsonBytes(state.contours) : 0;
  return { bytes: jsonBytes(state), gridBytes, contourBytes };
}

/// Human-readable size, for the publish dialog's per-state rows.
export function describeBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/// Where a payload of this size has to live.
///
/// `'storage'` is currently unreachable in production — the Firebase project
/// has no Storage bucket (see docs/blaze-upgrade.md) — so the publish path
/// refuses rather than pretending. Reported as a size verdict rather than
/// hidden inside the publish call so the dialog can say so BEFORE the user
/// waits on an upload.
export type PayloadHome = 'firestore' | 'storage';

export function payloadHome(bytes: number): PayloadHome {
  return bytes <= PAYLOAD_INLINE_LIMIT ? 'firestore' : 'storage';
}

// ------------------------------------------------------------- the request

/// What the client asks the Cloud Function to publish.
///
/// Note what is NOT here: any part of the project. The function reads that
/// itself, through the allowlist. This carries the id, the states the user
/// ticked, and the share's own settings.
export interface PublishShareRequest {
  projectId: string;
  label: string;
  /// Days from now. The function computes the absolute expiry so a client with
  /// a wrong clock — or a hostile one — cannot mint a share that outlives what
  /// the user chose.
  expiryDays: number;
  draftOrFinal: 'draft' | 'final';
  states: ShareState[];
}

/// Expiry choices offered in the dialog. 90 days is the locked default (Q29).
export const EXPIRY_CHOICES = [7, 30, 90, 180, 365] as const;
export const DEFAULT_EXPIRY_DAYS = 90;

/// The longest a share may live. A capability URL that never expires is a
/// credential nobody remembers issuing, so there is no "never" option.
export const MAX_EXPIRY_DAYS = 365;

export function clampExpiryDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_EXPIRY_DAYS;
  return Math.min(MAX_EXPIRY_DAYS, Math.max(1, Math.round(days)));
}

// ------------------------------------------------------------- the doc

/// The share document, as the viewer reads it.
///
/// `ownerUid` is present for the rules to check on revoke, and is NOT part of
/// the payload the viewer renders — the viewer never displays it, and Q27 keeps
/// UIDs out of what a client sees. It is here because the document must carry
/// it; the audit checklist covers making sure nothing renders it.
export interface ShareDoc {
  ownerUid: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  label: string;
  draftOrFinal: 'draft' | 'final';
  /// Inline payload, when it fitted. Absent when the payload overflowed, in
  /// which case `payloadPath` names the Storage object.
  payload?: SharePayload;
  payloadPath?: string;
}

/// Everything the viewer renders. Built by the Cloud Function from its
/// allowlist; nothing reaches this that the function did not name explicitly.
export interface SharePayload {
  projectName: string;
  publishedAt: string;
  draftOrFinal: 'draft' | 'final';
  weighting: string;
  standard: string;
  receivers: Array<{
    id: string;
    name: string;
    latLng: [number, number];
    heightAboveGroundM: number;
    limitDayDbA: number;
    limitEveningDbA: number;
    limitNightDbA: number;
    limitTable?: { windSpeeds: number[]; limits: Record<Period, number[]> };
  }>;
  sources: Array<{
    id: string;
    name: string;
    kind: string;
    latLng: [number, number];
    modelName?: string;
    modeName?: string;
    heightM?: number;
  }>;
  barriers: Array<{
    id: string;
    name: string;
    polylineLatLng: Array<[number, number]>;
    topHeightsM: number[];
    baseFromGroundM: number;
    absorptionCoeff: number;
  }>;
  customContours?: Array<{
    id: string;
    label?: string;
    levelDb: number;
    color?: string;
    widthPx?: number;
    dashed?: boolean;
  }>;
  annotations?: unknown[];
  display?: {
    palette?: string;
    contourMin?: number;
    contourMax?: number;
    contourStep?: number;
    baseMap?: string;
  };
  states: ShareState[];
}

/// Turn a Cloud-Functions failure into something a publisher can act on.
///
/// The one that matters is `internal` / `not-found` on a project where the
/// function has never been deployed: Firebase reports it the same way it
/// reports a genuine crash, and "internal error" sends someone hunting through
/// their own data for a problem that is a billing tier.
export function describePublishError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  const message = (e as { message?: string })?.message ?? String(e);
  if (code === 'functions/not-found' || code === 'functions/internal') {
    return 'The publish service is not available. Share links need Firebase Cloud '
      + 'Functions, which are not deployed on this project yet (see docs/blaze-upgrade.md).';
  }
  if (code === 'functions/unauthenticated') return 'Sign in again and retry.';
  if (code === 'functions/permission-denied') {
    return 'Only the project owner or a collaborator can publish a share link.';
  }
  return message;
}

/// Is this share readable right now?
///
/// The rules enforce this server-side — that is what actually protects the
/// data — but the viewer checks too, so an expired link renders an explanation
/// rather than a permission error the reader cannot interpret.
export function shareIsLive(doc: Pick<ShareDoc, 'revoked' | 'expiresAt'>, now = Date.now()): boolean {
  if (doc.revoked) return false;
  const t = Date.parse(doc.expiresAt);
  return Number.isFinite(t) && t > now;
}

/// The public URL for a token, from the app's own origin.
///
/// The `#` is not decoration. The app mounts a HashRouter (GitHub Pages serves
/// static files and would 404 a deep path on reload), so `/share/<token>`
/// without it lands on the login screen with the token ignored — every link
/// dead, in a way that looks like an auth problem rather than a URL one.
///
/// It also happens to be the better place for a credential: a fragment is
/// never transmitted to a server, so the token stays out of web-server access
/// logs and out of the Referer header even before the referrer policy applies.
export function shareUrl(token: string, origin = window.location.origin): string {
  // `import.meta.env.BASE_URL` carries the GitHub-Pages subpath in production
  // ("/BESSTY/") and "/" in dev, so the link works in both without a build-time
  // constant that can drift.
  const base = (import.meta.env?.BASE_URL ?? '/').replace(/\/$/, '');
  return `${origin}${base}/#/share/${token}`;
}

// BESSTY Cloud Functions (Node 20 / Gen 2).
//
// !! NOT DEPLOYED -- see docs/blaze-upgrade.md.
// This file is written + type-checks cleanly but the rc-beesty Firebase
// project is on the free Spark plan, which doesn't include the Cloud
// Build / Artifact Registry / Cloud Run infrastructure that Functions
// (Gen 1 or Gen 2) require. Upgrade to Blaze and run
// `firebase deploy --only functions` to activate. Workarounds while
// off-Blaze are documented in the upgrade doc.
//
// Two responsibilities:
//
//   1. `onAuthUserCreate` — runs immediately when a new Firebase Auth
//      user is created. Decides whether the email is allowed
//      (@resonate-consultants.com OR present in authAllowlist) and:
//        - Writes the canonical profile doc to users/{uid} (creating it
//          if the client hasn't yet, or updating `allowed` if it has).
//        - If NOT allowed, disables the Auth account so they can't
//          sign in even after verifying their email.
//      The client-side LoginScreen blocks non-Resonate emails at the form
//      level, but a determined user with the SDK could bypass it; this
//      function is the server-side gate.
//
//   2. `adminSetUserFlag` — callable function that lets an existing
//      admin promote / demote another user. Used by the in-app admin
//      UI (forthcoming) so admins don't have to flip flags in the
//      Console. Direct client writes to `users/{uid}.flags` are
//      blocked by Firestore rules; this is the only way through.
//
// The bootstrap admin still needs to be set manually once in the
// Firebase Console (the very first admin can't be promoted by any
// other admin because there isn't one yet).

// Mix-and-match v1 + v2 by design:
//   - The auth.user().onCreate trigger lives in the v1 namespace; v2's
//     equivalents are "blocking functions" which require enabling
//     Google Cloud Identity Platform (paid extra). Sticking with v1
//     keeps us on the Blaze free tier.
//   - The callable function uses v2 -- nicer typing, Gen 2 runtime,
//     region selection.
import * as functionsV1 from 'firebase-functions/v1';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { logger } from 'firebase-functions/v2';
import * as admin from 'firebase-admin';
import { createHash } from 'crypto';

admin.initializeApp();
const db = admin.firestore();
const auth = admin.auth();

const RESONATE_DOMAIN = '@resonate-consultants.com';

function hashEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}

function isResonateEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(RESONATE_DOMAIN);
}

async function isOnAllowlist(email: string): Promise<boolean> {
  const hash = hashEmail(email);
  const snap = await db.collection('authAllowlist').doc(hash).get();
  return snap.exists;
}

/// Auth trigger (Gen 1): enforce the access policy when a new user signs up.
export const onAuthUserCreate = functionsV1
  .auth.user()
  .onCreate(async (user) => {
    const email = user.email ?? '';
    const uid = user.uid;

    if (!email) {
      logger.warn(`User ${uid} created without an email -- disabling.`);
      await auth.updateUser(uid, { disabled: true });
      return;
    }

    const allowed = isResonateEmail(email) || await isOnAllowlist(email);

    logger.info(`User ${uid} (${email}) created -- allowed=${allowed}`);

    // Upsert the profile doc. Use merge so we don't clobber any client
    // write that beat us here (the client also creates the profile on
    // first verified sign-in, with its own best-guess `allowed`).
    await db.collection('users').doc(uid).set(
      {
        email: email.toLowerCase(),
        displayName: user.displayName ?? email.split('@')[0],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        allowed,
        flags: { admin: false },
      },
      { merge: true },
    );

    if (!allowed) {
      // Disable the account so they can't sign in even after verifying.
      // They get a "your account has been disabled" message in the
      // login screen; can request access via email.
      await auth.updateUser(uid, { disabled: true });
    }
  });

/// Callable: admin promotes / demotes another user's flag.
/// Usage from client:
///   const fn = httpsCallable(getFunctions(), 'adminSetUserFlag');
///   await fn({ uid: '...', flag: 'admin', value: true });
export const adminSetUserFlag = onCall(
  { region: 'australia-southeast1' },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError('unauthenticated', 'Sign in required.');
    }

    // Look up the CALLER's profile to verify they're an admin.
    const callerSnap = await db.collection('users').doc(request.auth.uid).get();
    if (!callerSnap.exists || callerSnap.data()?.flags?.admin !== true) {
      throw new HttpsError('permission-denied', 'Admin access required.');
    }

    const { uid, flag, value } = (request.data ?? {}) as {
      uid?: string; flag?: string; value?: unknown;
    };
    if (typeof uid !== 'string' || !uid) {
      throw new HttpsError('invalid-argument', 'uid is required.');
    }
    if (typeof flag !== 'string' || !flag) {
      throw new HttpsError('invalid-argument', 'flag is required.');
    }
    if (typeof value !== 'boolean') {
      throw new HttpsError('invalid-argument', 'value must be boolean.');
    }

    // Prevent an admin from accidentally locking themselves out by
    // demoting their own admin flag. (If they really want to, they can
    // ask another admin or edit Firestore directly.)
    if (flag === 'admin' && uid === request.auth.uid && value === false) {
      throw new HttpsError(
        'failed-precondition',
        'Refusing to demote yourself; ask another admin or use the Firebase Console.',
      );
    }

    await db.collection('users').doc(uid).set(
      { flags: { [flag]: value } },
      { merge: true },
    );

    logger.info(`Admin ${request.auth.uid} set users/${uid}.flags.${flag} = ${value}`);
    return { ok: true };
  },
);

// ===== Share links =====
// Publishing and revoking read-only public share links. Kept in its own module
// because it is the security boundary of that feature: `share.ts` decides,
// field by field, what a public capability URL can expose.
export { publishShare, revokeShare } from './share';

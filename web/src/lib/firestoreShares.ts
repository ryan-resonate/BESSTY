// Talking to the share backend: publish, list, revoke.
//
// Publishing goes through a CALLABLE FUNCTION rather than a Firestore write,
// and that is the whole security design rather than an implementation detail.
// The function holds the field allowlist; a client that could write
// `shares/{token}` directly could put anything in a public document, including
// fields copied straight off a project. The rules refuse a client create for
// exactly that reason, so there is no fallback path here to write one — if the
// function is unavailable, publishing fails and says so.

import {
  collection, doc, getDocs, orderBy, query, updateDoc,
} from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';

import { db, getApp } from './firebase';
import { getCurrentUid } from './auth';
import type { PublishShareRequest, ShareDoc } from './share';

/// Must match the region the functions are deployed to (see functions/src).
const REGION = 'australia-southeast1';

export interface PublishResult {
  token: string;
  expiresAt: string;
}

export async function publishShare(req: PublishShareRequest): Promise<PublishResult> {
  const fn = httpsCallable<PublishShareRequest, PublishResult>(
    getFunctions(getApp(), REGION), 'publishShare',
  );
  const res = await fn(req);
  return res.data;
}

/// A share as the management list shows it. `payload` is deliberately NOT
/// read: the list needs metadata, and pulling every payload would fetch
/// megabytes of raster to render a table of dates.
export interface ShareSummary {
  token: string;
  label: string;
  createdAt: string;
  expiresAt: string;
  revoked: boolean;
  draftOrFinal: 'draft' | 'final';
}

/// Every share this user owns, from their OWN index — not from `shares`.
///
/// `shares` denies `list` absolutely, and must keep doing so: a listable
/// collection of live capability tokens is the one failure that makes the
/// whole design pointless. That denial binds owners too, so "show me my links"
/// cannot be answered by querying it.
///
/// The function therefore writes a small pointer at `users/{uid}/shares/{token}`
/// alongside each share — metadata only, no payload — in a subcollection only
/// that user can read. Listing reads the index; the tokens in it are the
/// user's own, which they already hold.
export async function listMyShares(): Promise<ShareSummary[]> {
  const uid = getCurrentUid();
  if (!uid) return [];
  const q = query(
    collection(db(), 'users', uid, 'shares'),
    orderBy('createdAt', 'desc'),
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => {
    const data = d.data() as Partial<ShareDoc>;
    return {
      token: d.id,
      label: data.label ?? '',
      createdAt: String(data.createdAt ?? ''),
      expiresAt: toIso(data.expiresAt),
      revoked: data.revoked === true,
      draftOrFinal: data.draftOrFinal ?? 'draft',
    };
  });
}

function toIso(v: unknown): string {
  if (v && typeof v === 'object' && 'toDate' in v) {
    return (v as { toDate(): Date }).toDate().toISOString();
  }
  return String(v ?? '');
}

/// Withdraw a link.
///
/// Written straight to Firestore rather than through the function: the rules
/// allow an owner to flip `revoked` to true and nothing else, so this works
/// even with Functions unavailable — which matters, because being able to KILL
/// a link must never depend on more infrastructure than creating one did.
///
/// The function's `revokeShare` also removes an overflow payload from Storage;
/// that path is only reachable once Storage exists, and no share can currently
/// have one (publishing refuses at that size).
export async function revokeShare(token: string): Promise<void> {
  // The share doc first — that is the one that actually stops the link
  // resolving. If the index write below fails, the link is still dead and the
  // list is merely stale; the reverse order would show "revoked" over a link
  // that still worked.
  await updateDoc(doc(db(), 'shares', token), { revoked: true });
  const uid = getCurrentUid();
  if (uid) {
    await updateDoc(doc(db(), 'users', uid, 'shares', token), { revoked: true });
  }
}

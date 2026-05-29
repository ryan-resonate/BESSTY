// Firebase Storage helpers (currently only DEM upload/download).
//
// Storage bucket: `rc-beesty.firebasestorage.app` (default for the project).
// Layout: `projects/{projectId}/dem/{timestamp}-{filename}`.
//
// Why per-project paths: matches the security-rules model and makes the
// orphan-cleanup story straightforward when we eventually wire a
// projects.onDelete Cloud Function (Blaze).
//
// Size cap: 200 MB enforced client-side (storage.rules enforces it again
// server-side -- belt and braces). DEMs larger than that almost
// certainly come from picking the wrong resolution; suggest re-export.

import {
  deleteObject,
  getBlob,
  ref,
  uploadBytesResumable,
  type UploadTaskSnapshot,
} from 'firebase/storage';
import { storage } from './firebase';

/// Hard cap on a single DEM upload. Mirrors storage.rules and protects
/// the 5 GB Firebase Storage free tier from a single runaway upload.
export const DEM_MAX_BYTES = 200 * 1024 * 1024;

export interface DemUploadResult {
  storagePath: string;
  filename: string;
  sizeBytes: number;
}

/// Upload a DEM file for a project. Returns the storage path + metadata
/// the caller should write to the project doc's `dem` field. Throws if
/// the file exceeds DEM_MAX_BYTES.
///
/// `onProgress(0..1)` fires periodically for UI feedback.
export async function uploadProjectDem(
  projectId: string,
  file: File,
  opts: { onProgress?: (frac: number) => void } = {},
): Promise<DemUploadResult> {
  if (file.size > DEM_MAX_BYTES) {
    throw new Error(
      `DEM file is ${(file.size / 1024 / 1024).toFixed(1)} MB; max is ` +
      `${(DEM_MAX_BYTES / 1024 / 1024).toFixed(0)} MB. ` +
      `Re-export at a coarser resolution or smaller area.`,
    );
  }

  // Timestamp prefix keeps the filename stable across re-uploads while
  // avoiding cache collisions when a user replaces a DEM with a same-
  // named file.
  const safe = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `projects/${projectId}/dem/${Date.now()}-${safe}`;
  const objectRef = ref(storage(), storagePath);

  const task = uploadBytesResumable(objectRef, file, {
    contentType: 'image/tiff',
  });

  await new Promise<void>((resolve, reject) => {
    task.on(
      'state_changed',
      (snap: UploadTaskSnapshot) => {
        if (opts.onProgress && snap.totalBytes > 0) {
          opts.onProgress(snap.bytesTransferred / snap.totalBytes);
        }
      },
      reject,
      () => resolve(),
    );
  });

  return {
    storagePath,
    filename: file.name,
    sizeBytes: file.size,
  };
}

/// Download a DEM back into a File suitable for the existing
/// parseDemGeoTiff path. Streams as a Blob then wraps; the GeoTIFF
/// library reads from `arrayBuffer()` anyway.
export async function downloadProjectDem(
  storagePath: string,
  filename: string,
): Promise<File> {
  const blob = await getBlob(ref(storage(), storagePath));
  // Re-attach the original filename so the UI shows e.g. "site-DEM.tif"
  // and not the timestamp-prefixed storage path.
  return new File([blob], filename, { type: blob.type || 'image/tiff' });
}

/// Delete a project's saved DEM. Called when the user uploads a
/// replacement, or when the project itself is deleted (best-effort
/// client-side cleanup -- a Blaze Cloud Function would handle this
/// robustly once we have one).
export async function deleteProjectDem(storagePath: string): Promise<void> {
  try {
    await deleteObject(ref(storage(), storagePath));
  } catch (err) {
    // Tolerate "object-not-found" so re-runs / partial state don't blow
    // up. Other errors are surfaced for the caller to log.
    const code = (err as { code?: string })?.code;
    if (code !== 'storage/object-not-found') throw err;
  }
}

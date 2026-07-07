// Google Drive packaging for TikTok (§4.6, §1). Writes a package to the Drive
// queue folder `TikTok Queue/{YYYY-MM-DD}_{slug}/` containing video.mp4 +
// caption.txt. A human posts it manually and flips status to 'posted' (§9: no
// TikTok API on purpose).
//
// Drive *write* scope has been flaky in this org. We verify write scope on boot
// (DRIVE_WRITE_ENABLED=auto) and fall back to a Supabase Storage bucket
// `tiktok-queue/` + signed URL if write is unavailable.

import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { getSecretJson } from '../lib/vault.js';
import { supabase, uploadToBucket, signedUrl } from '../lib/supabase.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

let driveWriteState = null; // null=unknown, true/false once probed

async function driveClient() {
  // Vault 'google_drive_sa' = service-account JSON with drive scope.
  const sa = await getSecretJson('google_drive_sa');
  const auth = new google.auth.GoogleAuth({
    credentials: sa,
    scopes: ['https://www.googleapis.com/auth/drive'],
  });
  return google.drive({ version: 'v3', auth });
}

// Boot-time write-scope check (§8 step 2). Attempts a real, reversible write:
// create a probe folder, then delete it. Any failure => fall back to Storage.
// The probe runs inside the shared queue folder when DRIVE_QUEUE_FOLDER_ID is
// set: service accounts have no storage quota of their own, so a root-level
// probe can succeed (folders are quota-free) while real uploads would fail.
export async function verifyDriveWriteScope() {
  if (config.drive.writeEnabled === 'false') {
    driveWriteState = false;
    logger.info('drive write disabled by config; using Storage fallback');
    return false;
  }
  if (!config.drive.queueFolderId) {
    driveWriteState = false;
    logger.warn('DRIVE_QUEUE_FOLDER_ID not set; using Storage fallback');
    return false;
  }
  try {
    const drive = await driveClient();
    const probe = await drive.files.create({
      requestBody: {
        name: `hs-write-probe-${Date.now()}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [config.drive.queueFolderId],
      },
      fields: 'id',
      supportsAllDrives: true,
    });
    await drive.files.delete({ fileId: probe.data.id, supportsAllDrives: true });
    driveWriteState = true;
    logger.info('drive write scope verified');
    return true;
  } catch (err) {
    driveWriteState = false;
    logger.warn('drive write scope unavailable; falling back to Supabase Storage', {
      error: String(err && err.message ? err.message : err),
    });
    return false;
  }
}

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

async function findOrCreateFolder(drive, name, parentId) {
  const q = [
    `name='${name.replace(/'/g, "\\'")}'`,
    "mimeType='application/vnd.google-apps.folder'",
    'trashed=false',
    `'${parentId}' in parents`,
  ].join(' and ');
  const found = await drive.files.list({
    q,
    fields: 'files(id)',
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (found.data.files && found.data.files.length) return found.data.files[0].id;
  const created = await drive.files.create({
    requestBody: {
      name,
      mimeType: 'application/vnd.google-apps.folder',
      parents: [parentId],
    },
    fields: 'id',
    supportsAllDrives: true,
  });
  return created.data.id;
}

async function downloadStorage(storagePath) {
  const [bucket, ...rest] = storagePath.split('/');
  const key = rest.join('/');
  const { data, error } = await supabase().storage.from(bucket).download(key);
  if (error) throw new Error(`download ${storagePath} failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

// Writes the TikTok package. Returns { drivePath }.
export async function packageTikTok({ slug, variantPath, caption }) {
  if (driveWriteState === null) await verifyDriveWriteScope();
  const folderName = `${isoDate()}_${slug}`;
  const video = await downloadStorage(variantPath);

  if (driveWriteState) {
    const drive = await driveClient();
    // The shared folder IS the queue; per-episode folders are created inside it.
    const epId = await findOrCreateFolder(drive, folderName, config.drive.queueFolderId);
    await drive.files.create({
      requestBody: { name: 'video.mp4', parents: [epId] },
      media: { mimeType: 'video/mp4', body: Readable.from(video) },
      fields: 'id',
      supportsAllDrives: true,
    });
    await drive.files.create({
      requestBody: { name: 'caption.txt', parents: [epId] },
      media: { mimeType: 'text/plain', body: Readable.from(Buffer.from(caption, 'utf8')) },
      fields: 'id',
      supportsAllDrives: true,
    });
    const drivePath = `${config.drive.queueFolderName}/${folderName}/`;
    logger.info('tiktok package written to Drive', { drivePath });
    return { drivePath };
  }

  // Fallback: Supabase Storage bucket + signed URL recorded in drive_path.
  const base = `${folderName}`;
  await uploadToBucket('tiktok-queue', `${base}/video.mp4`, video, 'video/mp4');
  await uploadToBucket('tiktok-queue', `${base}/caption.txt`, Buffer.from(caption, 'utf8'), 'text/plain');
  const url = await signedUrl(`tiktok-queue/${base}/video.mp4`);
  logger.info('tiktok package written to Storage fallback', { base });
  return { drivePath: url };
}

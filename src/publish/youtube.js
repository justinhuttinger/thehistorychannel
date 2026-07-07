// YouTube Shorts upload via YouTube Data API v3 (§4.6). OAuth refresh-token
// pattern (same as GHL): the client id/secret + refresh token live in Vault.
//
// GUARDRAIL (§0): uploads as `private` + scheduled publish, never immediately
// public, until the operator flips YT_AUTO_PUBLIC to true. Videos under 60s are
// auto-classified as Shorts by YouTube.

import { google } from 'googleapis';
import { Readable } from 'node:stream';
import { getSecretJson } from '../lib/vault.js';
import { supabase } from '../lib/supabase.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

async function youtubeClient() {
  // Vault secret 'youtube_oauth' = { client_id, client_secret, refresh_token }.
  const creds = await getSecretJson('youtube_oauth');
  const oauth2 = new google.auth.OAuth2(creds.client_id, creds.client_secret);
  oauth2.setCredentials({ refresh_token: creds.refresh_token });
  return google.youtube({ version: 'v3', auth: oauth2 });
}

async function downloadStorage(storagePath) {
  const [bucket, ...rest] = storagePath.split('/');
  const key = rest.join('/');
  const { data, error } = await supabase().storage.from(bucket).download(key);
  if (error) throw new Error(`download ${storagePath} failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

// Publish time: ~24h out by default when scheduling private+scheduled.
function defaultPublishAt() {
  return new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
}

// Uploads the Shorts variant. `title`/`description` come from the YouTube
// caption. Returns { externalId }.
export async function uploadShort({ variantPath, title, description, publishAt }) {
  const yt = await youtubeClient();
  const body = await downloadStorage(variantPath);

  // Privacy is the human safety net for hallucinated facts.
  const privacyStatus = config.ytAutoPublic ? 'public' : 'private';
  const status = { privacyStatus, selfDeclaredMadeForKids: false };
  if (!config.ytAutoPublic) {
    // Scheduled publish requires privacyStatus 'private' + publishAt.
    status.publishAt = publishAt || defaultPublishAt();
  }

  const res = await yt.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title: title.slice(0, 100),
        description,
        categoryId: '27', // Education
      },
      status,
    },
    media: { body: Readable.from(body) },
  });

  const externalId = res.data.id;
  logger.info('youtube upload complete', { externalId, privacyStatus, scheduled: !config.ytAutoPublic });
  return { externalId };
}

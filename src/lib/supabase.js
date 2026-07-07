// Supabase client (source of truth + storage). Uses the service-role key; this
// runs server-side only (Render service / cron), never in client code.

import { createClient } from '@supabase/supabase-js';
import { config } from '../config.js';

let client = null;

export function supabase() {
  if (client) return client;
  if (!config.supabase.url || !config.supabase.serviceRoleKey) {
    throw new Error(
      'Supabase not configured: set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY',
    );
  }
  client = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return client;
}

// Upload a local buffer to a bucket and return the storage path. Idempotent by
// key (upsert) so re-running a render step does not error.
export async function uploadToBucket(bucket, key, body, contentType) {
  const { error } = await supabase()
    .storage.from(bucket)
    .upload(key, body, { contentType, upsert: true });
  if (error) throw new Error(`storage upload ${bucket}/${key} failed: ${error.message}`);
  return `${bucket}/${key}`;
}

// Signed URL for a bucket path stored as "bucket/key".
export async function signedUrl(storagePath, expiresInSeconds = 60 * 60 * 24 * 7) {
  const [bucket, ...rest] = storagePath.split('/');
  const key = rest.join('/');
  const { data, error } = await supabase()
    .storage.from(bucket)
    .createSignedUrl(key, expiresInSeconds);
  if (error) throw new Error(`signed url ${storagePath} failed: ${error.message}`);
  return data.signedUrl;
}

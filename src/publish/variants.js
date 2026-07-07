// Per-platform variant builder (§4.5). One master render feeds two cuts:
//   - youtube_shorts: master cut (light branding is allowed).
//   - tiktok:         CLEAN cut, no watermark/logo/promo text (TikTok ToS, §0).
//
// In the growth phase we add no baked-in branding at all, so both cuts derive
// from the same master. The branding overlay for the Shorts cut is a stub hook
// (applyBranding) kept off by default so the TikTok guardrail can never be
// violated by accident.

import { supabase, uploadToBucket } from '../lib/supabase.js';
import { logger } from '../lib/logger.js';

async function downloadStorage(storagePath) {
  const [bucket, ...rest] = storagePath.split('/');
  const key = rest.join('/');
  const { data, error } = await supabase().storage.from(bucket).download(key);
  if (error) throw new Error(`download ${storagePath} failed: ${error.message}`);
  return Buffer.from(await data.arrayBuffer());
}

// Stub for optional light Shorts branding. Returns the buffer unchanged until a
// real overlay is wired. It is NEVER called for the TikTok cut.
async function applyBranding(masterBuffer) {
  // TODO: FFmpeg overlay of a small channel bug if YT branding is desired.
  return masterBuffer;
}

// Builds the two variant files and returns their storage paths.
export async function buildVariants({ episode, finalVideoUrl, brandShorts = false }) {
  const master = await downloadStorage(finalVideoUrl);

  // TikTok: strictly the clean master. No branding function is applied here.
  const tiktokKey = `${episode.id}/tiktok-clean.mp4`;
  const tiktokPath = await uploadToBucket('hs-variants', tiktokKey, master, 'video/mp4');

  // YouTube Shorts: master, optionally with light branding.
  const shortsBuffer = brandShorts ? await applyBranding(master) : master;
  const shortsKey = `${episode.id}/youtube-shorts.mp4`;
  const shortsPath = await uploadToBucket('hs-variants', shortsKey, shortsBuffer, 'video/mp4');

  logger.info('variants built', { episodeId: episode.id, tiktokPath, shortsPath });
  return { tiktokPath, shortsPath };
}

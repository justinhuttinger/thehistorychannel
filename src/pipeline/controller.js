// Pipeline controller (§4, §5). One run per active series. Drives the stages:
//   1. topic gen (dedup)   2. script gen   3. fact-check (gate)
//   4. render (GPU)        5. per-platform variants
//   6. publish fan-out     7. notify
//
// State is written to Supabase at every step so a mid-run crash is resumable.
// Fact-check gating (§0): flagged episodes stop at `review` and never auto-publish.

import {
  getSeriesBySlug,
  listUsedTopics,
  topicExists,
  insertEpisode,
  updateEpisode,
  upsertDestination,
  updateDestination,
} from '../db/repositories.js';
import { generateTopic } from '../claude/topic.js';
import { generateScript } from '../claude/script.js';
import { factCheck } from '../claude/factcheck.js';
import { generateYouTubeCaption, generateTikTokCaption } from '../claude/captions.js';
import { renderEpisode } from '../render/controller.js';
import { buildVariants } from '../publish/variants.js';
import { uploadShort } from '../publish/youtube.js';
import { packageTikTok } from '../publish/drive.js';
import { notifySummary } from '../jobs/notify.js';
import { config } from '../config.js';
import { slugify } from '../lib/text.js';
import { logger } from '../lib/logger.js';

// Run the full pipeline for one series slug. Returns a summary object.
export async function runSeries(slug, { dryRunPublish = false } = {}) {
  const summary = { seriesSlug: slug, published: [], review: [], failed: [], skipped: [] };
  const series = await getSeriesBySlug(slug);
  if (!series) {
    logger.warn('runSeries: series not found', { slug });
    summary.skipped.push(`series "${slug}" not found`);
    return summary;
  }

  let episode;
  try {
    // -- Stage 1: topic gen + dedup --
    const usedTopics = await listUsedTopics(series.id);
    const { topic, hook } = await generateTopic({ series, usedTopics });
    if (await topicExists(series.id, topic)) {
      summary.skipped.push(`duplicate topic: ${topic}`);
      logger.info('skipping duplicate topic', { slug, topic });
      return summary;
    }
    episode = await insertEpisode({
      series_id: series.id,
      topic,
      hook,
      target_length_profile: config.defaultLengthProfile,
      state: 'draft',
    });

    // -- Stage 2: script gen --
    const scriptJson = await generateScript({
      series,
      topic,
      hook,
      targetLengthProfile: episode.target_length_profile,
    });
    await updateEpisode(episode.id, { script_json: scriptJson, state: 'scripted' });
    episode.script_json = scriptJson;

    // -- Stage 3: fact-check (mandatory gate, §0) --
    const fc = await factCheck({ topic, scriptJson });
    await updateEpisode(episode.id, {
      factcheck_status: fc.status,
      factcheck_notes: fc.notes,
    });
    if (fc.status !== 'clean') {
      await updateEpisode(episode.id, { state: 'review' });
      summary.review.push(`${topic} (${fc.notes.slice(0, 120)})`);
      logger.warn('episode flagged, landing in review', { episodeId: episode.id });
      await notifySummary(summary);
      return summary;
    }

    // -- Stage 4: render (GPU, guaranteed teardown) --
    const { finalVideoUrl } = await renderEpisode(episode, series);

    // -- Stage 5: per-platform variants --
    const { tiktokPath, shortsPath } = await buildVariants({
      episode,
      finalVideoUrl,
      brandShorts: false, // growth phase: no baked-in branding on either cut
    });

    // Per-platform captions, generated separately (§0 variation).
    const yt = await generateYouTubeCaption({ topic, hook });
    const tt = await generateTikTokCaption({ topic, hook });

    // Create the two destination rows up front (idempotent upsert).
    await upsertDestination({
      episode_id: episode.id,
      platform: 'youtube_shorts',
      variant_video_url: shortsPath,
      caption: yt.caption,
      status: 'pending',
    });
    await upsertDestination({
      episode_id: episode.id,
      platform: 'tiktok',
      variant_video_url: tiktokPath,
      caption: tt.caption,
      status: 'queued',
    });

    if (dryRunPublish) {
      summary.skipped.push(`${topic} (dry-run: publish skipped)`);
      logger.info('dry-run: skipping publish fan-out', { episodeId: episode.id });
      await updateEpisode(episode.id, { state: 'rendered' });
      await notifySummary(summary);
      return summary;
    }

    // -- Stage 6: publish fan-out --
    const ytDest = await publishYouTube(episode, shortsPath, yt);
    const ttDest = await publishTikTok(episode, tiktokPath, tt);

    await updateEpisode(episode.id, { state: 'published' });
    summary.published.push(
      `${topic} [yt:${ytDest.status} tiktok:${ttDest.status}]`,
    );
  } catch (err) {
    logger.error('runSeries failed', { slug, episodeId: episode?.id, error: String(err) });
    if (episode) await updateEpisode(episode.id, { state: 'failed' }).catch(() => {});
    summary.failed.push(`${episode?.topic || slug}: ${String(err && err.message ? err.message : err)}`);
  }

  // -- Stage 7: notify --
  await notifySummary(summary);
  return summary;
}

async function publishYouTube(episode, variantPath, yt) {
  const dest = await upsertDestination({
    episode_id: episode.id,
    platform: 'youtube_shorts',
    variant_video_url: variantPath,
    caption: yt.caption,
    status: 'pending',
  });
  // Idempotency: if already uploaded, do not re-upload.
  if (dest.status === 'uploaded' && dest.external_id) return dest;
  try {
    const { externalId } = await uploadShort({
      variantPath,
      title: yt.title,
      description: yt.description,
    });
    return updateDestination(dest.id, { status: 'uploaded', external_id: externalId });
  } catch (err) {
    logger.error('youtube publish failed', { episodeId: episode.id, error: String(err) });
    return updateDestination(dest.id, { status: 'failed' });
  }
}

async function publishTikTok(episode, variantPath, tt) {
  const dest = await upsertDestination({
    episode_id: episode.id,
    platform: 'tiktok',
    variant_video_url: variantPath,
    caption: tt.caption,
    status: 'queued',
  });
  // Idempotency: if already queued with a path, do not re-package.
  if (dest.status === 'queued' && dest.drive_path) return dest;
  const { drivePath } = await packageTikTok({
    slug: slugify(episode.topic),
    variantPath,
    caption: tt.caption,
  });
  return updateDestination(dest.id, { status: 'queued', drive_path: drivePath });
}

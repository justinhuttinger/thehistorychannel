// Render controller (§4.4, §5). On-demand: creates an hs_render_jobs row, spins
// up the GPU, and runs TTS -> visuals -> compose inside a try/finally. The
// `finally` GUARANTEES GPU teardown using gpu_instance_id, so a hung job never
// leaves a billing instance running. State is written at every step so a
// mid-run crash (or spot reclaim) is resumable.

import { gpuProvider } from './gpu.js';
import { ttsProvider } from './tts.js';
import { generateVisual } from './visuals.js';
import { compose } from './compose.js';
import { uploadToBucket } from '../lib/supabase.js';
import { insertRenderJob, updateRenderJob, updateEpisode } from '../db/repositories.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { slugify } from '../lib/text.js';

// Renders one episode to a master 9:16 MP4. Returns { finalVideoUrl }.
export async function renderEpisode(episode, series) {
  const beats = episode.script_json;
  if (!Array.isArray(beats) || beats.length === 0) {
    throw new Error(`renderEpisode: episode ${episode.id} has no script_json`);
  }

  const job = await insertRenderJob(episode.id);
  await updateEpisode(episode.id, { state: 'rendering' });

  const gpu = gpuProvider();
  const tts = ttsProvider();
  let instance = null;
  const deadline = Date.now() + config.gpu.maxRuntimeMin * 60 * 1000;
  const checkDeadline = () => {
    if (Date.now() > deadline) {
      throw new Error(`render exceeded GPU_MAX_RUNTIME_MIN (${config.gpu.maxRuntimeMin}m)`);
    }
  };

  try {
    instance = await gpu.spinUp();
    await updateRenderJob(job.id, { gpu_instance_id: instance.instanceId });

    // ---- TTS ----
    await updateRenderJob(job.id, { step: 'tts' });
    const audio = [];
    for (const beat of beats) {
      checkDeadline();
      const out = await tts.synthesize({
        text: beat.narration,
        voiceId: series.voice_id,
        endpoint: instance.endpoint,
      });
      audio.push(out);
    }

    // ---- Visuals ----
    await updateRenderJob(job.id, { step: 'visuals' });
    const visuals = [];
    for (const beat of beats) {
      checkDeadline();
      const out = await generateVisual({
        visualPrompt: beat.visual_prompt,
        styleSuffix: series.style_suffix,
        endpoint: instance.endpoint,
      });
      visuals.push(out);
    }

    // ---- Compose ----
    await updateRenderJob(job.id, { step: 'compose' });
    const composed = beats.map((beat, i) => ({
      narrationText: beat.narration,
      audio: audio[i].audio,
      ext: audio[i].ext,
      durationSeconds: audio[i].durationSeconds,
      image: visuals[i].image,
      imageExt: visuals[i].ext,
    }));
    const master = await compose({ beats: composed, burnCaptions: true });

    const key = `${episode.id}/${slugify(episode.topic)}-master.mp4`;
    const finalVideoUrl = await uploadToBucket('hs-masters', key, master.video, 'video/mp4');

    await updateRenderJob(job.id, {
      step: 'done',
      final_video_url: finalVideoUrl,
      finished_at: new Date().toISOString(),
    });
    await updateEpisode(episode.id, { state: 'rendered' });
    logger.info('render complete', { episodeId: episode.id, finalVideoUrl });
    return { finalVideoUrl };
  } catch (err) {
    // Mark the job step 'error' so the next run can retry (§5). A spot reclaim
    // that kills the process is handled by the reaper + this same path on rerun.
    await updateRenderJob(job.id, {
      step: 'error',
      error: String(err && err.message ? err.message : err),
      finished_at: new Date().toISOString(),
    }).catch(() => {});
    await updateEpisode(episode.id, { state: 'failed' }).catch(() => {});
    throw err;
  } finally {
    // GUARANTEED teardown. Always spin the GPU down, even on a hung/failed job.
    if (instance && instance.instanceId) {
      try {
        await gpu.tearDown(instance.instanceId);
      } catch (teardownErr) {
        // Do not mask the original error; the reaper is the backstop.
        logger.error('gpu teardown failed in finally; reaper will catch orphan', {
          instanceId: instance.instanceId,
          error: String(teardownErr),
        });
      }
    }
  }
}

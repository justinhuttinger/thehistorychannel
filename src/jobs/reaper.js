// GPU reaper (§5). Belt-and-suspenders on the `finally` teardown: scans provider
// instances and kills orphans that have no active hs_render_jobs row, plus any
// instance whose job has exceeded GPU_MAX_RUNTIME_MIN. A hung job must never
// leave a billing instance running.

import { gpuProvider } from '../render/gpu.js';
import { activeGpuJobs, updateRenderJob } from '../db/repositories.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export async function runReaper() {
  const gpu = gpuProvider();
  const jobs = await activeGpuJobs();
  const activeById = new Map(jobs.map((j) => [j.gpu_instance_id, j]));

  let instances = [];
  try {
    instances = await gpu.list();
  } catch (err) {
    logger.error('reaper: provider list failed', { error: String(err) });
    return { checked: 0, killed: 0 };
  }

  const maxMs = config.gpu.maxRuntimeMin * 60 * 1000;
  let killed = 0;

  for (const inst of instances) {
    const job = activeById.get(inst.instanceId);
    const ageMs = inst.createdAt ? Date.now() - new Date(inst.createdAt).getTime() : 0;
    const orphan = !job;
    const overrun = ageMs > maxMs;

    if (orphan || overrun) {
      try {
        await gpu.tearDown(inst.instanceId);
        killed++;
        logger.warn('reaper killed instance', {
          instanceId: inst.instanceId,
          reason: orphan ? 'orphan' : 'overrun',
          ageMs,
        });
        if (job) {
          await updateRenderJob(job.id, {
            step: 'error',
            error: orphan ? 'reaper: orphan instance' : 'reaper: exceeded max runtime',
            finished_at: new Date().toISOString(),
          }).catch(() => {});
        }
      } catch (err) {
        logger.error('reaper: teardown failed', { instanceId: inst.instanceId, error: String(err) });
      }
    }
  }
  return { checked: instances.length, killed };
}

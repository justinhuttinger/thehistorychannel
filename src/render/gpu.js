// GPU provider interface (§1, §5). The controller must be able to spin an
// instance up, get a handle for teardown, and tear it down in a `finally` block.
// Providers are swappable behind this interface; 'mock' lets the whole pipeline
// run with no real GPU for dry runs and CI.

import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { getSecretJson } from '../lib/vault.js';

// ---- mock provider: no real instance, deterministic handle ----
const mockProvider = {
  async spinUp() {
    const id = `mock-gpu-${Date.now()}`;
    logger.info('gpu spinUp (mock)', { id });
    return { instanceId: id, endpoint: 'http://localhost:0/mock' };
  },
  async tearDown(instanceId) {
    logger.info('gpu tearDown (mock)', { instanceId });
  },
  async list() {
    return [];
  },
};

// ---- RunPod provider. REST API (https://rest.runpod.io/v1) using creds from
// Vault secret 'gpu_provider_runpod':
//   { apiKey, templateId, networkVolumeId, dataCenterId,
//     gpuTypeId?, cloudType?, interruptible? }
// Pods are named with a prefix so list() only ever returns pipeline-created
// pods; the reaper kills anything list() returns that has no active job, and
// must never touch unrelated pods on the account. ----

const RUNPOD_REST = 'https://rest.runpod.io/v1';
const POD_NAME_PREFIX = 'hs-render-';
// Cold machines that must pull the Docker image take ~7-8m to first response
// (observed 446s live; some EU-RO-1 hosts observed >15m); warm machines take
// ~2-4m. The GPU_MAX_RUNTIME_MIN ceiling still bounds total cost.
const READY_TIMEOUT_MS = 20 * 60 * 1000;
// XTTS loads its model minutes AFTER ComfyUI answers; a slow boot must not
// starve its window (observed live: "xtts not ready within 15m").
const XTTS_EXTRA_MS = 6 * 60 * 1000;
const READY_POLL_MS = 10 * 1000;

async function runpodFetch(apiKey, path, options = {}) {
  const res = await fetch(`${RUNPOD_REST}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    // A hung RunPod API call must never hang the whole run (observed live:
    // pod create stalled >20m with no pod, no error, run stuck in spinUp).
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`runpod ${options.method || 'GET'} ${path} ${res.status}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

// REST timestamps look like "2026-07-07 17:12:52.52 +0000 UTC" (not ISO).
function parseRunpodDate(s) {
  if (!s) return null;
  const iso = String(s).replace(' +0000 UTC', 'Z').replace(' ', 'T');
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

// The template starts ComfyUI on 8188 and XTTS on 8020; RunPod fronts each
// exposed HTTP port at https://{podId}-{port}.proxy.runpod.net.
function podEndpoints(podId) {
  return {
    endpoint: `https://${podId}-8188.proxy.runpod.net`,
    ttsEndpoint: `https://${podId}-8020.proxy.runpod.net`,
  };
}

async function waitForHttpOk(url, deadline, label) {
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) {
      throw new Error(`runpod pod ${label} not ready within ${READY_TIMEOUT_MS / 60000}m`);
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
}

// The render uses BOTH services; XTTS finishes loading its model a few minutes
// after ComfyUI answers, so returning on ComfyUI alone races the TTS stage.
async function waitForPodReady({ endpoint, ttsEndpoint }) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  await waitForHttpOk(`${endpoint}/system_stats`, deadline, 'comfyui');
  // XTTS gets its own guaranteed window beyond whatever ComfyUI consumed.
  const xttsDeadline = Math.max(deadline, Date.now() + XTTS_EXTRA_MS);
  await waitForHttpOk(`${ttsEndpoint}/`, xttsDeadline, 'xtts');
}

function runpodProvider() {
  return {
    async spinUp() {
      const creds = await getSecretJson('gpu_provider_runpod');
      for (const field of ['apiKey', 'templateId', 'networkVolumeId', 'dataCenterId']) {
        if (!creds[field]) throw new Error(`gpu_provider_runpod vault secret missing "${field}"`);
      }
      const body = {
        name: `${POD_NAME_PREFIX}${Date.now()}`,
        cloudType: creds.cloudType || 'SECURE',
        computeType: 'GPU',
        gpuTypeIds: [creds.gpuTypeId || 'NVIDIA GeForce RTX 4090'],
        gpuCount: 1,
        dataCenterIds: [creds.dataCenterId],
        networkVolumeId: creds.networkVolumeId,
        volumeMountPath: '/workspace',
        containerDiskInGb: 40,
        templateId: creds.templateId,
        interruptible: creds.interruptible !== false,
        // Hosts with drivers older than the image's CUDA never start the
        // container (silent infinite stall). Constrain scheduling to hosts
        // that can actually run the cu12.8 image.
        allowedCudaVersions: creds.allowedCudaVersions || ['12.8', '12.9', '13.0'],
      };
      let pod;
      try {
        pod = await runpodFetch(creds.apiKey, '/pods', { method: 'POST', body: JSON.stringify(body) });
      } catch (err) {
        if (!body.interruptible) throw err;
        // Spot capacity dried up; fall back to on-demand rather than skip the day.
        logger.warn('runpod spot spinUp failed, retrying on-demand', { error: String(err) });
        pod = await runpodFetch(creds.apiKey, '/pods', {
          method: 'POST',
          body: JSON.stringify({ ...body, interruptible: false }),
        });
      }
      const { endpoint, ttsEndpoint } = podEndpoints(pod.id);
      logger.info('gpu spinUp (runpod)', { instanceId: pod.id, costPerHr: pod.costPerHr });
      try {
        await waitForPodReady({ endpoint, ttsEndpoint });
      } catch (err) {
        // Never leave a pod running that the caller has no handle to tear down.
        await runpodFetch(creds.apiKey, `/pods/${pod.id}`, { method: 'DELETE' }).catch(() => {});
        throw err;
      }
      return { instanceId: pod.id, endpoint, ttsEndpoint };
    },
    async tearDown(instanceId) {
      const creds = await getSecretJson('gpu_provider_runpod');
      await runpodFetch(creds.apiKey, `/pods/${instanceId}`, { method: 'DELETE' });
      logger.info('gpu tearDown (runpod)', { instanceId });
    },
    async list() {
      const creds = await getSecretJson('gpu_provider_runpod');
      const pods = (await runpodFetch(creds.apiKey, '/pods')) || [];
      return pods
        .filter((p) => p.name && p.name.startsWith(POD_NAME_PREFIX))
        .map((p) => ({ instanceId: p.id, createdAt: parseRunpodDate(p.createdAt) }));
    },
  };
}

function vastaiProvider() {
  return {
    async spinUp() {
      throw new Error('vastai provider not yet wired; set GPU_PROVIDER=mock for dry runs');
    },
    async tearDown(instanceId) {
      logger.warn('vastai tearDown not wired', { instanceId });
    },
    async list() {
      return [];
    },
  };
}

export function gpuProvider() {
  switch (config.gpu.provider) {
    case 'mock':
      return mockProvider;
    case 'runpod':
      return runpodProvider();
    case 'vastai':
      return vastaiProvider();
    default:
      throw new Error(`unknown GPU_PROVIDER: ${config.gpu.provider}`);
  }
}

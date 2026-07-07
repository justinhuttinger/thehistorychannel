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

// ---- RunPod skeleton. Real calls hit the RunPod GraphQL/REST API using a key
// from Vault. Left as a structured stub so the interface is provable now and
// the network calls can be filled in when the account is wired. ----
function runpodProvider() {
  return {
    async spinUp() {
      const creds = await getSecretJson('gpu_provider_runpod'); // { apiKey, templateId, ... }
      // TODO: POST podRentInterruptable with creds.templateId + config.gpu.instanceType.
      throw new Error(
        'runpod provider not yet wired; set GPU_PROVIDER=mock for dry runs. ' +
          `(have creds for account: ${Boolean(creds.apiKey)})`,
      );
    },
    async tearDown(instanceId) {
      const creds = await getSecretJson('gpu_provider_runpod');
      // TODO: POST podTerminate(instanceId) with creds.apiKey.
      logger.warn('runpod tearDown not wired', { instanceId, haveKey: Boolean(creds.apiKey) });
    },
    async list() {
      // TODO: query myself.pods and return [{ instanceId, createdAt }]
      return [];
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

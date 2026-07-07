// Supabase Vault access (§0, §1). Secrets (per-service credentials) live in
// Supabase Vault and are read server-side only, following the existing WCS
// vault pattern. Never commit secrets or put them in client code.
//
// Vault secrets are exposed to the service role via the `vault.decrypted_secrets`
// view. We read by name, cache in-process, and (in dev only) fall back to an
// env var so local iteration does not require a populated Vault.

import { supabase } from './supabase.js';
import { config } from '../config.js';
import { logger } from './logger.js';

const cache = new Map();

// Dev-only env fallbacks, keyed by vault secret name.
const ENV_FALLBACK = {
  anthropic_api_key: () => config.anthropicApiKeyEnv,
};

export async function getSecret(name) {
  if (cache.has(name)) return cache.get(name);

  let value = null;
  try {
    const { data, error } = await supabase()
      .schema('vault')
      .from('decrypted_secrets')
      .select('decrypted_secret')
      .eq('name', name)
      .maybeSingle();
    if (error) throw error;
    if (data) value = data.decrypted_secret;
  } catch (err) {
    logger.warn('vault read failed, will try env fallback', { name, error: String(err) });
  }

  if (!value && config.env !== 'production' && ENV_FALLBACK[name]) {
    const fallback = ENV_FALLBACK[name]();
    if (fallback) {
      logger.warn('using env fallback for secret (dev only)', { name });
      value = fallback;
    }
  }

  if (!value) {
    throw new Error(`vault secret "${name}" not found`);
  }
  cache.set(name, value);
  return value;
}

// Secrets are JSON blobs for multi-field credentials (OAuth refresh tokens,
// service-account JSON). Parse defensively.
export async function getSecretJson(name) {
  const raw = await getSecret(name);
  try {
    return typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch (err) {
    throw new Error(`vault secret "${name}" is not valid JSON: ${String(err)}`);
  }
}

// Test/boot helper.
export function clearSecretCache() {
  cache.clear();
}

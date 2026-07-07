// Runtime config (§7). Env holds only non-secret flags + the Supabase bootstrap
// credentials. Real secrets come from Supabase Vault (see lib/vault.js).

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return value === 'true' || value === '1' || value === 'yes';
}

function list(value) {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 3000),

  supabase: {
    url: process.env.SUPABASE_URL || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  // Guardrail: default false => Shorts upload as private + scheduled. Human
  // safety net for hallucinated facts.
  ytAutoPublic: bool(process.env.YT_AUTO_PUBLIC, false),

  gpu: {
    provider: process.env.GPU_PROVIDER || 'mock', // mock | runpod | vastai
    instanceType: process.env.GPU_INSTANCE_TYPE || 'NVIDIA_RTX_4090',
    maxRuntimeMin: Number(process.env.GPU_MAX_RUNTIME_MIN || 30),
  },

  tts: {
    provider: process.env.TTS_PROVIDER || 'mock', // mock | xtts | <paid slug>
  },

  drive: {
    // 'auto' => detect on boot. 'true'/'false' force it.
    writeEnabled: process.env.DRIVE_WRITE_ENABLED || 'auto',
    queueFolderName: 'TikTok Queue',
  },

  // Which series slugs the cron controller runs.
  seriesEnabled: list(process.env.SERIES_ENABLED),

  defaultLengthProfile: process.env.TARGET_LENGTH_PROFILE || 'short',

  notify: {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  },

  // Local dev fallback for the Anthropic key if Vault is unreachable.
  anthropicApiKeyEnv: process.env.ANTHROPIC_API_KEY || '',
};

// Word budget targets by length profile (~150 wpm, §2/§6).
export const LENGTH_PROFILES = {
  short: { minSeconds: 30, maxSeconds: 45, targetWords: 95, beats: [1, 2] },
  mono: { minSeconds: 60, maxSeconds: 90, targetWords: 190, beats: [3, 5] },
};

export function lengthProfile(name) {
  return LENGTH_PROFILES[name] || LENGTH_PROFILES.short;
}

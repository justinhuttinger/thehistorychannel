// Runtime config (§7). Env holds only non-secret flags + the Supabase bootstrap
// credentials. Real secrets come from Supabase Vault (see lib/vault.js).
// Local dev reads .env via dotenv; a no-op when the file is absent (Render).
import 'dotenv/config';

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

  // When false, skip the YouTube upload entirely (Drive/TikTok-only phase).
  // The youtube_shorts destination row stays 'pending' for a later backfill.
  ytEnabled: bool(process.env.YT_ENABLED, true),

  gpu: {
    provider: process.env.GPU_PROVIDER || 'mock', // mock | runpod | vastai
    instanceType: process.env.GPU_INSTANCE_TYPE || 'NVIDIA_RTX_4090',
    maxRuntimeMin: Number(process.env.GPU_MAX_RUNTIME_MIN || 45),
    // 'video' = short Wan motion clip per beat (looped under narration);
    // 'image' = one still per beat (faster, cheaper).
    wanMode: process.env.WAN_MODE || 'video',
    // Wan latent constraint: (frames - 1) % 4 == 0. 49 frames ~= 2s at 24fps.
    videoFrames: Number(process.env.WAN_VIDEO_FRAMES || 49),
  },

  tts: {
    provider: process.env.TTS_PROVIDER || 'mock', // mock | xtts | <paid slug>
    // Pitch-preserving narration speed-up applied at compose time (ffmpeg
    // atempo). 1.0 = as synthesized; short-form pacing wants ~1.15.
    voiceSpeed: Number(process.env.VOICE_SPEED || 1.15),
  },

  drive: {
    // 'auto' => detect on boot. 'true'/'false' force it.
    writeEnabled: process.env.DRIVE_WRITE_ENABLED || 'auto',
    queueFolderName: 'TikTok Queue',
    // ID of a folder in the owner's Drive shared with the service account.
    // Required in practice: service accounts have no storage quota of their
    // own, so writes must land in a human-owned (or shared-drive) folder.
    queueFolderId: process.env.DRIVE_QUEUE_FOLDER_ID || '',
  },

  // Which series slugs the cron controller runs.
  seriesEnabled: list(process.env.SERIES_ENABLED),

  // Posting schedule (server-local time, UTC on Render): comma-separated HH:MM
  // list applied to every enabled series. Empty = each series' own post_time.
  postTimes: list(process.env.POST_TIMES),

  defaultLengthProfile: process.env.TARGET_LENGTH_PROFILE || 'short',

  notify: {
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL || '',
  },

  // Local dev fallback for the Anthropic key if Vault is unreachable.
  anthropicApiKeyEnv: process.env.ANTHROPIC_API_KEY || '',
};

// Word budget targets by length profile (~150 wpm, §2/§6). More beats = a new
// visual every ~6-10 seconds, which short-form pacing demands. 'short' runs
// 45-60s so the story has room for cause, mechanism, and aftermath.
export const LENGTH_PROFILES = {
  short: { minSeconds: 45, maxSeconds: 60, targetWords: 140, beats: [6, 8] },
  mono: { minSeconds: 60, maxSeconds: 90, targetWords: 190, beats: [8, 12] },
};

export function lengthProfile(name) {
  return LENGTH_PROFILES[name] || LENGTH_PROFILES.short;
}

-- Storage buckets (§1, §8 step 1).
-- Run after 001_schema.sql. Buckets are private; access is via signed URLs
-- generated server-side.
--
-- Supabase exposes storage.buckets; inserting is idempotent via on conflict.

insert into storage.buckets (id, name, public)
values
  ('hs-tts',          'hs-tts',          false),   -- per-beat narration audio
  ('hs-visuals',      'hs-visuals',      false),   -- generated Wan 2.2 frames/clips
  ('hs-masters',      'hs-masters',      false),   -- final 9:16 master MP4s
  ('hs-variants',     'hs-variants',     false),   -- per-platform cuts (clean tiktok cut, branded shorts cut)
  ('tiktok-queue',    'tiktok-queue',    false)    -- fallback for TikTok packages when Drive write scope is unavailable
on conflict (id) do nothing;

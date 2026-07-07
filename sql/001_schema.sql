-- History Shorts data model (§3).
-- All tables are namespaced with hs_ to avoid collision with existing
-- WCS/affiliate tables if this shares a Supabase project.

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- hs_series: recurring show definitions.
-- ---------------------------------------------------------------------------
create table if not exists hs_series (
  id           uuid primary key default gen_random_uuid(),
  slug         text not null unique,              -- stable key used by SERIES_ENABLED / cron
  name         text not null,                     -- e.g. "Forgotten Disasters"
  sub_niche    text,
  -- Rigid visual-style string appended to every Wan prompt for this series.
  -- Locks the look across every episode.
  style_suffix text not null default '',
  voice_id     text,                              -- TTS voice for this series
  tone         text,                              -- per-series narration tone (feeds script prompt)
  active       boolean not null default true,
  post_time    time not null default '09:00',     -- daily scheduled slot
  created_at   timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- hs_episodes: one row per generated video.
-- ---------------------------------------------------------------------------
create table if not exists hs_episodes (
  id                    uuid primary key default gen_random_uuid(),
  series_id             uuid not null references hs_series(id) on delete cascade,
  topic                 text not null,
  hook                  text,                      -- one-line opening hook
  target_length_profile text not null default 'short'
                          check (target_length_profile in ('short', 'mono')),
  -- Array of beats: [{ narration, visual_prompt }]
  script_json           jsonb,
  factcheck_status      text not null default 'pending'
                          check (factcheck_status in ('pending', 'clean', 'flagged')),
  factcheck_notes       text,
  state                 text not null default 'draft'
                          check (state in ('draft', 'scripted', 'rendering',
                                           'rendered', 'review', 'published', 'failed')),
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- Topic dedup: never repeat a topic per series (case-insensitive).
create unique index if not exists hs_episodes_series_topic_ci
  on hs_episodes (series_id, lower(topic));

create index if not exists hs_episodes_state on hs_episodes (state);

-- ---------------------------------------------------------------------------
-- hs_render_jobs: one row per render attempt (recoverable state).
-- ---------------------------------------------------------------------------
create table if not exists hs_render_jobs (
  id              uuid primary key default gen_random_uuid(),
  episode_id      uuid not null references hs_episodes(id) on delete cascade,
  gpu_instance_id text,                            -- provider instance handle for teardown
  step            text not null default 'tts'
                    check (step in ('tts', 'visuals', 'compose', 'done', 'error')),
  error           text,
  final_video_url text,                            -- Supabase Storage path to master 9:16 cut
  started_at      timestamptz not null default now(),
  finished_at     timestamptz
);

create index if not exists hs_render_jobs_episode on hs_render_jobs (episode_id);
-- Reaper scans for live GPU instances with no active job.
create index if not exists hs_render_jobs_gpu_active
  on hs_render_jobs (gpu_instance_id)
  where step in ('tts', 'visuals', 'compose');

-- ---------------------------------------------------------------------------
-- hs_destinations: per-episode, per-platform publish state.
-- One row per platform per episode.
-- ---------------------------------------------------------------------------
create table if not exists hs_destinations (
  id                uuid primary key default gen_random_uuid(),
  episode_id        uuid not null references hs_episodes(id) on delete cascade,
  platform          text not null check (platform in ('youtube_shorts', 'tiktok')),
  variant_video_url text,                          -- platform-specific cut (clean cut for tiktok)
  caption           text,                          -- platform-specific caption (no em dashes)
  status            text not null default 'pending',
                    -- youtube: pending|uploaded|failed
                    -- tiktok:  queued|posted (posted set manually)
  external_id       text,                          -- youtube video id once uploaded
  drive_path        text,                          -- tiktok package location
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

create unique index if not exists hs_destinations_episode_platform
  on hs_destinations (episode_id, platform);

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------
create or replace function hs_touch_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

drop trigger if exists hs_episodes_touch on hs_episodes;
create trigger hs_episodes_touch before update on hs_episodes
  for each row execute function hs_touch_updated_at();

drop trigger if exists hs_destinations_touch on hs_destinations;
create trigger hs_destinations_touch before update on hs_destinations
  for each row execute function hs_touch_updated_at();

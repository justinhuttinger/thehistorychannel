// Data access. All state is written to Supabase at every step so a mid-run
// crash is resumable (§5). Thin wrappers around the tables in §3.

import { supabase } from '../lib/supabase.js';

// ---------------- series ----------------

export async function getSeriesBySlug(slug) {
  const { data, error } = await supabase()
    .from('hs_series')
    .select('*')
    .eq('slug', slug)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function listActiveSeries() {
  const { data, error } = await supabase()
    .from('hs_series')
    .select('*')
    .eq('active', true);
  if (error) throw error;
  return data || [];
}

// ---------------- episodes ----------------

// Topic dedup (§3): case-insensitive check within the same series before insert.
export async function topicExists(seriesId, topic) {
  const { data, error } = await supabase()
    .from('hs_episodes')
    .select('id')
    .eq('series_id', seriesId)
    .ilike('topic', topic)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

export async function listUsedTopics(seriesId, limit = 200) {
  const { data, error } = await supabase()
    .from('hs_episodes')
    .select('topic')
    .eq('series_id', seriesId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data || []).map((r) => r.topic);
}

export async function insertEpisode(row) {
  const { data, error } = await supabase()
    .from('hs_episodes')
    .insert(row)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateEpisode(id, patch) {
  const { data, error } = await supabase()
    .from('hs_episodes')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getEpisode(id) {
  const { data, error } = await supabase()
    .from('hs_episodes')
    .select('*')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// ---------------- render jobs ----------------

export async function insertRenderJob(episodeId) {
  const { data, error } = await supabase()
    .from('hs_render_jobs')
    .insert({ episode_id: episodeId, step: 'tts' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function updateRenderJob(id, patch) {
  const { data, error } = await supabase()
    .from('hs_render_jobs')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// Jobs still holding a GPU instance in an active step. Feeds the reaper (§5).
export async function activeGpuJobs() {
  const { data, error } = await supabase()
    .from('hs_render_jobs')
    .select('*')
    .in('step', ['tts', 'visuals', 'compose'])
    .not('gpu_instance_id', 'is', null);
  if (error) throw error;
  return data || [];
}

// ---------------- destinations ----------------

// Idempotent upsert keyed by (episode_id, platform) so publish fan-out never
// double-inserts on re-run (§5 idempotency).
export async function upsertDestination(row) {
  const { data, error } = await supabase()
    .from('hs_destinations')
    .upsert(row, { onConflict: 'episode_id,platform' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function getDestination(episodeId, platform) {
  const { data, error } = await supabase()
    .from('hs_destinations')
    .select('*')
    .eq('episode_id', episodeId)
    .eq('platform', platform)
    .maybeSingle();
  if (error) throw error;
  return data;
}

export async function updateDestination(id, patch) {
  const { data, error } = await supabase()
    .from('hs_destinations')
    .update(patch)
    .eq('id', id)
    .select()
    .single();
  if (error) throw error;
  return data;
}

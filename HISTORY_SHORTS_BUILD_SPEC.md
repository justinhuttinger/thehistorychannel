# HISTORY_SHORTS_BUILD_SPEC.md

Automated animated-history short-form video pipeline. Growth-first. One vertical
render per episode feeds two destinations: YouTube Shorts (auto-upload, scheduled
private) and TikTok (packaged to Google Drive for manual posting).

> **Scope note for Claude Code:** This is a STANDALONE project. It is NOT the
> Amazon-affiliate gift-guide system in `COMPLETE_BUILD_SPEC.md`. Do not merge
> with or import from that project. It reuses the same *stack* (Supabase, Render,
> Node/Express, Claude API) and the same *architectural patterns* (cron jobs,
> upsert, Supabase Vault for secrets, per-job state rows), but it is a separate
> repo, separate Supabase project (or clearly namespaced tables), and separate
> Render service.

---

## 0. Guardrails (build these in; do not treat as optional)

- **No em dashes in any generated copy** (titles, captions, scripts). Hard rule.
- **Fact-check pass is mandatory.** History content hallucinates dates/names.
  Every script gets a second Claude call that flags likely-fabricated facts.
  Flagged episodes do NOT auto-publish; they land in `review` state.
- **YouTube Shorts auto-uploads as `private` + scheduled**, never immediately
  public, until the operator flips a config flag. This is the human safety net
  for hallucinated facts. Manual TikTok posting is the equivalent gate on that side.
- **No baked-in watermark, logo, or channel branding on the TikTok cut.** TikTok
  ToS prohibits app-added watermarks/promo text and penalizes it. The TikTok cut
  is clean; the Shorts cut may carry light branding if desired.
- **Per-platform content variation.** TikTok scores reused/cross-posted content
  harshly. The TikTok cut gets its own caption (distinct hook + hashtags),
  generated separately, not a copy of the YouTube title.
- **GPU teardown is guaranteed.** Every render job spins the GPU down in a
  `finally` block. A hung job must never leave a billing instance running.
- **Secrets in Supabase Vault**, never in client code or committed files. Follows
  the existing WCS vault pattern (per-service credentials, server-side only).

---

## 1. Stack (all existing infra)

- **Supabase** — Postgres (source of truth) + Storage (rendered clips, TTS audio,
  final MP4s, TikTok packages if not using Drive).
- **Render** — Node/Express service + cron jobs (topic/script/orchestration) and
  an on-demand controller that drives the GPU render.
- **Claude API** — topic generation, script generation, fact-check, per-platform
  caption generation.
- **Rented GPU** (RunPod or Vast.ai) running **ComfyUI** with **Wan 2.2**
  (Apache-2.0, commercial-safe) for image/video generation. Spun up per batch,
  torn down after.
- **Self-hosted TTS** (XTTS/Coqui) on the same GPU box, or a paid TTS API behind
  an interface so it can be swapped. Interface it; do not hardcode a provider.
- **Remotion or FFmpeg** — compose beats + audio + burned-in captions → 9:16 MP4.
- **YouTube Data API v3** — Shorts upload (OAuth refresh-token pattern, same as GHL).
- **Google Drive API** — write TikTok packages to a queue folder. NOTE: Drive
  *write* scope has been flaky in this org before; verify write scope on boot and
  fall back to a Supabase Storage bucket + signed URL if write fails.

---

## 2. Output format

- Vertical **9:16, 1080x1920, H.264 MP4**.
- **Default length parameter = short (30–45s).** Build length as a parameter
  (`target_length_profile`: `short` | `mono` [60–90s]). Ship with `short`.
  `mono` exists for later TikTok Creator Rewards monetization (needs 60s+) but is
  NOT used in the initial growth phase.
- **Burned-in captions** on both cuts (retention driver for faceless content).
- One or two beats for `short`; more for `mono`.

---

## 3. Data model (Supabase)

Namespace all tables with a `hs_` prefix (history-shorts) to avoid collision with
existing WCS/affiliate tables if sharing a project.

### `hs_series`
Recurring show definitions.
- `id` (uuid, pk)
- `name` (text)                         e.g. "Forgotten Disasters"
- `sub_niche` (text)
- `style_suffix` (text)                 rigid visual-style string appended to every
                                        Wan prompt for this series (locks look)
- `voice_id` (text)                     TTS voice for this series
- `active` (bool)
- `post_time` (time)                    daily scheduled slot
- `created_at` (timestamptz)

### `hs_episodes`
One row per generated video.
- `id` (uuid, pk)
- `series_id` (fk → hs_series)
- `topic` (text)
- `hook` (text)                         one-line opening hook
- `target_length_profile` (text)        'short' | 'mono'
- `script_json` (jsonb)                 array of beats: {narration, visual_prompt}
- `factcheck_status` (text)             'pending' | 'clean' | 'flagged'
- `factcheck_notes` (text)
- `state` (text)                        'draft' | 'scripted' | 'rendering' |
                                        'rendered' | 'review' | 'published' | 'failed'
- `created_at`, `updated_at` (timestamptz)

> Topic dedup: before inserting, check `hs_episodes` for an existing `topic`
> (case-insensitive) within the same `series_id`. Never repeat a topic per series.

### `hs_render_jobs`
One row per render attempt (recoverable state).
- `id` (uuid, pk)
- `episode_id` (fk → hs_episodes)
- `gpu_instance_id` (text)              provider instance handle for teardown
- `step` (text)                         'tts' | 'visuals' | 'compose' | 'done' | 'error'
- `error` (text)
- `final_video_url` (text)              Supabase Storage path to the master 9:16 cut
- `started_at`, `finished_at` (timestamptz)

### `hs_destinations`
Per-episode, per-platform publish state (one row per platform per episode).
- `id` (uuid, pk)
- `episode_id` (fk → hs_episodes)
- `platform` (text)                     'youtube_shorts' | 'tiktok'
- `variant_video_url` (text)            platform-specific cut (clean cut for tiktok)
- `caption` (text)                      platform-specific caption (no em dashes)
- `status` (text)                       youtube: 'pending'|'uploaded'|'failed'
                                        tiktok: 'queued'|'posted' (posted set manually)
- `external_id` (text)                  youtube video id once uploaded
- `drive_path` (text)                   tiktok package location
- `created_at`, `updated_at` (timestamptz)

---

## 4. Pipeline stages (cron-triggered controller, one run per active series)

1. **Topic gen** (Claude). Input: series + list of used topics. Output: topic +
   hook. Insert `hs_episodes` (state `draft`). Dedup check first.
2. **Script gen** (Claude). Output STRICT JSON: array of beats, each
   `{narration, visual_prompt}`, sized to `target_length_profile` (~150 words/min).
   Store in `script_json`, state → `scripted`. (This prompt is the highest-leverage
   piece; see §6.)
3. **Fact-check** (Claude). Re-read script, flag likely fabricated dates/names/events.
   `clean` → continue. `flagged` → state `review`, stop (operator resolves).
4. **Render** (GPU controller, on-demand). Create `hs_render_jobs` row. Spin up
   GPU. In a `try/finally`:
   - **TTS**: each beat narration → audio, capture durations.
   - **Visuals**: each `visual_prompt` + series `style_suffix` → Wan 2.2 via
     ComfyUI. Generate; on garbage-frame heuristics, retry once, else accept.
   - **Compose**: Remotion/FFmpeg stitch beats + audio + burned-in captions →
     master 9:16 MP4 → Supabase Storage. Set `final_video_url`, state `rendered`.
   - **`finally`: tear down GPU instance** using `gpu_instance_id`. Always.
5. **Per-platform variant** (per episode → 2 `hs_destinations` rows):
   - **youtube_shorts**: master cut (branding OK). Caption = Claude-generated
     YouTube title/description.
   - **tiktok**: CLEAN cut (no watermark/branding). Caption = separately
     Claude-generated native TikTok caption + hashtags (distinct hook).
6. **Publish fan-out**:
   - **youtube_shorts**: upload via Data API as **`private` + scheduled** publish
     (config flag `YT_AUTO_PUBLIC=false` by default). Set `external_id`, status
     `uploaded`. Under 60s → auto-classified as a Short.
   - **tiktok**: write package to Drive queue folder
     `TikTok Queue/{YYYY-MM-DD}_{slug}/` containing `video.mp4` + `caption.txt`.
     Set `drive_path`, status `queued`. (Human posts manually, flips to `posted`.)
   - Verify Drive write scope on boot; if unavailable, write to Supabase Storage
     bucket `tiktok-queue/` and record signed URL in `drive_path` instead.
7. **Notify**: on success or any `error`/`review`, post a summary (email/Slack)
   listing what published, what needs review, what failed.

---

## 5. Orchestration & reliability

- One cron controller per active series, staggered by `post_time`.
- Write state to Supabase at every step so a mid-run crash is resumable.
- GPU: prefer spot/interruptible for cost; controller MUST handle reclaim
  (job killed) by marking `hs_render_jobs.step='error'` and retrying on next run.
- **Teardown safety**: a scheduled reaper job checks for GPU instances with no
  active `hs_render_jobs` and kills orphans (belt-and-suspenders on the `finally`).
- Idempotency: re-running a stage must not double-post or double-charge.

---

## 6. The script-generation prompt (build as a versioned, editable template)

Store as an editable prompt (config or DB), not inlined, so it can be tuned
without redeploy. Requirements the prompt must enforce:
- Opening hook in the first ~3 seconds (first beat).
- Clear narrative arc across beats; economical, momentum from line one.
- Target word count from `target_length_profile` (~150 wpm).
- Output ONLY valid JSON (no prose, no markdown fences): array of
  `{narration, visual_prompt}`. Parse defensively; strip stray fences before parse.
- Per-series tone taken from the series row.
- **No em dashes.**
- `visual_prompt` describes a concrete, animatable scene (Wan 2.2 image/video),
  NOT text-on-screen instructions.

---

## 7. Config flags (env or a runtime config table)

- `YT_AUTO_PUBLIC` (default `false`) — when true, Shorts publish public immediately.
- `GPU_PROVIDER`, `GPU_INSTANCE_TYPE`, `GPU_MAX_RUNTIME_MIN` (hard kill ceiling).
- `TTS_PROVIDER` (interface; default self-hosted XTTS).
- `DRIVE_WRITE_ENABLED` (auto-detected on boot; fallback to Storage bucket).
- `SERIES_ENABLED` — which series the cron runs.

---

## 8. Build order (for the one-pass build)

1. Supabase schema (§3) + Storage buckets.
2. Config + Vault wiring (§7), boot-time Drive write-scope check.
3. Controller skeleton (§4/§5) with GPU spin-up/**`finally` teardown** stubs and
   full state transitions — provable before real generation is wired.
4. Claude calls: topic → script (§6) → fact-check → captions. JSON parse guards.
5. GPU render step: ComfyUI/Wan 2.2 visuals + TTS + Remotion/FFmpeg compose.
6. Per-platform variant + publish fan-out (YT private-scheduled upload; TikTok
   Drive package).
7. Reaper job + notifications.
8. One end-to-end dry run on ONE series, ONE episode, `short` profile, before
   enabling cron/multi-series.

## 9. Explicit non-goals (initial phase)

- No TikTok API / auto-posting (manual on purpose; sidesteps audit, token
  refresh, aggregator fees, ban risk).
- No `mono` (60–90s) monetization cut yet (parameter exists, unused).
- No long-form YouTube (Shorts only).
- No analytics/earnings dashboard yet (add once something performs).

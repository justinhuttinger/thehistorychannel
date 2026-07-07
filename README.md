# History Shorts Pipeline

Automated animated-history short-form video pipeline. Growth-first. One vertical
render per episode feeds two destinations:

- **YouTube Shorts** — auto-uploaded as **private + scheduled** (safety net).
- **TikTok** — packaged to **Google Drive** for manual posting.

This is a **standalone** project. It reuses the WCS *stack* (Supabase, Render,
Node/Express, Claude API) and *patterns* (cron jobs, upsert, Supabase Vault for
secrets, per-job state rows), but it is a separate repo / Supabase project /
Render service. It is **not** the Amazon-affiliate gift-guide system.

See `HISTORY_SHORTS_BUILD_SPEC.md` for the full spec.

## Guardrails (built in, not optional)

| Guardrail | Where it lives |
|---|---|
| **No em dashes** in any generated copy (hard rule) | `src/lib/text.js` (`stripEmDashes`, applied in every Claude call module; asserted in `script.js`) |
| **Mandatory fact-check pass**; flagged episodes do NOT auto-publish, they land in `review` | `src/claude/factcheck.js`, gated in `src/pipeline/controller.js` |
| **YouTube uploads private + scheduled** until `YT_AUTO_PUBLIC=true` | `src/publish/youtube.js` |
| **No watermark/branding on the TikTok cut** (TikTok ToS) | `src/publish/variants.js` (branding only ever applied to the Shorts cut) |
| **Per-platform content variation** (distinct TikTok caption + hashtags) | `src/claude/captions.js` (separate YouTube vs TikTok generation) |
| **Guaranteed GPU teardown** in a `finally` block | `src/render/controller.js`; backstop reaper in `src/jobs/reaper.js` |
| **Secrets in Supabase Vault**, never committed | `src/lib/vault.js` |

## Architecture

```
cron / POST /run/:slug
        │
        ▼
pipeline/controller.js  (one run per active series)
  1 topic gen  ──► claude/topic.js        (dedup vs hs_episodes)
  2 script gen ──► claude/script.js       (strict JSON beats, ~150 wpm)
  3 factcheck  ──► claude/factcheck.js    (clean → continue; flagged → review, STOP)
  4 render     ──► render/controller.js   (GPU spin-up → TTS → visuals → compose → finally teardown)
  5 variants   ──► publish/variants.js    (clean tiktok cut + shorts cut)
  6 publish    ──► publish/youtube.js  (private+scheduled)  &  publish/drive.js (Drive queue / Storage fallback)
  7 notify     ──► jobs/notify.js
```

State is written to Supabase at every step (`hs_episodes.state`,
`hs_render_jobs.step`) so a mid-run crash or spot reclaim is resumable.

## Data model

Tables are namespaced `hs_` (§3): `hs_series`, `hs_episodes`, `hs_render_jobs`,
`hs_destinations`. Schema in `sql/001_schema.sql`; storage buckets in
`sql/002_storage_buckets.sql`.

## Setup

1. **Supabase**: run the SQL in order.
   ```sql
   \i sql/001_schema.sql
   \i sql/002_storage_buckets.sql
   \i sql/003_seed_example.sql   -- optional example series
   ```
2. **Vault secrets** (server-side only). Add these secrets in Supabase Vault:
   - `anthropic_api_key` — Claude API key
   - `youtube_oauth` — JSON `{ "client_id", "client_secret", "refresh_token" }`
   - `google_drive_sa` — Drive service-account JSON (drive scope)
   - `gpu_provider_runpod` — JSON `{ "apiKey", "templateId", ... }` (when GPU is wired)
3. **Env**: copy `.env.example` to `.env`, set `SUPABASE_URL` +
   `SUPABASE_SERVICE_ROLE_KEY` and the config flags (§7). For local dev you may
   set `ANTHROPIC_API_KEY` in env as a Vault fallback. `.env` is loaded via
   dotenv; on Render set real env vars instead.
4. `npm install`

> **Node version:** supabase-js requires native `WebSocket` (Node 22+). On
> Node 20.10+, run with `NODE_OPTIONS=--experimental-websocket`.

## Running

```bash
npm test          # offline guardrail tests (no network)
npm run dry-run   # end-to-end dry run, one series/episode, mock GPU+TTS, publish skipped
npm run reaper    # one reaper pass
npm start         # Express service + cron controllers + reaper
```

Dry run (mock providers, no real GPU, nothing published):

```bash
SERIES_SLUG=forgotten-disasters GPU_PROVIDER=mock TTS_PROVIDER=mock npm run dry-run
```

### Endpoints

- `GET /healthz` — liveness + effective flags
- `POST /run/:slug` — on-demand run (bearer = service-role key in production)
- `POST /reaper` — trigger a reaper pass

## Config flags (§7)

See `.env.example`. Key ones: `YT_AUTO_PUBLIC` (default false), `GPU_PROVIDER`
(`mock`/`runpod`/`vastai`), `GPU_MAX_RUNTIME_MIN` (hard kill ceiling),
`TTS_PROVIDER` (`mock`/`xtts`), `DRIVE_WRITE_ENABLED` (`auto` detected on boot),
`SERIES_ENABLED`, `TARGET_LENGTH_PROFILE` (`short` ships; `mono` exists, unused).

## What is fully wired vs. stubbed

**Fully implemented:** schema + buckets, config + Vault wiring, boot-time Drive
write-scope check with Storage fallback, the full controller state machine and
transitions, all four Claude calls (topic/script/factcheck/captions) with
defensive JSON parsing and em-dash stripping, per-platform variants, YouTube
Data API upload (private+scheduled), Drive/Storage TikTok packaging, reaper,
notifications, cron registration, and a mock GPU/TTS/compose path that runs the
whole pipeline end to end.

**Interfaced with stubs to fill in when the accounts/hardware are provisioned:**

- `src/render/gpu.js` — RunPod/Vast.ai spin-up/teardown/list network calls.
- `src/render/tts.js` — XTTS/Coqui HTTP synthesis.
- `src/render/visuals.js` — ComfyUI + Wan 2.2 workflow calls (garbage-frame
  heuristic hook is present; retry-once logic is implemented).
- `src/render/compose.js` — uses real FFmpeg when present (9:16 1080x1920,
  burned-in captions, concat); writes a placeholder master when FFmpeg is
  absent so the state machine is provable in CI.

Each stub throws a clear error telling you to use `GPU_PROVIDER=mock` /
`TTS_PROVIDER=mock` until it is wired, so nothing silently no-ops.

## Non-goals (initial phase, §9)

No TikTok API / auto-posting (manual on purpose). No `mono` monetization cut
yet (parameter exists, unused). No long-form YouTube. No analytics dashboard.

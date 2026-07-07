// End-to-end dry run on ONE series, ONE episode, `short` profile (§8 step 8).
//
// Runs the full pipeline with mock GPU/TTS providers so no real GPU is spun up.
// Publish fan-out is SKIPPED (dryRunPublish) so nothing is uploaded or queued;
// the episode lands in `rendered` with both destination rows created.
//
// Requires: SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY, an Anthropic key (Vault or
// ANTHROPIC_API_KEY in dev), and a seeded series (see sql/003_seed_example.sql).
//
// Usage: SERIES_SLUG=forgotten-disasters GPU_PROVIDER=mock TTS_PROVIDER=mock npm run dry-run

import { runSeries } from '../src/pipeline/controller.js';
import { logger } from '../src/lib/logger.js';

const slug = process.env.SERIES_SLUG;
if (!slug) {
  console.error('set SERIES_SLUG to the series to dry-run, e.g. forgotten-disasters');
  process.exit(1);
}

runSeries(slug, { dryRunPublish: true })
  .then((summary) => {
    logger.info('dry-run complete', { summary });
    console.log(JSON.stringify(summary, null, 2));
    process.exit(0);
  })
  .catch((err) => {
    logger.error('dry-run failed', { error: String(err) });
    process.exit(1);
  });

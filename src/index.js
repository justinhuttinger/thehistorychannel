// Render service entrypoint (§1, §5). Express app + cron controllers.
//   - One cron controller per active series, staggered by post_time.
//   - A scheduled reaper (belt-and-suspenders GPU teardown).
//   - Boot-time Drive write-scope check (§8 step 2).
//   - Manual trigger endpoints for on-demand runs.

import express from 'express';
import cron from 'node-cron';
import { config } from './config.js';
import { logger } from './lib/logger.js';
import { verifyDriveWriteScope } from './publish/drive.js';
import { runSeries } from './pipeline/controller.js';
import { runReaper } from './jobs/reaper.js';
import { getSeriesBySlug } from './db/repositories.js';

const app = express();
app.use(express.json());

app.get('/healthz', (_req, res) => {
  res.json({ ok: true, env: config.env, ytAutoPublic: config.ytAutoPublic });
});

// Manual on-demand run for one series. In production, protect with the same
// service-role bearer used elsewhere; skipped in dev.
app.post('/run/:slug', async (req, res) => {
  if (config.env === 'production') {
    const auth = req.get('authorization') || '';
    if (auth !== `Bearer ${config.supabase.serviceRoleKey}`) {
      return res.status(401).json({ error: 'unauthorized' });
    }
  }
  const { slug } = req.params;
  const series = await getSeriesBySlug(slug).catch(() => null);
  if (!series) return res.status(404).json({ error: `series "${slug}" not found` });
  // Fire and forget; return quickly so cron/HTTP callers do not block on render.
  runSeries(slug).catch((err) => logger.error('manual run failed', { slug, error: String(err) }));
  return res.status(202).json({ accepted: true, slug });
});

app.post('/reaper', async (_req, res) => {
  const result = await runReaper().catch((err) => ({ error: String(err) }));
  res.json(result);
});

// Convert an HH:MM post_time to a daily cron expression.
function dailyCron(postTime) {
  const [h = '9', m = '0'] = String(postTime || '09:00').split(':');
  return `${Number(m)} ${Number(h)} * * *`;
}

async function registerCrons() {
  // Reaper every 10 minutes (§5).
  cron.schedule('*/10 * * * *', () => {
    runReaper().catch((err) => logger.error('reaper cron failed', { error: String(err) }));
  });

  // One controller per active series. POST_TIMES (if set) schedules multiple
  // runs per day for every enabled series; otherwise the series' own
  // post_time runs once daily. Times are server-local (UTC on Render).
  for (const slug of config.seriesEnabled) {
    const series = await getSeriesBySlug(slug).catch(() => null);
    if (!series || !series.active) {
      logger.warn('series enabled but not active/found; skipping cron', { slug });
      continue;
    }
    const times = config.postTimes.length ? config.postTimes : [series.post_time];
    for (const t of times) {
      const expr = dailyCron(t);
      cron.schedule(expr, () => {
        logger.info('cron run start', { slug, expr });
        runSeries(slug).catch((err) => logger.error('cron run failed', { slug, error: String(err) }));
      });
      logger.info('registered series cron', { slug, expr });
    }
  }
}

async function main() {
  // Boot-time Drive write-scope check; result drives the Storage fallback (§1).
  await verifyDriveWriteScope().catch((err) =>
    logger.warn('drive scope check errored at boot', { error: String(err) }),
  );
  await registerCrons();
  app.listen(config.port, () => {
    logger.info('history-shorts service listening', {
      port: config.port,
      series: config.seriesEnabled,
    });
  });
}

main().catch((err) => {
  logger.error('fatal boot error', { error: String(err) });
  process.exit(1);
});

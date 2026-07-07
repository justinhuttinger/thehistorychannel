// Standalone reaper run (§5). Useful as a Render cron job entry separate from
// the long-lived service, or for manual invocation.

import { runReaper } from '../src/jobs/reaper.js';
import { logger } from '../src/lib/logger.js';

runReaper()
  .then((result) => {
    logger.info('reaper done', { result });
    process.exit(0);
  })
  .catch((err) => {
    logger.error('reaper failed', { error: String(err) });
    process.exit(1);
  });

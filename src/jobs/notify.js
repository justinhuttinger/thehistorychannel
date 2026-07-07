// Notifications (§4.7). On success or any error/review, post a summary listing
// what published, what needs review, what failed. Slack webhook if configured,
// otherwise logged.

import { config } from '../config.js';
import { logger } from '../lib/logger.js';

export async function notifySummary(summary) {
  const lines = [
    `History Shorts run: ${summary.seriesSlug}`,
    summary.published?.length ? `published: ${summary.published.join(', ')}` : null,
    summary.review?.length ? `needs review: ${summary.review.join(', ')}` : null,
    summary.failed?.length ? `failed: ${summary.failed.join(', ')}` : null,
    summary.skipped?.length ? `skipped: ${summary.skipped.join(', ')}` : null,
  ].filter(Boolean);
  const text = lines.join('\n');

  if (!config.notify.slackWebhookUrl) {
    logger.info('run summary', { summary });
    return;
  }
  try {
    const res = await fetch(config.notify.slackWebhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) throw new Error(`slack ${res.status}`);
  } catch (err) {
    logger.warn('slack notify failed; logging instead', { error: String(err), summary });
  }
}

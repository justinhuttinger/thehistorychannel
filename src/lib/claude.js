// Claude API wrapper. One place to configure the model + defaults so topic,
// script, fact-check, and caption calls stay consistent. Key comes from Vault.

import Anthropic from '@anthropic-ai/sdk';
import { getSecret } from './vault.js';

const MODEL = 'claude-opus-4-8';

let clientPromise = null;

async function client() {
  if (!clientPromise) {
    clientPromise = getSecret('anthropic_api_key').then(
      (apiKey) => new Anthropic({ apiKey }),
    );
  }
  return clientPromise;
}

// Single-shot text completion. `system` sets the role, `user` is the prompt.
// Adaptive thinking on for the reasoning-heavy calls (script, fact-check).
export async function complete({ system, user, maxTokens = 4000, thinking = true }) {
  const anthropic = await client();
  const req = {
    model: MODEL,
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: user }],
  };
  if (system) req.system = system;
  if (thinking) req.thinking = { type: 'adaptive' };

  const res = await anthropic.messages.create(req);

  if (res.stop_reason === 'refusal') {
    throw new Error('claude refused the request');
  }
  const text = res.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();
  if (!text) throw new Error('claude returned no text content');
  return text;
}

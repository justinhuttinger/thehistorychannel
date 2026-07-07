// Stage 1: topic generation (§4.1). Input: series + used topics. Output: topic + hook.

import { complete } from '../lib/claude.js';
import { parseModelJson, stripEmDashes } from '../lib/text.js';
import { TOPIC_PROMPT } from './prompts.js';

export async function generateTopic({ series, usedTopics }) {
  const text = await complete({
    system: TOPIC_PROMPT.system,
    user: TOPIC_PROMPT.build({ series, usedTopics }),
    maxTokens: 800,
    thinking: false,
  });
  const parsed = parseModelJson(text);
  if (!parsed.topic || !parsed.hook) {
    throw new Error(`topic gen: missing topic/hook in ${JSON.stringify(parsed)}`);
  }
  return {
    topic: stripEmDashes(parsed.topic),
    hook: stripEmDashes(parsed.hook),
  };
}

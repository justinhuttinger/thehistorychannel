// Stage 3: fact-check (§0, §4.3). Mandatory second Claude call that re-reads the
// script and flags likely fabricated dates/names/events. Flagged episodes do
// NOT auto-publish; they land in `review` state.

import { complete } from '../lib/claude.js';
import { parseModelJson, stripEmDashes } from '../lib/text.js';
import { FACTCHECK_PROMPT } from './prompts.js';

export async function factCheck({ topic, scriptJson }) {
  const text = await complete({
    system: FACTCHECK_PROMPT.system,
    user: FACTCHECK_PROMPT.build({ topic, scriptJson }),
    maxTokens: 2000,
    thinking: true,
  });

  const parsed = parseModelJson(text);
  const status = parsed.status === 'clean' ? 'clean' : 'flagged';
  // Fail closed: anything not explicitly 'clean' is treated as flagged.
  return {
    status,
    notes: stripEmDashes(parsed.notes || ''),
  };
}

// Stage 2: script generation (§4.2, §6). Output STRICT JSON: array of beats,
// each { narration, visual_prompt }, sized to target_length_profile.

import { complete } from '../lib/claude.js';
import { parseModelJson, stripEmDashesDeep, containsEmDash } from '../lib/text.js';
import { SCRIPT_PROMPT } from './prompts.js';
import { lengthProfile } from '../config.js';

export async function generateScript({ series, topic, hook, targetLengthProfile }) {
  const profile = lengthProfile(targetLengthProfile);
  const text = await complete({
    system: SCRIPT_PROMPT.system,
    user: SCRIPT_PROMPT.build({ series, topic, hook, profile }),
    maxTokens: 4000,
    thinking: true,
  });

  const parsed = parseModelJson(text);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`script gen: expected non-empty array, got ${typeof parsed}`);
  }

  // Validate + clean every beat. Strip em dashes (guardrail) before storing.
  const beats = parsed.map((beat, i) => {
    if (!beat || typeof beat.narration !== 'string' || typeof beat.visual_prompt !== 'string') {
      throw new Error(`script gen: beat ${i} missing narration/visual_prompt`);
    }
    return beat;
  });

  const clean = stripEmDashesDeep(beats);

  // Assert the guardrail held after cleaning; a leftover dash is a loud bug.
  for (const beat of clean) {
    if (containsEmDash(beat.narration) || containsEmDash(beat.visual_prompt)) {
      throw new Error('script gen: em dash survived stripping (guardrail violation)');
    }
  }
  return clean;
}

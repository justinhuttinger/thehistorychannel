// Per-platform caption generation (§4.5, §0). YouTube title/description and the
// TikTok caption are generated SEPARATELY so the TikTok cut gets its own hook +
// hashtags. Never copy the YouTube title to TikTok (cross-post penalty).

import { complete } from '../lib/claude.js';
import { parseModelJson, stripEmDashes } from '../lib/text.js';
import { YOUTUBE_CAPTION_PROMPT, TIKTOK_CAPTION_PROMPT } from './prompts.js';

export async function generateYouTubeCaption({ topic, hook }) {
  const text = await complete({
    system: YOUTUBE_CAPTION_PROMPT.system,
    user: YOUTUBE_CAPTION_PROMPT.build({ topic, hook }),
    maxTokens: 600,
    thinking: false,
  });
  const parsed = parseModelJson(text);
  const title = stripEmDashes(parsed.title || topic);
  const description = stripEmDashes(parsed.description || '');
  return { title, description, caption: `${title}\n\n${description}`.trim() };
}

export async function generateTikTokCaption({ topic, hook }) {
  const text = await complete({
    system: TIKTOK_CAPTION_PROMPT.system,
    user: TIKTOK_CAPTION_PROMPT.build({ topic, hook }),
    maxTokens: 400,
    thinking: false,
  });
  const parsed = parseModelJson(text);
  return { caption: stripEmDashes(parsed.caption || '') };
}

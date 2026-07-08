// Versioned, editable prompt templates (§6). Kept out of the call sites so they
// can be tuned without touching pipeline logic. Each template carries a version
// string; bump it when you change wording so runs are traceable.
//
// The script prompt is the highest-leverage piece. It MUST enforce: opening
// hook in the first ~3 seconds, clear narrative arc, target word count, strict
// JSON output, per-series tone, no em dashes, and concrete animatable
// visual_prompts (not text-on-screen instructions).

const NO_EM_DASH_RULE =
  'Never use em dashes or en dashes anywhere. Use commas, periods, or separate ' +
  'sentences instead. This is a hard rule.';

export const TOPIC_PROMPT = {
  version: 'topic-v1',
  system:
    'You generate fresh, specific topics for a faceless animated history ' +
    'short-form channel. Topics must be surprising, concrete, and not overdone. ' +
    NO_EM_DASH_RULE,
  build({ series, usedTopics }) {
    return [
      `Series: "${series.name}"`,
      series.sub_niche ? `Sub-niche: ${series.sub_niche}` : '',
      series.tone ? `Tone: ${series.tone}` : '',
      '',
      'Already-used topics (do NOT repeat or closely paraphrase any of these):',
      usedTopics.length ? usedTopics.map((t) => `- ${t}`).join('\n') : '(none yet)',
      '',
      'Return ONLY valid JSON, no prose, no markdown fences, in this exact shape:',
      '{ "topic": "<short specific topic>", "hook": "<one-line opening hook, under 15 words>" }',
      '',
      'The hook is the first thing viewers hear in the first 3 seconds. Make it ' +
        'a pattern-breaking question or claim. ' +
        NO_EM_DASH_RULE,
    ]
      .filter(Boolean)
      .join('\n');
  },
};

export const SCRIPT_PROMPT = {
  version: 'script-v1',
  system:
    'You are a scriptwriter for faceless animated history shorts. You write ' +
    'economical, momentum-driven narration with a clear narrative arc. ' +
    NO_EM_DASH_RULE,
  build({ series, topic, hook, profile }) {
    const beatRange = profile.beats.join(' to ');
    return [
      `Series: "${series.name}"`,
      series.tone ? `Tone: ${series.tone}` : 'Tone: vivid and factual',
      `Topic: ${topic}`,
      `Opening hook (use as/adapt into the first beat): ${hook}`,
      '',
      `Write ${beatRange} beats totaling about ${profile.targetWords} words ` +
        `(roughly ${profile.minSeconds} to ${profile.maxSeconds} seconds at 150 words per minute).`,
      '',
      'Requirements:',
      '- The first beat opens with the hook in the first ~3 seconds.',
      '- Clear narrative arc across beats. Momentum from the first line.',
      '- Keep each beat narration SHORT: one punchy sentence, roughly 12 to 22 ' +
        'words. Never two sentences in one beat.',
      '- Each beat has "narration" (what the voice says) and "visual_prompt" ' +
        '(a concrete scene for an image model).',
      '- visual_prompt is a rich, cinematic single-image description: main ' +
        'subject with era-accurate clothing/objects, specific setting, dramatic ' +
        'action frozen mid-moment, camera framing (vary across beats: extreme ' +
        'wide establishing, medium, close-up detail, low-angle), lighting and ' +
        'atmosphere. 25 to 45 words. Every beat shows a DIFFERENT scene; never ' +
        'reuse a composition.',
      '- visual_prompt is NOT text-on-screen and NOT captions. No words, signs, ' +
        'or lettering to render.',
      '- Facts must be real and verifiable. Do not invent dates, names, or events.',
      '',
      'Return ONLY valid JSON, no prose, no markdown fences: an array of beats',
      '[ { "narration": "...", "visual_prompt": "..." }, ... ]',
      '',
      NO_EM_DASH_RULE,
    ].join('\n');
  },
};

export const FACTCHECK_PROMPT = {
  version: 'factcheck-v2',
  system:
    'You are a history fact-checker for short-form video. Your job is to block ' +
    'FABRICATION, not style. Dramatic compression, vivid phrasing, rounded ' +
    'numbers within commonly cited ranges, and defensible simplifications of ' +
    'causation are all NORMAL for the format and are NOT flagging offenses.',
  build({ topic, scriptJson }) {
    const narration = scriptJson.map((b, i) => `${i + 1}. ${b.narration}`).join('\n');
    return [
      `Topic: ${topic}`,
      '',
      'Script narration to check:',
      narration,
      '',
      'FLAG (status "flagged") only for hard fabrication:',
      '- An invented or wrong date, name, place, or event.',
      '- A number outside the range mainstream sources cite (not just rounded).',
      '- A quote or specific incident that does not appear in the record.',
      '',
      'Do NOT flag for: dramatic tone, simplified causation that a mainstream ' +
      'source would recognize, rounded figures inside the cited range, or ' +
      'claims that are debated but commonly repeated by reputable sources. ' +
      'If everything is defensible, status is "clean" (you may still put ' +
      'observations in notes).',
      '',
      'Return ONLY valid JSON, no prose, no markdown fences:',
      '{ "status": "clean" | "flagged", "notes": "<observations, or list of ' +
        'fabricated claims and why>" }',
    ].join('\n');
  },
};

// TikTok caption is generated SEPARATELY from the YouTube title, with a
// distinct hook + hashtags (§0 per-platform variation). Reused/cross-posted
// copy is penalized on TikTok, so we never copy the YouTube title.
export const YOUTUBE_CAPTION_PROMPT = {
  version: 'yt-caption-v1',
  system:
    'You write high-retention YouTube Shorts titles and descriptions for a ' +
    'history channel. ' +
    NO_EM_DASH_RULE,
  build({ topic, hook }) {
    return [
      `Topic: ${topic}`,
      `Hook: ${hook}`,
      '',
      'Return ONLY valid JSON, no prose, no markdown fences:',
      '{ "title": "<punchy Shorts title, under 80 chars>", ' +
        '"description": "<1-2 line description with 2-4 relevant hashtags>" }',
      '',
      NO_EM_DASH_RULE,
    ].join('\n');
  },
};

export const TIKTOK_CAPTION_PROMPT = {
  version: 'tiktok-caption-v1',
  system:
    'You write native TikTok captions for a history channel. TikTok penalizes ' +
    'reused cross-posted copy, so this caption must be distinct from any YouTube ' +
    'title: its own hook, its own phrasing, TikTok-native hashtags. ' +
    NO_EM_DASH_RULE,
  build({ topic, hook }) {
    return [
      `Topic: ${topic}`,
      `Source hook (do NOT reuse verbatim, write a fresh angle): ${hook}`,
      '',
      'Return ONLY valid JSON, no prose, no markdown fences:',
      '{ "caption": "<native TikTok caption with a fresh hook and 3-5 ' +
        'TikTok-native hashtags, distinct from any YouTube title>" }',
      '',
      NO_EM_DASH_RULE,
    ].join('\n');
  },
};

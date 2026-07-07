// Visuals: each visual_prompt + series style_suffix -> Wan 2.2 via ComfyUI (§4.4).
// Generate; on garbage-frame heuristics, retry once, else accept. Interfaced so
// the ComfyUI/Wan calls can be filled in; 'mock' returns a solid-color frame so
// compose works in dry runs.

import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// A tiny valid 1x1 PNG placeholder frame (mock). Compose scales the real 9:16.
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

// Garbage-frame heuristic hook. For real Wan output this would inspect the
// frame (e.g. near-uniform variance, NSFW/blank detection). Mock never flags.
function looksLikeGarbage(/* buffer */) {
  return false;
}

async function generateOne({ prompt, styleSuffix, endpoint }) {
  if (config.gpu.provider === 'mock') {
    return { image: MOCK_PNG, ext: 'png' };
  }
  // TODO: build the ComfyUI workflow graph with Wan 2.2 nodes, POST to
  // `${endpoint}/prompt`, poll history, download the output frame/clip.
  void prompt;
  void styleSuffix;
  void endpoint;
  throw new Error('ComfyUI/Wan 2.2 generation not yet wired; use GPU_PROVIDER=mock for dry runs');
}

// Generate a visual for one beat. Series style_suffix is appended to lock the
// look. Retry once on garbage frames, then accept.
export async function generateVisual({ visualPrompt, styleSuffix, endpoint }) {
  const prompt = [visualPrompt, styleSuffix].filter(Boolean).join(', ');
  let result = await generateOne({ prompt, styleSuffix, endpoint });
  if (looksLikeGarbage(result.image)) {
    logger.warn('visual looked like garbage, retrying once', { prompt });
    result = await generateOne({ prompt, styleSuffix, endpoint });
  }
  return result;
}

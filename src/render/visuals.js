// Visuals: each visual_prompt + series style_suffix -> Wan 2.2 via ComfyUI (§4.4).
// Generate; on garbage-frame heuristics, retry once, else accept. Interfaced so
// the ComfyUI/Wan calls can be filled in; 'mock' returns a solid-color frame so
// compose works in dry runs.

import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// Solid 176x320 (9:16) PNG placeholder frame (mock). NOT 1x1: ffmpeg's scaler
// grinds pathologically (minutes of CPU, no output) upscaling a 1px image to
// 1080x1920, which hung dry runs wherever ffmpeg was present.
const MOCK_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAALAAAAFACAIAAACTMGGkAAAACXBIWXMAAAABAAAAAQBPJcTWAAACyklEQVR4nO3SMQ0AIBDAQOy8APxbYyOpAhguOQEdumY2XOt5AV8xBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDEEYgjAEYQjCEIQhCEMQhiAMQRiCMARhCMIQhCEIQxCGIAxBGIIwBGEIwhCEIQhDEIYgDs12Cs3/baa5AAAAAElFTkSuQmCC',
  'base64',
);

// Garbage-frame heuristic hook. For real Wan output this would inspect the
// frame (e.g. near-uniform variance, NSFW/blank detection). Mock never flags.
function looksLikeGarbage(/* buffer */) {
  return false;
}

// Wan 2.2 5B via ComfyUI, driven as text-to-image (length=1 latent frame):
// compose() muxes one still per beat with the narration audio, so a single
// high-quality frame is what the pipeline needs. Portrait 704x1280 upscales
// cleanly to the 1080x1920 master.
const WAN_UNET = 'wan2.2_ti2v_5B_fp16.safetensors';
const WAN_CLIP = 'umt5_xxl_fp8_e4m3fn_scaled.safetensors';
const WAN_VAE = 'wan2.2_vae.safetensors';
const WAN_NEGATIVE =
  'blurry, low quality, distorted, deformed, text, watermark, logo, signature, extra limbs';
const GEN_TIMEOUT_MS = 8 * 60 * 1000; // first call also pays model load from the volume
const POLL_MS = 3000;

function wanWorkflow({ prompt, seed }) {
  return {
    unet: { class_type: 'UNETLoader', inputs: { unet_name: WAN_UNET, weight_dtype: 'default' } },
    clip: { class_type: 'CLIPLoader', inputs: { clip_name: WAN_CLIP, type: 'wan', device: 'default' } },
    vae: { class_type: 'VAELoader', inputs: { vae_name: WAN_VAE } },
    pos: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: prompt } },
    neg: { class_type: 'CLIPTextEncode', inputs: { clip: ['clip', 0], text: WAN_NEGATIVE } },
    latent: {
      class_type: 'Wan22ImageToVideoLatent',
      inputs: { vae: ['vae', 0], width: 704, height: 1280, length: 1, batch_size: 1 },
    },
    sampler: {
      class_type: 'KSampler',
      inputs: {
        model: ['unet', 0],
        positive: ['pos', 0],
        negative: ['neg', 0],
        latent_image: ['latent', 0],
        seed,
        steps: 30,
        cfg: 5,
        sampler_name: 'uni_pc',
        scheduler: 'simple',
        denoise: 1,
      },
    },
    decode: { class_type: 'VAEDecode', inputs: { samples: ['sampler', 0], vae: ['vae', 0] } },
    save: { class_type: 'SaveImage', inputs: { images: ['decode', 0], filename_prefix: 'hs_beat' } },
  };
}

async function comfy(endpoint, path, options = {}) {
  const res = await fetch(`${endpoint}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`comfyui ${path} ${res.status}: ${body.slice(0, 300)}`);
  }
  return res;
}

async function generateOne({ prompt, styleSuffix, endpoint }) {
  if (config.gpu.provider === 'mock') {
    return { image: MOCK_PNG, ext: 'png' };
  }
  void styleSuffix; // already folded into prompt by generateVisual

  const seed = Math.floor(Math.random() * 2 ** 32);
  const submit = await comfy(endpoint, '/prompt', {
    method: 'POST',
    body: JSON.stringify({ prompt: wanWorkflow({ prompt, seed }), client_id: 'history-shorts' }),
  });
  const { prompt_id: promptId } = await submit.json();
  if (!promptId) throw new Error('comfyui /prompt returned no prompt_id');

  const deadline = Date.now() + GEN_TIMEOUT_MS;
  for (;;) {
    await new Promise((r) => setTimeout(r, POLL_MS));
    if (Date.now() > deadline) throw new Error(`comfyui generation timed out (${GEN_TIMEOUT_MS / 60000}m)`);
    const hist = await (await comfy(endpoint, `/history/${promptId}`)).json();
    const entry = hist[promptId];
    if (!entry) continue;
    if (entry.status && entry.status.completed === false && entry.status.status_str === 'error') {
      throw new Error(`comfyui workflow error: ${JSON.stringify(entry.status.messages || []).slice(0, 300)}`);
    }
    const imgs = entry.outputs?.save?.images;
    if (imgs && imgs.length) {
      const { filename, subfolder, type } = imgs[0];
      const q = new URLSearchParams({ filename, subfolder: subfolder || '', type: type || 'output' });
      const view = await fetch(`${endpoint}/view?${q}`, { signal: AbortSignal.timeout(60_000) });
      if (!view.ok) throw new Error(`comfyui /view ${view.status}`);
      const image = Buffer.from(await view.arrayBuffer());
      logger.info('wan frame generated', { promptId, bytes: image.length });
      return { image, ext: filename.endsWith('.webp') ? 'webp' : 'png' };
    }
  }
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

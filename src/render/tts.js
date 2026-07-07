// TTS interface (§1). Self-hosted XTTS/Coqui default, but interfaced so a paid
// provider can be swapped without touching callers. 'mock' synthesizes silent
// audio of an estimated duration so compose + timing logic works in dry runs.

import { config } from '../config.js';
import { logger } from '../lib/logger.js';

// ~150 words per minute => seconds for a narration line.
function estimateSeconds(text) {
  const words = String(text).trim().split(/\s+/).filter(Boolean).length;
  return Math.max(1.5, (words / 150) * 60);
}

// Minimal valid WAV (44.1kHz mono 16-bit) of N seconds of silence. Enough for
// FFmpeg to read a real duration in dry runs without a TTS engine.
function silentWav(seconds) {
  const sampleRate = 44100;
  const numSamples = Math.round(sampleRate * seconds);
  const dataSize = numSamples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20); // PCM
  buf.writeUInt16LE(1, 22); // mono
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  return buf;
}

const mockTts = {
  async synthesize({ text }) {
    const seconds = estimateSeconds(text);
    return { audio: silentWav(seconds), durationSeconds: seconds, ext: 'wav' };
  },
};

function xttsTts() {
  return {
    async synthesize(/* { text, voiceId, endpoint } */) {
      // TODO: POST text + voiceId to the XTTS server running on the GPU box,
      // return the returned wav buffer and measured duration.
      throw new Error('xtts provider not yet wired; set TTS_PROVIDER=mock for dry runs');
    },
  };
}

export function ttsProvider() {
  switch (config.tts.provider) {
    case 'mock':
      return mockTts;
    case 'xtts':
      return xttsTts();
    default:
      // Any other slug is treated as a paid provider behind the same interface.
      logger.warn('unknown TTS_PROVIDER, using mock', { provider: config.tts.provider });
      return mockTts;
  }
}

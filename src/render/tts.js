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

// Series voice_id slugs -> XTTS v2 built-in studio speakers. Unknown slugs are
// passed through verbatim so a real XTTS speaker name in hs_series works too.
const XTTS_SPEAKERS = {
  narrator_male_low: 'Damien Black',
  narrator_male: 'Viktor Eka',
  narrator_female: 'Claribel Dervla',
};
const XTTS_DEFAULT_SPEAKER = 'Damien Black';
const XTTS_LANGUAGE = 'en';

// Duration from the WAV header: find the data chunk, divide by byte rate.
function wavDurationSeconds(buf) {
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('xtts returned a non-WAV response');
  }
  const sampleRate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  const bitsPerSample = buf.readUInt16LE(34);
  const dataIdx = buf.indexOf('data');
  if (dataIdx < 0) throw new Error('xtts WAV missing data chunk');
  const dataSize = buf.readUInt32LE(dataIdx + 4);
  return dataSize / (sampleRate * channels * (bitsPerSample / 8));
}

function xttsTts() {
  return {
    async synthesize({ text, voiceId, endpoint }) {
      if (!endpoint) throw new Error('xtts synthesize: no endpoint (GPU pod TTS URL) provided');
      const speaker = XTTS_SPEAKERS[voiceId] || voiceId || XTTS_DEFAULT_SPEAKER;
      const params = new URLSearchParams({
        text: String(text),
        speaker_id: speaker,
        language_id: XTTS_LANGUAGE,
      });
      const res = await fetch(`${endpoint}/api/tts?${params}`, {
        signal: AbortSignal.timeout(3 * 60 * 1000),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`xtts /api/tts ${res.status}: ${body.slice(0, 200)}`);
      }
      const audio = Buffer.from(await res.arrayBuffer());
      const durationSeconds = wavDurationSeconds(audio);
      logger.info('xtts synthesized', { chars: String(text).length, durationSeconds, speaker });
      return { audio, durationSeconds, ext: 'wav' };
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

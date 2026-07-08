// Compose: stitch beats (visual + audio) with burned-in captions into a master
// 9:16 1080x1920 H.264 MP4 (§2, §4.4). Uses FFmpeg when available. When FFmpeg
// is absent (dry run / CI), writes a placeholder file so the state machine and
// storage flow are provable end to end.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFfmpeg } from './ffmpeg.js';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';

const WIDTH = 1080;
const HEIGHT = 1920;

// Word-wrap caption text; drawtext does not wrap long lines on its own.
function wrapCaption(text, width = 34) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    if (line && line.length + 1 + w.length > width) {
      lines.push(line);
      line = w;
    } else {
      line = line ? `${line} ${w}` : w;
    }
  }
  if (line) lines.push(line);
  return lines.join('\n');
}

// Split narration into short karaoke-style caption chunks (3-6 words), timed
// proportionally across the beat. Chunks break early at punctuation so phrases
// stay natural.
function chunkCaption(text, minWords = 3, maxWords = 5) {
  const words = String(text).replace(/\s+/g, ' ').trim().split(' ');
  const chunks = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    const punct = /[.,;:!?]$/.test(w);
    if (cur.length >= maxWords || (punct && cur.length >= minWords)) {
      chunks.push(cur.join(' '));
      cur = [];
    }
  }
  if (cur.length) {
    // Avoid a dangling 1-2 word tail; merge into the previous chunk.
    if (chunks.length && cur.length < minWords) {
      chunks[chunks.length - 1] += ` ${cur.join(' ')}`;
    } else {
      chunks.push(cur.join(' '));
    }
  }
  return chunks;
}

// Escape a path for use inside a filtergraph argument (Windows drive colons
// and backslashes both break filter parsing).
function escFilterPath(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// Explicit caption font. Without fontfile=, drawtext initializes fontconfig,
// which scans every font on the host before the first frame — observed to
// grind for minutes on Windows. Fall back to fontconfig only if none found.
const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
  '/System/Library/Fonts/Helvetica.ttc',
];
function captionFont() {
  return FONT_CANDIDATES.find((p) => existsSync(p)) || null;
}

// beats: [{ narrationText, audio: Buffer, ext, durationSeconds, image: Buffer, imageExt }]
// Returns { video: Buffer, ext: 'mp4', durationSeconds }.
export async function compose({ beats, burnCaptions = true }) {
  const speedFactor = Math.min(2, Math.max(0.5, config.tts.voiceSpeed || 1));
  const totalDuration = beats.reduce((s, b) => s + b.durationSeconds, 0) / speedFactor;

  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) {
    logger.warn('ffmpeg not found; writing placeholder master (dry-run mode)');
    // Minimal placeholder so downstream storage/publish flow can run.
    const placeholder = Buffer.from(
      `HS-PLACEHOLDER-MASTER\nbeats=${beats.length}\nduration=${totalDuration.toFixed(2)}s\n`,
    );
    return { video: placeholder, ext: 'mp4', durationSeconds: totalDuration };
  }

  const dir = mkdtempSync(join(tmpdir(), 'hs-compose-'));
  try {
    // Build one clip per beat: still image scaled/padded to 9:16, muxed with the
    // beat audio, optionally with burned-in caption text, for the audio length.
    const clipPaths = [];
    beats.forEach((beat, i) => {
      const imgPath = join(dir, `img-${i}.${beat.imageExt || 'png'}`);
      const audPath = join(dir, `aud-${i}.${beat.ext || 'wav'}`);
      const clipPath = join(dir, `clip-${i}.mp4`);
      writeFileSync(imgPath, beat.image);
      writeFileSync(audPath, beat.audio);

      // Narration speed-up (pitch-preserving). Clip duration shrinks to match.
      const speed = Math.min(2, Math.max(0.5, config.tts.voiceSpeed || 1));
      const effDuration = beat.durationSeconds / speed;

      const scalePad =
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${WIDTH}:${HEIGHT}`;

      // Karaoke captions: 3-6 word chunks shown one at a time, timed
      // proportionally by word count across the (sped-up) beat. Each chunk is
      // its own drawtext with an enable window; text goes via textfile= (never
      // inline text=, which cannot be safely escaped).
      let caption = '';
      if (burnCaptions && beat.narrationText) {
        const font = captionFont();
        const chunks = chunkCaption(beat.narrationText);
        const totalWords = chunks.reduce((s, c) => s + c.split(' ').length, 0);
        let cursor = 0;
        const filters = chunks.map((chunk, j) => {
          const capPath = join(dir, `cap-${i}-${j}.txt`);
          writeFileSync(capPath, wrapCaption(chunk, 18));
          const start = (cursor / totalWords) * effDuration;
          cursor += chunk.split(' ').length;
          const end = j === chunks.length - 1 ? effDuration : (cursor / totalWords) * effDuration;
          return (
            `drawtext=textfile='${escFilterPath(capPath)}':expansion=none:` +
            (font ? `fontfile='${escFilterPath(font)}':` : '') +
            `fontcolor=white:fontsize=72:borderw=4:bordercolor=black:` +
            `box=1:boxcolor=black@0.35:boxborderw=18:` +
            `x=(w-text_w)/2:y=(h-th)*0.70:line_spacing=10:` +
            `enable='between(t,${start.toFixed(3)},${end.toFixed(3)})'`
          );
        });
        caption = `,${filters.join(',')}`;
      }

      // Still beats loop a frozen frame; video beats loop the Wan motion clip
      // under the narration until the beat ends.
      const visualInput = beat.isVideo
        ? ['-stream_loop', '-1', '-i', imgPath]
        : ['-loop', '1', '-i', imgPath];
      const args = [
        '-y', '-nostdin',
        ...visualInput,
        '-i', audPath,
        '-vf', `${scalePad}${caption}`,
        ...(speed !== 1 ? ['-filter:a', `atempo=${speed}`] : []),
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-shortest',
        '-t', String(effDuration),
        clipPath,
      ];
      const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      if (r.status !== 0) {
        throw new Error(`ffmpeg clip ${i} failed: ${String(r.stderr || '').slice(-400)}`);
      }
      clipPaths.push(clipPath);
    });

    // Concat the clips into the master.
    const listPath = join(dir, 'concat.txt');
    writeFileSync(listPath, clipPaths.map((p) => `file '${p}'`).join('\n'));
    const outPath = join(dir, 'master.mp4');
    const concat = spawnSync(
      ffmpeg,
      ['-y', '-nostdin', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' },
    );
    if (concat.status !== 0 || !existsSync(outPath)) {
      throw new Error(`ffmpeg concat failed: ${String(concat.stderr || '').slice(-400)}`);
    }

    const video = readFileSync(outPath);
    return { video, ext: 'mp4', durationSeconds: totalDuration };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

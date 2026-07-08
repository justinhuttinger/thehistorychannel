// Compose: stitch beats (visual + audio) with burned-in captions into a master
// 9:16 1080x1920 H.264 MP4 (§2, §4.4). Uses FFmpeg when available. When FFmpeg
// is absent (dry run / CI), writes a placeholder file so the state machine and
// storage flow are provable end to end.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { logger } from '../lib/logger.js';

const WIDTH = 1080;
const HEIGHT = 1920;

// Prefer the bundled static binary (works on Windows dev boxes and Render's
// native Node runtime, neither of which ships ffmpeg); fall back to PATH.
function ffmpegBin() {
  if (ffmpegStatic && existsSync(ffmpegStatic)) return ffmpegStatic;
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return r.status === 0 ? 'ffmpeg' : null;
}

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
  const totalDuration = beats.reduce((s, b) => s + b.durationSeconds, 0);

  const ffmpeg = ffmpegBin();
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

      const scalePad =
        `scale=${WIDTH}:${HEIGHT}:force_original_aspect_ratio=increase,` +
        `crop=${WIDTH}:${HEIGHT}`;
      // Caption via textfile= (never inline text=): narration contains
      // apostrophes/commas that cannot be reliably escaped in a filtergraph.
      let caption = '';
      if (burnCaptions && beat.narrationText) {
        const capPath = join(dir, `cap-${i}.txt`);
        writeFileSync(capPath, wrapCaption(beat.narrationText));
        const font = captionFont();
        caption =
          `,drawtext=textfile='${escFilterPath(capPath)}':expansion=none:` +
          (font ? `fontfile='${escFilterPath(font)}':` : '') +
          `fontcolor=white:fontsize=40:box=1:boxcolor=black@0.5:boxborderw=12:` +
          `x=(w-text_w)/2:y=h-200-th:line_spacing=8`;
      }

      const args = [
        '-y', '-nostdin',
        '-loop', '1', '-i', imgPath,
        '-i', audPath,
        '-vf', `${scalePad}${caption}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-shortest',
        '-t', String(beat.durationSeconds),
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

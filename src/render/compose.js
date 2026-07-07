// Compose: stitch beats (visual + audio) with burned-in captions into a master
// 9:16 1080x1920 H.264 MP4 (§2, §4.4). Uses FFmpeg when available. When FFmpeg
// is absent (dry run / CI), writes a placeholder file so the state machine and
// storage flow are provable end to end.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../lib/logger.js';

const WIDTH = 1080;
const HEIGHT = 1920;

function hasFfmpeg() {
  const r = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
  return r.status === 0;
}

// Escape text for FFmpeg drawtext.
function escDrawtext(text) {
  return String(text)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\n/g, ' ');
}

// beats: [{ narrationText, audio: Buffer, ext, durationSeconds, image: Buffer, imageExt }]
// Returns { video: Buffer, ext: 'mp4', durationSeconds }.
export async function compose({ beats, burnCaptions = true }) {
  const totalDuration = beats.reduce((s, b) => s + b.durationSeconds, 0);

  if (!hasFfmpeg()) {
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
      const caption = burnCaptions && beat.narrationText
        ? `,drawtext=text='${escDrawtext(beat.narrationText)}':fontcolor=white:` +
          `fontsize=48:box=1:boxcolor=black@0.5:boxborderw=12:` +
          `x=(w-text_w)/2:y=h-360:line_spacing=8`
        : '';

      const args = [
        '-y',
        '-loop', '1', '-i', imgPath,
        '-i', audPath,
        '-vf', `${scalePad}${caption}`,
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac',
        '-shortest',
        '-t', String(beat.durationSeconds),
        clipPath,
      ];
      const r = spawnSync('ffmpeg', args, { stdio: 'inherit' });
      if (r.status !== 0) throw new Error(`ffmpeg clip ${i} failed`);
      clipPaths.push(clipPath);
    });

    // Concat the clips into the master.
    const listPath = join(dir, 'concat.txt');
    writeFileSync(listPath, clipPaths.map((p) => `file '${p}'`).join('\n'));
    const outPath = join(dir, 'master.mp4');
    const concat = spawnSync(
      'ffmpeg',
      ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath],
      { stdio: 'inherit' },
    );
    if (concat.status !== 0 || !existsSync(outPath)) throw new Error('ffmpeg concat failed');

    const video = readFileSync(outPath);
    return { video, ext: 'mp4', durationSeconds: totalDuration };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

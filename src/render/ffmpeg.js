// FFmpeg resolution with CAPABILITY detection. ffmpeg-static's Linux build is
// compiled without the drawtext filter (Windows build has it), which broke
// caption burning the first time compose ran on Render. Resolution order:
//   1. ffmpeg-static binary, IF it supports drawtext
//   2. system ffmpeg on PATH, IF it supports drawtext
//   3. (linux x64 only) download johnvansickle's full static build once per
//      boot into the OS tmpdir and use that.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ffmpegStatic from 'ffmpeg-static';
import { logger } from '../lib/logger.js';

const FULL_BUILD_URL = 'https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz';
let resolved = null;

function hasDrawtext(bin) {
  try {
    const r = spawnSync(bin, ['-hide_banner', '-filters'], { encoding: 'utf8', timeout: 20_000 });
    return r.status === 0 && String(r.stdout).includes(' drawtext ');
  } catch {
    return false;
  }
}

async function downloadFullBuild() {
  const dir = join(tmpdir(), 'hs-ffmpeg-full');
  const existing = existsSync(dir)
    ? readdirSync(dir).find((d) => d.startsWith('ffmpeg-') && existsSync(join(dir, d, 'ffmpeg')))
    : null;
  if (existing) return join(dir, existing, 'ffmpeg');

  logger.warn('bundled ffmpeg lacks drawtext; downloading full static build (one-time per boot)');
  mkdirSync(dir, { recursive: true });
  const res = await fetch(FULL_BUILD_URL, { signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`ffmpeg full build download: ${res.status}`);
  const tarPath = join(dir, 'ffmpeg.tar.xz');
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFileSync } = await import('node:fs');
  writeFileSync(tarPath, buf);
  const tar = spawnSync('tar', ['-xJf', tarPath, '-C', dir], { encoding: 'utf8', timeout: 120_000 });
  if (tar.status !== 0) throw new Error(`ffmpeg extract failed: ${String(tar.stderr).slice(-200)}`);
  const sub = readdirSync(dir).find((d) => d.startsWith('ffmpeg-') && existsSync(join(dir, d, 'ffmpeg')));
  if (!sub) throw new Error('ffmpeg extract: binary not found');
  const bin = join(dir, sub, 'ffmpeg');
  logger.info('full ffmpeg build ready', { bin });
  return bin;
}

// Resolve (and cache) an ffmpeg binary that supports drawtext. Returns null
// only when nothing is available at all (dry-run placeholder mode).
export async function resolveFfmpeg() {
  if (resolved !== null) return resolved || null;
  if (ffmpegStatic && existsSync(ffmpegStatic) && hasDrawtext(ffmpegStatic)) {
    resolved = ffmpegStatic;
    return resolved;
  }
  if (hasDrawtext('ffmpeg')) {
    resolved = 'ffmpeg';
    return resolved;
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    try {
      const bin = await downloadFullBuild();
      if (hasDrawtext(bin)) {
        resolved = bin;
        return resolved;
      }
    } catch (err) {
      logger.error('full ffmpeg provisioning failed', { error: String(err) });
    }
  }
  // Last resort: a binary without drawtext beats none (captions will fail,
  // but bare encodes still work); prefer signalling absence for placeholder.
  resolved = ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : '';
  return resolved || null;
}

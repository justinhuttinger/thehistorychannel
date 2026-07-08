// Real map rendering for location beats (§visuals). AI models hallucinate
// geography, so map beats NEVER go through the image model: we geocode via
// Nominatim, stitch real OpenStreetMap raster tiles into a 704x1280 portrait
// frame with ffmpeg, and drop a red marker + place label.
//
// OSM usage policy: identify with a UA, fetch tiles sequentially, low volume
// (one map per episode). https://operations.osmfoundation.org/policies/tiles/

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveFfmpeg } from './ffmpeg.js';
import { logger } from '../lib/logger.js';

const UA = 'history-shorts-pipeline/1.0 (github.com/justinhuttinger/thehistorychannel)';
const COLS = 3;
const ROWS = 5;
const TILE = 256;

const FONT_CANDIDATES = [
  'C:/Windows/Fonts/arialbd.ttf',
  'C:/Windows/Fonts/arial.ttf',
  '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf',
];
const font = () => FONT_CANDIDATES.find((p) => existsSync(p)) || null;
const escFilterPath = (p) => p.replace(/\\/g, '/').replace(/:/g, '\\:');


async function geocodeOnce(query) {
  const q = new URLSearchParams({ q: query, format: 'json', limit: '1' });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${q}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) throw new Error(`nominatim ${res.status}`);
  const results = await res.json();
  return Array.isArray(results) && results.length
    ? { lat: Number(results[0].lat), lon: Number(results[0].lon) }
    : null;
}

// Scripts produce fuzzy places ("Meuse Valley, Belgium" is a region, not a
// gazetteer entry). Try progressively simpler queries: full phrase, phrase
// without leading descriptors (Valley/Region/etc dropped), each comma part
// from most to least specific, so at worst the country still maps.
export async function geocode(place) {
  const parts = String(place).split(',').map((s) => s.trim()).filter(Boolean);
  const candidates = [place];
  if (parts.length > 1) {
    const head = parts[0].replace(/\b(valley|region|area|district|province)\b/gi, '').trim();
    if (head && head !== parts[0]) candidates.push([head, ...parts.slice(1)].join(', '));
    for (let i = 1; i < parts.length; i++) candidates.push(parts.slice(i).join(', '));
  }
  for (const c of candidates) {
    const hit = await geocodeOnce(c);
    if (hit) {
      if (c !== place) logger.info('geocode fallback used', { place, matched: c });
      return hit;
    }
  }
  throw new Error(`geocode: no result for "${place}" or any fallback`);
}

function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { x, y };
}

// Renders a 704x1280 PNG map centered near the place, red marker + label.
// Returns { image: Buffer, ext: 'png' }. Throws on failure; the caller decides
// whether to fall back to a generated visual.
export async function renderMap(place, { zoom = 6 } = {}) {
  const ffmpeg = await resolveFfmpeg();
  if (!ffmpeg) throw new Error('renderMap: ffmpeg unavailable');
  const { lat, lon } = await geocode(place);
  const { x, y } = lonLatToTile(lon, lat, zoom);
  const x0 = Math.floor(x) - Math.floor(COLS / 2);
  const y0 = Math.floor(y) - Math.floor(ROWS / 2);

  const dir = mkdtempSync(join(tmpdir(), 'hs-map-'));
  try {
    const tilePaths = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const n = 2 ** zoom;
        const tx = ((x0 + c) % n + n) % n; // wrap longitude
        const ty = Math.min(Math.max(y0 + r, 0), n - 1);
        const res = await fetch(`https://tile.openstreetmap.org/${zoom}/${tx}/${ty}.png`, {
          headers: { 'User-Agent': UA },
          signal: AbortSignal.timeout(20_000),
        });
        if (!res.ok) throw new Error(`osm tile ${zoom}/${tx}/${ty}: ${res.status}`);
        const p = join(dir, `t${r}-${c}.png`);
        writeFileSync(p, Buffer.from(await res.arrayBuffer()));
        tilePaths.push(p);
      }
    }

    // Marker position inside the stitched (768x1280) mosaic, then adjust for
    // the 32px crop on each side to reach 704 wide.
    const mx = Math.round((x - x0) * TILE) - 32;
    const my = Math.round((y - y0) * TILE);

    const labelPath = join(dir, 'label.txt');
    writeFileSync(labelPath, String(place).split(',')[0].trim());

    const inputs = tilePaths.flatMap((p) => ['-i', p]);
    const rowFilters = [];
    for (let r = 0; r < ROWS; r++) {
      const ins = Array.from({ length: COLS }, (_, c) => `[${r * COLS + c}:v]`).join('');
      rowFilters.push(`${ins}hstack=${COLS}[row${r}]`);
    }
    const vstack = `${Array.from({ length: ROWS }, (_, r) => `[row${r}]`).join('')}vstack=${ROWS}[mosaic]`;
    const f = font();
    const marker =
      `[mosaic]crop=704:1280:32:0,` +
      // red dot marker (two drawtexts: white halo + red dot) at the place
      (f
        ? `drawtext=text='O':fontfile='${escFilterPath(f)}':fontcolor=white:fontsize=64:x=${mx - 21}:y=${my - 34},` +
          `drawtext=text='o':fontfile='${escFilterPath(f)}':fontcolor=red:fontsize=44:x=${mx - 14}:y=${my - 24},` +
          `drawtext=textfile='${escFilterPath(labelPath)}':expansion=none:fontfile='${escFilterPath(f)}':` +
          `fontcolor=white:fontsize=52:box=1:boxcolor=black@0.65:boxborderw=14:` +
          `x=(w-text_w)/2:y=h-180`
        : 'null') +
      '[out]';

    const outPath = join(dir, 'map.png');
    const args = [
      '-y', '-nostdin',
      ...inputs,
      '-filter_complex', [...rowFilters, vstack, marker].join(';'),
      '-map', '[out]',
      '-frames:v', '1',
      outPath,
    ];
    const r = spawnSync(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    if (r.status !== 0 || !existsSync(outPath)) {
      throw new Error(`map stitch failed: ${String(r.stderr || '').slice(-300)}`);
    }
    logger.info('map rendered', { place, zoom, marker: [mx, my] });
    return { image: readFileSync(outPath), ext: 'png' };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

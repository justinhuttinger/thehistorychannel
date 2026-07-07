// Text guardrails (§0, §6). These are hard rules, applied to every piece of
// generated copy before it is stored or published.

// Hard rule: NO em dashes in any generated copy (titles, captions, scripts).
// We also normalize the en dash and the "spaced hyphen used as an em dash"
// pattern, since models reach for those as substitutes.
export function stripEmDashes(input) {
  if (input == null) return input;
  let out = String(input);
  // em dash (U+2014) and horizontal bar (U+2015) -> comma+space
  out = out.replace(/\s*[—―]\s*/g, ', ');
  // en dash (U+2013) between words -> comma+space; between digits (ranges) -> hyphen
  out = out.replace(/(\d)\s*–\s*(\d)/g, '$1-$2');
  out = out.replace(/\s*–\s*/g, ', ');
  // " - " used as a sentence dash -> comma+space (leave hyphenated-words alone)
  out = out.replace(/ +- +/g, ', ');
  // collapse any doubled spaces / spaces before punctuation introduced above
  out = out.replace(/ {2,}/g, ' ').replace(/ +([,.;:!?])/g, '$1');
  return out.trim();
}

// True if the string still contains a forbidden em/en dash. Used as an assertion
// gate so a guardrail regression is loud, not silent.
export function containsEmDash(input) {
  return /[—―–]/.test(String(input ?? ''));
}

// Recursively strip em dashes from every string in an object/array. Used on
// script_json beats so narration + visual prompts are clean.
export function stripEmDashesDeep(value) {
  if (typeof value === 'string') return stripEmDashes(value);
  if (Array.isArray(value)) return value.map(stripEmDashesDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = stripEmDashesDeep(v);
    return out;
  }
  return value;
}

// URL/path-safe slug for TikTok package folders and storage keys.
export function slugify(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'episode';
}

// Defensive JSON extraction for model output (§6). Models occasionally wrap
// JSON in ```json fences or add a stray sentence; strip fences, then find the
// outermost array/object and parse it. Throws with context on failure so the
// pipeline lands the episode in a recoverable state instead of crashing.
export function parseModelJson(raw) {
  if (raw == null) throw new Error('parseModelJson: empty model output');
  let text = String(raw).trim();

  // Strip markdown code fences (```json ... ``` or ``` ... ```).
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  // Try a direct parse first.
  try {
    return JSON.parse(text);
  } catch {
    // fall through to bracket extraction
  }

  // Extract the outermost JSON array or object.
  const start = text.search(/[[{]/);
  if (start === -1) {
    throw new Error(`parseModelJson: no JSON structure found in: ${text.slice(0, 200)}`);
  }
  const open = text[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === '\\') {
      escape = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) {
        const candidate = text.slice(start, i + 1);
        return JSON.parse(candidate);
      }
    }
  }
  throw new Error(`parseModelJson: unbalanced JSON in: ${text.slice(0, 200)}`);
}

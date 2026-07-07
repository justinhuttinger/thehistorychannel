// Offline guardrail tests (§0, §6). No network / no Supabase / no Anthropic.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  stripEmDashes,
  containsEmDash,
  stripEmDashesDeep,
  parseModelJson,
  slugify,
} from '../src/lib/text.js';

test('stripEmDashes removes em and en dashes', () => {
  assert.equal(stripEmDashes('Rome fell — and fast'), 'Rome fell, and fast');
  assert.equal(stripEmDashes('a – b'), 'a, b');
  assert.equal(stripEmDashes('the year 1914 – 1918'), 'the year 1914-1918');
  assert.equal(containsEmDash(stripEmDashes('x — y – z')), false);
});

test('stripEmDashes handles spaced hyphen used as a dash', () => {
  assert.equal(stripEmDashes('one - two - three'), 'one, two, three');
  // hyphenated compound words are preserved
  assert.equal(stripEmDashes('well-known fact'), 'well-known fact');
});

test('stripEmDashesDeep cleans nested beat objects', () => {
  const beats = [
    { narration: 'A — B', visual_prompt: 'c – d' },
    { narration: 'clean', visual_prompt: 'clean too' },
  ];
  const out = stripEmDashesDeep(beats);
  for (const b of out) {
    assert.equal(containsEmDash(b.narration), false);
    assert.equal(containsEmDash(b.visual_prompt), false);
  }
});

test('parseModelJson strips code fences', () => {
  const raw = '```json\n{"topic":"x","hook":"y"}\n```';
  assert.deepEqual(parseModelJson(raw), { topic: 'x', hook: 'y' });
});

test('parseModelJson extracts array amid stray prose', () => {
  const raw = 'Here is the script:\n[{"narration":"a","visual_prompt":"b"}]\nThanks!';
  assert.deepEqual(parseModelJson(raw), [{ narration: 'a', visual_prompt: 'b' }]);
});

test('parseModelJson handles strings containing brackets', () => {
  const raw = '{"caption":"war [1914] began"}';
  assert.deepEqual(parseModelJson(raw), { caption: 'war [1914] began' });
});

test('parseModelJson throws on garbage', () => {
  assert.throws(() => parseModelJson('no json here'));
});

test('slugify produces safe folder names', () => {
  assert.equal(slugify('The Fall of Rome!'), 'the-fall-of-rome');
  assert.equal(slugify(''), 'episode');
});

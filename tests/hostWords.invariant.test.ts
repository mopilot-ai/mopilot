// No harness name in the shared words of the Remote Run clients: attention, card and machine states say "the agent" or the agent's own label.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const FILES = ['shared/host/attentionLine.mjs', 'shared/host/cardLine.mjs'];
const HARNESS = /\b(claude|codex|acp|gemini|openai|anthropic)\b/i;

test('the attention and card words name no harness', () => {
  for (const f of FILES) {
    const strings = [...readFileSync(f, 'utf8').matchAll(/(['"`])((?:\\.|(?!\1).)*)\1/g)].map((x) => x[2]);
    for (const s of strings) assert.doesNotMatch(s, HARNESS, `${f}: ${s}`);
  }
});

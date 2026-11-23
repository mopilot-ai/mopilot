// Voice capability bindings and entry routing never move speech to another harness's chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const { claudeBindings, acpBindings } = createRequire(import.meta.url)('../electron/harness/bindings.cjs');

test('a harness without realtime voice reports its own limitation rather than routing to Codex', () => {
  for (const bindings of [claudeBindings(), acpBindings(null)]) {
    assert.equal(bindings.voiceChat.via, 'none');
    assert.equal(bindings.dictation.via, 'polyfill');
  }
});

test('raw audio is an explicit negotiated operation, never inferred from image support', () => {
  assert.equal(acpBindings({ image: true }).audioInput.via, 'none');
  assert.equal(acpBindings({ audio: true }).audioInput.method, 'session/prompt');
});

test('the shared voice entry cannot create another harness chat or send a task to obtain a transcript', () => {
  const source = fs.readFileSync(new URL('../src/session/voice.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /newCodexChat|newChatCodex|CONFIRM_VOICE|Context from my/);
  assert.doesNotMatch(source, /['"]turn\/start['"]|['"]session\/prompt['"]/);
});

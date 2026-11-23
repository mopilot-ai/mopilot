// A usage-limit note offers the switch to the other harness only where it can run (#1523).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { limitNoteText } from '../src/harness/limitNote.ts';

test('the limit note promises a switch only where it can run, else names what can be done', () => {
  assert.equal(
    limitNoteText('Codex', 'Claude Code', true),
    'Codex limit reached. You can switch to Claude Code and continue in this chat.',
  );
  assert.equal(
    limitNoteText('Codex', 'Claude Code', false),
    'Codex limit reached. Set up Claude Code in Settings to continue in this chat, or try again when the limit resets.',
  );
});

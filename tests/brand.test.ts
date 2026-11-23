// Per-harness resume commands and export labels (#61, #69).
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { cliSessionId } = await import('../src/harness/types.ts');
const { noteOwner } = await import('../src/harness/ownership.ts');
noteOwner('claude:abc-123', 'claude');
noteOwner('claude:s1', 'claude');
const { resumeCommandFor } = await import('../src/harness/registry.ts');
const { labelAt, transcriptMarkdown } = await import('../src/session/transcript.ts');

test('the resume command uses the harness CLI', () => {
  assert.equal(resumeCommandFor('claude:abc-123'), 'claude --resume abc-123');
  assert.equal(resumeCommandFor('019a-thread'), 'codex resume 019a-thread');
  assert.equal(cliSessionId('claude:abc-123'), 'abc-123');
  assert.equal(cliSessionId('019a-thread'), '019a-thread');
  assert.equal(cliSessionId('acp:kimi:s-1'), 's-1');
  // a basic harness has no verified resume command: the menu item is hidden, never a Codex command
  assert.equal(resumeCommandFor('acp:kimi:s-1'), null);
});

const turn = (id: string, user: string, reply: string, extra: any[] = []) =>
  ({
    id,
    status: 'completed',
    items: [
      ...extra,
      { type: 'userMessage', content: [{ type: 'text', text: user }] },
      { type: 'agentMessage', phase: 'final_answer', text: reply },
    ],
  }) as any;

test('a chat that never switched is labelled with its own harness', () => {
  const md = transcriptMarkdown('T', [turn('1', 'hi', 'hello')], labelAt('claude:s1', undefined));
  assert.match(md, /## Claude Code\n\nhello/);
  assert.doesNotMatch(md, /## Codex/);
  assert.match(transcriptMarkdown('T', [turn('1', 'hi', 'hello')], labelAt('019a', null)), /## Codex\n\nhello/);
});

test('a switched chat labels each reply by its segment and marks the switch', () => {
  const segs = [
    { harness: 'codex', nativeId: '019a', start: 0, count: 2, model: null, handoff: null },
    { harness: 'claude', nativeId: 'claude:s2', start: 2, count: null, model: 'opus', handoff: { mode: 'summary', tokens: 10, text: 'x' } },
  ] as any;
  const at = labelAt('019a', segs);
  assert.deepEqual([0, 1, 2, 3].map(at), ['Codex', 'Codex', 'Claude Code', 'Claude Code']);
  const md = transcriptMarkdown(
    'T',
    [
      turn('1', 'a', 'one'),
      turn('2', 'b', 'two'),
      turn('3', 'c', 'three', [{ type: 'statusNote', kind: 'switch', text: 'Codex → Claude Code' }]),
    ],
    at,
  );
  assert.deepEqual(
    [...md.matchAll(/^## (Codex|Claude Code)$/gm)].map((m) => m[1]),
    ['Codex', 'Codex', 'Claude Code'],
  );
  assert.match(md, /_Codex → Claude Code_\n\n## User\n\nc/);
});

test('an ACP segment is labelled with its harness, not undefined', () => {
  const segs = [
    { harness: 'codex', nativeId: '019a', start: 0, count: 1, model: null, handoff: null },
    { harness: 'codex', nativeId: 'acp:kimi:s9', start: 1, count: null, model: null, handoff: { mode: 'summary', tokens: 1, text: 'x' } },
  ] as any;
  const md = transcriptMarkdown('T', [turn('1', 'a', 'one'), turn('2', 'b', 'two')], labelAt('019a', segs));
  assert.deepEqual(
    [...md.matchAll(/^## (Codex|Kimi Code|undefined)$/gm)].map((m) => m[1]),
    ['Codex', 'Kimi Code'],
  );
  assert.match(transcriptMarkdown('T', [turn('1', 'a', 'one')], labelAt('acp:qwen:z', undefined)), /## Qwen Code/);
});

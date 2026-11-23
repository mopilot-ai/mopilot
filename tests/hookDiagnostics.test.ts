// Claude Desktop hook notices come from informational messages; process telemetry never supplies a chat row.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codexHookItem } from '../shared/hookRuns.mjs';
import { ClaudeTranslator, hookNote } from './support/claude-translate.ts';

test('the reported startup and prompt exit summaries stay quiet, as in Claude Desktop', () => {
  for (const eventName of ['sessionStart', 'userPromptSubmit']) {
    assert.equal(
      codexHookItem({ id: eventName, eventName, status: 'failed', statusMessage: 'hook exited with code 1', entries: [] } as any),
      null,
    );
    assert.equal(
      hookNote({ subtype: 'hook_response', hook_event: eventName, outcome: 'error', exit_code: 1, stderr: 'internal process diagnostic' }),
      null,
    );
  }
});

test('Codex fallback prefers real feedback to a generic exit summary or runtime warning', () => {
  const item = codexHookItem({
    id: 'startup',
    eventName: 'sessionStart',
    status: 'failed',
    statusMessage: 'hook exited with code 1',
    entries: [
      { kind: 'error', text: 'hook exited with code 1' },
      { kind: 'warning', text: '(node:12) [MODULE_TYPELESS_PACKAGE_JSON] Warning: x' },
      { kind: 'error', text: 'Plugin setup is missing\nRun setup before retrying.' },
    ],
  } as any);
  assert.equal(item?.fragments[0].text, 'Plugin setup is missing\nRun setup before retrying.');
});

test('Claude publishes its native notice, not an invented status for the same hook', () => {
  const items: any[] = [];
  const tr = new ClaudeTranslator('claude:notice', '/repo', (method: string, p: any) => method === 'item/completed' && items.push(p.item));
  tr.beginTurn('turn');
  tr.onMessage({ type: 'system', subtype: 'hook_response', hook_id: 'run', outcome: 'error', stderr: 'internal diagnostic' });
  const content = `${'plugin/'.repeat(30)}: Run setup before retrying.\nYour prompt was retained.`;
  tr.onMessage({ type: 'system', subtype: 'informational', level: 'warning', uuid: 'notice', content });
  assert.deepEqual(items, [{ type: 'hookPrompt', id: 'notice', fragments: [{ text: content }] }]);
});

test('native transcript-only info stays quiet while a blocked notice retains its reason', () => {
  assert.equal(hookNote({ subtype: 'informational', level: 'info', content: 'internal progress' }), null);
  assert.equal(
    hookNote({ subtype: 'informational', level: 'info', prevent_continuation: true, content: 'The project policy blocked this prompt.' }),
    'The project policy blocked this prompt.',
  );
});

test('a rejected prompt keeps its notice on replay even when the prompt never entered the transcript', async () => {
  const { buildTurns } = await import('./support/claude-translate.ts');
  const messages = [
    { type: 'system', subtype: 'hook_response', outcome: 'error', stderr: 'internal' },
    {
      type: 'system',
      subtype: 'informational',
      uuid: 'blocked-1',
      level: 'warning',
      prevent_continuation: true,
      content: 'Project policy blocked this prompt.\r\n\r\nOriginal prompt: private user input',
    },
    { type: 'system', subtype: 'informational', uuid: 'blocked-2', level: 'notice', content: 'Run setup before retrying.' },
  ];
  const turns = buildTurns(messages, 'claude:chat', '/repo');
  assert.deepEqual(
    turns.map((t: any) => [t.id, t.status, t.items.map((i: any) => i.fragments[0].text)]),
    [
      ['notice-blocked-1', 'completed', ['Project policy blocked this prompt.']],
      ['notice-blocked-2', 'completed', ['Run setup before retrying.']],
    ],
  );
  assert.deepEqual(
    buildTurns(messages, 'claude:chat', '/repo').map((t: any) => t.id),
    turns.map((t: any) => t.id),
  );
});

test('malformed notices cannot overwrite another notice or create a pending turn', () => {
  const events: any[] = [];
  const tr = new ClaudeTranslator('claude:chat', '/repo', (method: string, params: any) => events.push([method, params]));
  for (const uuid of [undefined, null, '', 42]) {
    tr.onMessage({ type: 'system', subtype: 'informational', level: 'warning', content: 'message', uuid });
  }
  tr.onMessage({ type: 'system', subtype: 'informational', level: 'warning', content: ' ', uuid: 'empty' });
  assert.deepEqual(events, []);
  assert.equal(tr.turnId, null);
});

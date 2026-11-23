// Hook feedback on each harness: native notices for Claude, meaningful failure/block reasons for Codex, quiet telemetry.
import { test, mock, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { hookRunNote, codexHookItem } from '../shared/hookRuns.mjs';
import { ClaudeTranslator, hookNote } from './support/claude-translate.ts';
import { loadStore, resetAll, flush, listeners, bootImpls, impl } from './support/store-harness.ts';

test('successful, running and intentionally stopped hooks say nothing, even with output', () => {
  for (const outcome of ['success', 'completed', 'running', 'stopped', undefined, 'constructor']) {
    assert.equal(hookRunNote({ outcome, detail: 'internal output' }), null);
  }
});

test('Codex feedback keeps the first meaningful line without inventing a status label or clipping its reason', () => {
  assert.equal(hookRunNote({ outcome: 'failed', detail: '\n lint failed\nmore' }), 'lint failed\nmore');
  assert.equal(hookRunNote({ outcome: 'failed' }), null);
  assert.equal(hookRunNote({ outcome: 'failed', detail: null }), null);
  assert.equal(hookRunNote({ outcome: 'failed', detail: 42 } as any), null);
  assert.equal(hookRunNote({ outcome: 'blocked', detail: 'no rm' }), 'no rm');
  assert.equal(hookRunNote({ outcome: 'blocked' }), 'A hook blocked this action.');
  assert.equal(hookRunNote({ outcome: 'cancelled' }), null);
  assert.equal(hookRunNote({ outcome: 'cancelled', detail: 'The hook timed out.' }), 'The hook timed out.');
  assert.equal(hookRunNote({ outcome: 'failed', detail: 'x'.repeat(300) }), 'x'.repeat(300));
  assert.equal(hookRunNote({ outcome: 'failed', detail: 'hook exited with code 1' }), null);
  assert.equal(hookRunNote({ outcome: 'failed', detail: 'Hook exited with status 7.' }), null);
  assert.equal(
    hookRunNote({ outcome: 'failed', detail: 'hook exited with code 1: setup is missing' }),
    'hook exited with code 1: setup is missing',
  );
  assert.equal(
    hookRunNote({
      outcome: 'failed',
      detail:
        '(node:12) Warning: x\nReparsing as ES module\nTo eliminate this warning, add type\n(Use `node --trace-warnings ...`)\n3 lint errors',
    }),
    '3 lint errors',
  );
});

test('Claude hook telemetry stays quiet for every outcome, even with stderr or output', () => {
  for (const outcome of ['success', 'error', 'cancelled', undefined]) {
    const m = {
      type: 'system',
      subtype: 'hook_response',
      hook_id: 'h',
      hook_event: 'Stop',
      outcome,
      stderr: 'diagnostic',
      output: 'internal output',
    };
    assert.equal(hookNote(m), null);
    const items: any[] = [];
    const tr = new ClaudeTranslator('claude:h', '/repo', (method: string, p: any) => method.startsWith('item/') && items.push(p.item));
    tr.beginTurn('t1');
    tr.onMessage(m);
    assert.deepEqual(items, []);
  }
});

test('Claude native notice levels preserve the complete message and transcript-only info stays quiet', () => {
  for (const level of ['notice', 'suggestion', 'warning']) {
    assert.equal(hookNote({ subtype: 'informational', level, content: '  Feedback\nNext step.  ' }), 'Feedback\nNext step.');
  }
  assert.equal(hookNote({ subtype: 'informational', level: 'info', content: 'trace' }), null);
  assert.equal(
    hookNote({ subtype: 'informational', level: 'info', preventContinuation: true, content: 'Blocked by policy.' }),
    'Blocked by policy.',
  );
  for (const level of [undefined, null, 'unknown', [], 1]) {
    assert.equal(hookNote({ subtype: 'informational', level, content: 'trace' }), null);
  }
  for (const content of [undefined, null, '', '  ', 1, [], {}]) {
    assert.equal(hookNote({ subtype: 'informational', level: 'warning', content }), null);
  }
  assert.equal(hookNote({ subtype: 'hook_started', outcome: 'error' }), null);
  assert.equal(hookNote(null), null);
});

test('Codex fallback scans every error before status and other entries, ignoring malformed optional fields', () => {
  const run = (status: string, extra: object = {}) =>
    ({ id: 'r1', eventName: 'stop', status, statusMessage: null, entries: [], ...extra }) as any;
  assert.equal(codexHookItem(run('completed', { entries: [{ kind: 'context', text: 'added' }] })), null);
  assert.equal(codexHookItem(run('running')), null);
  assert.equal(codexHookItem(null), null);
  assert.equal(codexHookItem({ id: 'r2', eventName: 'sessionStart', status: 'failed' } as any), null);
  assert.equal(codexHookItem(run('failed', { entries: {} })), null);
  assert.deepEqual(
    codexHookItem(
      run('failed', { entries: [null, { kind: 'error', text: 42 }, { kind: 'warning', text: 'w' }, { kind: 'error', text: 'boom' }] }),
    ),
    { type: 'hookPrompt', id: 'hook-r1', fragments: [{ text: 'boom\nw' }] },
  );
  assert.equal(codexHookItem(run('blocked', { statusMessage: 'denied' }))?.fragments[0].text, 'denied');
  assert.equal(codexHookItem(run('failed', { entries: [{ kind: 'warning', text: 'explanation' }] }))?.fragments[0].text, 'explanation');
  assert.equal(codexHookItem(run('stopped', { entries: [{ kind: 'stop', text: 'halt' }] })), null);
});

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S, resetState } = await loadStore();
const note = (method: string, params: any) => listeners['codex.onItem']({ kind: 'notification', chatId: params.threadId, method, params });
before(async () => {
  bootImpls();
  await S.boot();
  await flush();
});
beforeEach(() => {
  resetState();
  resetAll();
  impl['session.snapshot'] = async () => null;
});

test('Codex: hook/completed puts a failed run in its turn and leaves a successful or turnless one out', () => {
  note('turn/started', { threadId: 'c', turn: { id: 'T', status: 'inProgress' } });
  const run = (id: string, status: string) => ({ id, eventName: 'stop', status, statusMessage: 'why', entries: [] });
  note('hook/completed', { threadId: 'c', turnId: 'T', run: run('ok', 'completed') });
  note('hook/completed', { threadId: 'c', turnId: null, run: run('early', 'failed') });
  note('hook/completed', { threadId: 'c', turnId: 'T', run: run('bad', 'failed') });
  const items = S.useStore.getState().runtime.c.turns.find((t: any) => t.id === 'T')!.items;
  assert.deepEqual(items, [{ type: 'hookPrompt', id: 'hook-bad', fragments: [{ text: 'why' }] }]);
});

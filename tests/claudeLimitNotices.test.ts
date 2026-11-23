// Claude native usage failures stay one actionable status across background continuations, live and on replay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { buildTurns } from './support/claude-translate.ts';
import { subagentItems } from './support/claude-translate.ts';
import { mk, asst } from './support/claude-translator-kit.ts';
import { claudeLimitNotifications, CLAUDE_LIMIT_TEXT } from './fixtures/claude-limit-notifications.mjs';
const { claudeTailRunning } = createRequire(import.meta.url)('../electron/session/contract/reconcile.cjs');

let limitSequence = 0;
const limited = (text = CLAUDE_LIMIT_TEXT) => asst([{ type: 'text', text }], { error: 'rate_limit', uuid: `failure-${++limitSequence}` });
const end = { type: 'result', subtype: 'success', is_error: true };
const prompt = { id: 'user', clientId: null, content: [{ type: 'text', text: 'Try again' }] };

test('the captured completed-limit fixture leaves the native external-writer guard idle', () => {
  assert.equal(claudeTailRunning(claudeLimitNotifications().map((m) => JSON.stringify(m))), false);
});

test('two background completions keep their task events and one limit status, never two assistant replies', () => {
  const turns = buildTurns(claudeLimitNotifications(), 'claude:session', '/repo');
  const items = turns.flatMap((t) => t.items) as any[];
  assert.deepEqual(
    items.filter((i) => i.type === 'agentMessage').map((i) => i.text),
    ['The checks are running.'],
  );
  assert.deepEqual(
    items.filter((i) => i.kind === 'limit').map((i) => i.text),
    [CLAUDE_LIMIT_TEXT],
  );
  assert.equal(items.filter((i) => i.kind === 'task').length, 2);
  assert.deepEqual(
    turns.map((t) => t.status),
    ['completed', 'failed', 'failed'],
  );
});

test('live repeated failures update the first notice across automatic turns without making reply items', () => {
  const { tr, events, items } = mk();
  tr.beginTurn('first', prompt);
  tr.onMessage(limited());
  tr.onMessage(end);
  tr.onMessage(limited('Session limit · resets 4am'));
  tr.onMessage(end);
  const notes = events.filter(([m, p]) => m === 'item/completed' && p.item.kind === 'limit').map(([, p]) => p);
  assert.equal(notes.length, 2);
  assert.equal(notes[0].turnId, 'first');
  assert.notEqual(notes[1].turnId, 'first', 'live events name the current turn; the state reducer owns coalescing');
  assert.notEqual(
    notes[0].item.id,
    notes[1].item.id,
    'independent native events retain their identity until folded by the transcript owner',
  );
  assert.equal(notes[1].item.text, 'Session limit · resets 4am');
  assert.equal(items().filter((i) => i.type === 'agentMessage').length, 0);
  assert.ok(events.filter(([m]) => m === 'turn/completed').every(([, p]) => p.turn.status === 'failed'));
});

test('genuine input starts a fresh notice and a successful reply also retires the old limited episode', () => {
  const { tr, events } = mk();
  tr.beginTurn('first', prompt);
  tr.onMessage(limited());
  tr.onMessage(end);
  tr.beginTurn('retry', prompt);
  tr.onMessage(limited());
  tr.onMessage(end);
  tr.onMessage(asst([{ type: 'text', text: 'Recovered' }]));
  tr.onMessage({ type: 'result', subtype: 'success' });
  tr.onMessage(limited());
  const notes = events.filter(([m, p]) => m === 'item/completed' && p.item.kind === 'limit').map(([, p]) => p);
  assert.equal(notes.length, 3);
  assert.equal(new Set(notes.map((p) => p.turnId)).size, 3);
  assert.equal(new Set(notes.map((p) => p.item.id)).size, 3);
});

test('SDK model controls stay hidden while a human model command starts a fresh quota episode on replay', () => {
  const command = '<command-name>/model</command-name>\n<command-message>model</command-message>\n<command-args>opus</command-args>';
  const messages = [
    { type: 'user', uuid: 'prompt', origin: { kind: 'human' }, message: { content: 'Continue the checks' } },
    limited(),
    { type: 'user', uuid: 'sdk-model', message: { content: command } },
    limited(),
    { type: 'user', uuid: 'human-model', origin: { kind: 'human' }, message: { content: command } },
    limited(),
  ];
  const turns = buildTurns(messages, 'claude:session', '/repo');
  const items = turns.flatMap((t) => t.items) as any[];
  assert.deepEqual(
    items.filter((i) => i.type === 'userMessage').map((i) => i.content.map((c: any) => c.text)),
    [['Continue the checks'], ['/model opus']],
  );
  assert.equal(items.filter((i) => i.kind === 'limit').length, 2);
  assert.equal(items.filter((i) => i.type === 'agentMessage').length, 0);
  assert.deepEqual(
    turns.map((t) => t.status),
    ['failed', 'failed'],
  );
  assert.equal(subagentItems(messages, 'claude:session', '/repo').filter((i: any) => i.kind === 'limit').length, 2);
});

test('ordinary model text mentioning limits stays a reply; typed empty errors get a readable fallback', () => {
  const { tr, items } = mk();
  tr.beginTurn('turn', prompt);
  tr.onMessage(asst([{ type: 'text', text: CLAUDE_LIMIT_TEXT }]));
  tr.onMessage(asst([null, { type: 'text', text: 42 }], { error: 'rate_limit' }));
  assert.equal(items().filter((i) => i.type === 'agentMessage').length, 1);
  assert.deepEqual(
    items()
      .filter((i) => i.kind === 'limit')
      .map((i) => i.text),
    ['Usage limit reached. Try again when the limit resets.'],
  );
});

test('a successful failover in the same turn clears the quota failure; an explicit stop stays interrupted', () => {
  const { tr, events } = mk();
  tr.beginTurn('failover', prompt);
  tr.onMessage(limited());
  tr.onMessage(asst([{ type: 'text', text: 'Another account continued the task.' }]));
  tr.onMessage({ type: 'result', subtype: 'success' });
  tr.beginTurn('stopped', prompt);
  tr.onMessage(limited());
  tr.markInterrupted();
  tr.onMessage(end);
  assert.deepEqual(
    events.filter(([m]) => m === 'turn/completed').map(([, p]) => p.turn.status),
    ['completed', 'interrupted'],
  );
});

test('quota notices are isolated per native translator and sub-agent; sub-agent failures never become replies', () => {
  const first = mk();
  const second = mk();
  first.tr.beginTurn('one', prompt);
  second.tr.beginTurn('two', prompt);
  first.tr.onMessage(limited());
  const secondLimit = limited('Another login is limited');
  second.tr.onMessage(secondLimit);
  assert.equal(second.items().find((i) => i.kind === 'limit').id, `limit-${secondLimit.uuid}`);
  assert.equal(first.items().find((i) => i.kind === 'limit').text, CLAUDE_LIMIT_TEXT);
  const items = subagentItems([limited(), limited('Latest reset time')], 'chat', '/repo') as any[];
  assert.deepEqual(
    items.map((i) => [i.type, i.kind, i.text]),
    [['statusNote', 'limit', 'Latest reset time']],
  );
});

test('other upstream failures stay visible and empty authentication failures stay readable', () => {
  const { tr, items, events } = mk();
  tr.beginTurn('turn', prompt);
  tr.onMessage(limited());
  tr.onMessage(asst([{ type: 'text', text: 'Other upstream error' }], { error: 'unknown' }));
  tr.onMessage(limited());
  assert.equal(items().find((i) => i.type === 'agentMessage').text, 'Other upstream error');
  assert.equal(items().find((i) => i.type === 'agentMessage').synthetic, true);
  tr.onMessage(end);
  tr.beginTurn('auth', prompt);
  tr.onMessage({ type: 'assistant', error: 'authentication_failed' });
  tr.onMessage(end);
  assert.equal(events.filter(([m]) => m === 'turn/completed').at(-1)![1].turn.error.message, 'Failed to authenticate');
  tr.beginTurn('empty', prompt);
  tr.onMessage({ type: 'assistant', error: 'rate_limit' });
  assert.match(items().at(-1).text, /Usage limit reached/);
});

test('recovery inside one owner preserves both historical episodes when items are actually folded', () => {
  const messages = [limited('First limit'), asst([{ type: 'text', text: 'Recovered' }]), limited('Second limit')];
  const turn = buildTurns(messages, 'chat', '/repo')[0];
  assert.deepEqual(
    (turn.items as any[]).map((i) => i.text),
    ['First limit', 'Recovered', 'Second limit'],
  );
  assert.deepEqual(
    (subagentItems(messages, 'chat', '/repo') as any[]).map((i) => i.text),
    ['First limit', 'Recovered', 'Second limit'],
  );
});

test('error results do not repeat the quota note, but preserve distinct diagnostics', () => {
  for (const errors of [[CLAUDE_LIMIT_TEXT], [CLAUDE_LIMIT_TEXT, 'A separate failure']]) {
    const { tr, events } = mk();
    tr.beginTurn('turn', prompt);
    tr.onMessage(limited());
    tr.onMessage({ type: 'result', subtype: 'error_during_execution', errors });
    assert.deepEqual(
      events.find(([m]) => m === 'turn/completed')![1].turn.error,
      errors.length === 1 ? null : { message: 'A separate failure' },
    );
  }
});

test('a real mid-turn prompt retires coalescing in live, replay and subagent histories', () => {
  const { tr, items } = mk();
  tr.beginTurn('turn', prompt);
  tr.onMessage(limited('First'));
  tr.addSteer();
  tr.onMessage(limited('Second'));
  assert.equal(
    new Set(
      items()
        .filter((i) => i.kind === 'limit')
        .map((i) => i.id),
    ).size,
    2,
  );
  const tool = asst([{ type: 'tool_use', name: 'Read', id: 'read', input: { file_path: '/repo/a' } }]);
  const retry = { type: 'user', uuid: 'retry', message: { content: 'Try again' } };
  const messages = [
    tool,
    limited('First'),
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'read', content: 'done' }] } },
    retry,
    limited('Second'),
  ];
  assert.equal((buildTurns(messages, 'chat', '/repo')[0].items as any[]).filter((i) => i.kind === 'limit').length, 2);
  assert.deepEqual(
    (subagentItems([limited('First'), retry, limited('Second')], 'chat', '/repo') as any[]).map((i) => i.text),
    ['First', 'Second'],
  );
});

test('synthetic status text does not claim the provider recovered or open a second quota episode', () => {
  const { tr, events } = mk();
  tr.beginTurn('turn', prompt);
  tr.onMessage(limited());
  tr.onMessage({ type: 'assistant', message: { model: '<synthetic>', content: [] } });
  tr.onMessage(limited());
  tr.onMessage(end);
  const replay = buildTurns([limited(), { type: 'assistant', message: { model: '<synthetic>', content: [] } }, limited()], 'chat', '/repo');
  assert.equal(replay.flatMap((t) => t.items).filter((i: any) => i.kind === 'limit').length, 1);
  assert.equal(events.find(([m]) => m === 'turn/completed')![1].turn.status, 'failed');
});

test('subagent metadata-only user frames are harmless and cannot fabricate recovery', () => {
  assert.deepEqual(subagentItems([{ type: 'user' }], 'chat', '/repo'), []);
});

test('non-quota result failures keep their fallback, while diagnostic-only results stay successful', () => {
  const { tr, events } = mk();
  tr.beginTurn('failed', prompt);
  tr.onMessage({ type: 'result', subtype: 'error_max_turns', errors: [] });
  tr.beginTurn('diagnostic', prompt);
  tr.onMessage({ type: 'result', subtype: 'error_during_execution', errors: ['[ede_diagnostic] result_type=user'] });
  assert.deepEqual(
    events.filter(([m]) => m === 'turn/completed').map(([, p]) => [p.turn.status, p.turn.error]),
    [
      ['failed', { message: 'error_max_turns' }],
      ['completed', null],
    ],
  );
});

test('successful authentication failover clears the old error in live and replayed turns', () => {
  const failed = asst([{ type: 'text', text: 'Expired' }], { error: 'authentication_failed' });
  const recovered = asst([{ type: 'text', text: 'Recovered' }]);
  const { tr, events } = mk();
  tr.beginTurn('turn', prompt);
  tr.onMessage(failed);
  tr.onMessage(recovered);
  tr.onMessage({ type: 'result', subtype: 'success' });
  const done = events.find(([m]) => m === 'turn/completed')![1].turn;
  assert.equal(done.status, 'completed');
  assert.equal(done.error, null);
  const replay = buildTurns([failed, recovered], 'chat', '/repo')[0];
  assert.equal(replay.status, 'completed');
  assert.equal(replay.error, null);
});

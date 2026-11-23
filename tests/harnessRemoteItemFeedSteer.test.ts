// The remote item feed under steers (#4201): one live turn across messages sent mid-turn, in-order user items, saved-row identity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createItemFeed } = require('../electron/harness/remoteItemFeed.cjs');

/** Timers that run only when a test says so. */
function make() {
  const events: any[] = [];
  const waiting: (() => void)[] = [];
  const timers = { setTimeout: ((fn: () => void) => (waiting.push(fn), waiting.length)) as any, clearTimeout: (() => {}) as any };
  const feed = createItemFeed({ emit: (e: any) => events.push(e), batcher: { timers } });
  return { feed, events, timers: { tick: () => waiting.splice(0).forEach((fn) => fn()) } };
}
const msg = (id: string, text: string) => ({ type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null });
const claudeMsg = (m: any) => ({ kind: 'message', key: 'k', msg: m });

const assistant = (uuid: string, id: string, text: string) =>
  claudeMsg({ type: 'assistant', uuid, parent_tool_use_id: null, message: { id, content: [{ type: 'text', text }] } });
const done = () => claudeMsg({ type: 'result', subtype: 'success', is_error: false, result: '' });

test('Claude: steers keep one live turn and appear in order as user items, with attachments (#4201)', () => {
  const { feed, events, timers } = make();
  const go = (raw: any) => assert.deepEqual(feed.push('c', 'claude', raw), { supported: true });
  go({ kind: 'turnStarting', turnId: 'ct-q', clientId: 'q', text: 'A', attachments: [{ kind: 'image', path: '/a.png' }] });
  go(assistant('u1', 'm1', 'T1'));
  go({ kind: 'steered', clientId: 'b', text: 'B' });
  go(done()); // the first segment ends: the steer keeps the turn open
  go(assistant('u2', 'm2', 'T2'));
  go({ kind: 'steered', clientId: 'c', text: 'C', attachments: null });
  go(done());
  go(assistant('u3', 'm3', 'T3'));
  go(done());
  timers.tick();
  const started = events.filter((e) => e.ev === 'turn.state' && e.started);
  assert.equal(started.length, 1);
  const items = feed.snapshot('c').liveItems;
  assert.deepEqual(
    items.map((i: any) => [i.type, i.type === 'userMessage' ? i.content.map((c: any) => c.text ?? c.type).join('|') : i.text]),
    [
      ['userMessage', 'A|localImage'],
      ['agentMessage', 'T1'],
      ['userMessage', 'B'],
      ['agentMessage', 'T2'],
      ['userMessage', 'C'],
      ['agentMessage', 'T3'],
    ],
  );
  // Every item includes its native scope, kind and stable item identity.
  assert.equal(items[1].rowId, JSON.stringify(['k', 'q', 'agentMessage', items[1].id]));
});

test('Claude: a failed steer leaves the turn and its items as they were; a steer with no turn opens it', () => {
  const { feed, events, timers } = make();
  feed.push('c', 'claude', { kind: 'turnStarting', turnId: 'ct-q', clientId: 'q', text: 'A' });
  feed.push('c', 'claude', { kind: 'steered', clientId: 's', text: 'B' });
  feed.push('c', 'claude', { kind: 'steerFailed' });
  feed.push('c', 'claude', assistant('u1', 'm1', 'Reply'));
  feed.push('c', 'claude', done());
  timers.tick();
  assert.deepEqual(
    events.filter((e) => e.ev === 'turn.state').map((e) => e.status),
    ['inProgress', 'completed'],
  );
  const open = make();
  open.feed.push('c', 'claude', { kind: 'steered', clientId: 's', text: 'Alone' });
  open.timers.tick();
  assert.deepEqual(
    open.feed.snapshot('c').liveItems.map((i: any) => i.type),
    ['userMessage'],
  );
});

test('an item event without a turn id has no saved-row identity to name', () => {
  const { feed, timers } = make();
  feed.push('c', 'codex', { method: 'item/completed', params: { threadId: 'c', item: msg('m', 'Hi') } });
  timers.tick();
  assert.equal('rowId' in feed.snapshot('c').items[0], false);
});

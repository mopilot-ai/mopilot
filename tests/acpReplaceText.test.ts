// An ACP update that replaces text already drawn of the open message (a Host chat's whole message after a lost delta, #3525), in every consumer of the event:
// the translator's item (core/crates/translate), the stream batcher's joins (core/crates/batcher) and the turn's completion text (electron/session/controllerEvents.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { setup } from './support/controller-coverage/setup.ts';

const require = createRequire(import.meta.url);
const { AcpTranslator } = require('../electron/harness/items/acpTranslator.cjs');
const { CoreBatcher, familyChats } = require('../electron/harness/coreBatcher.cjs');

const text = (t: string) => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } });
const thought = (t: string) => ({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: t } });

/** A translator and the items a window holds from it, folded the way the store applies them (src/store/notifications.ts). */
function window() {
  const items = new Map<string, any>();
  const methods: string[] = [];
  const tr = new AcpTranslator('c', '', (method: string, p: any) => {
    methods.push(method);
    if (method === 'item/started' || method === 'item/completed') items.set(p.item.id, structuredClone(p.item));
    else if (method === 'item/agentMessage/delta') items.get(p.itemId).text += p.delta;
    else if (method === 'item/reasoning/summaryTextDelta') items.get(p.itemId).summary[0] += p.delta;
  });
  tr.beginTurn('t1');
  return { tr, items, methods, all: () => [...items.values()].filter((i) => i.type !== 'userMessage') };
}

test('a replacement corrects the open message at once and at its end, keeping text drawn before the part it replaces', () => {
  const w = window();
  w.tr.onUpdate(text('Hello. '), 't1');
  w.tr.onUpdate(text('while away'), 't1');
  w.tr.onUpdate(text('fake-host: while away'), 't1', 'while away');
  assert.deepEqual(
    w.all().map((i) => i.text),
    ['Hello. fake-host: while away'],
  );
  w.tr.endTurn('end_turn', null);
  assert.deepEqual(
    w.all().map((i) => i.text),
    ['Hello. fake-host: while away'],
  );
});

test('a replacement names its message: the one with that messageId is corrected', () => {
  const w = window();
  w.tr.onUpdate({ ...text('pa'), messageId: 'm1' }, 't1');
  w.tr.onUpdate({ ...text('part'), messageId: 'm1' }, 't1', 'pa');
  w.tr.endTurn('end_turn', null);
  assert.deepEqual(
    w.all().map((i) => i.text),
    ['part'],
  );
});

test('a replacement with no text clears the drawn part', () => {
  const w = window();
  w.tr.onUpdate(text('keep '), 't1');
  w.tr.onUpdate(text('drop'), 't1');
  w.tr.onUpdate(text(''), 't1', 'drop');
  w.tr.endTurn('end_turn', null);
  assert.deepEqual(
    w.all().map((i) => i.text),
    ['keep '],
  );
  // an empty replacement of text that is not open draws nothing
  const v = window();
  v.tr.onUpdate(text(''), 't1', 'nope');
  v.tr.endTurn('end_turn', null);
  assert.deepEqual(v.all(), []);
});

test('a replacement of thought text corrects the reasoning item', () => {
  const w = window();
  w.tr.onUpdate(thought('half'), 't1');
  w.tr.onUpdate(thought('the whole'), 't1', 'half');
  w.tr.endTurn('end_turn', null);
  assert.deepEqual(
    w.all().map((i) => i.summary),
    [['the whole']],
  );
});

test('a message still held back takes the replacement quietly; a replacement with nothing open to replace is drawn as text', () => {
  const w = window();
  // a message's first characters decide whether it is a compaction summary: it is held until then
  w.tr.onUpdate(text('#'), 't1');
  const before = w.methods.length;
  w.tr.onUpdate(text('# So it goes'), 't1', '#');
  assert.equal(w.methods.length, before, 'nothing shown while held back');
  w.tr.endTurn('end_turn', null);
  assert.deepEqual(
    w.all().map((i) => i.text),
    ['# So it goes'],
  );
  const v = window();
  v.tr.onUpdate(text('whole'), 't1', 'gone');
  v.tr.onUpdate(text(' more'), 't1', '');
  v.tr.endTurn('end_turn', null);
  assert.deepEqual(
    v.all().map((i) => i.text),
    ['whole more'],
  );
});

test('the stream batcher never joins a replacement with the deltas around it', () => {
  const sent: any[] = [];
  // a tick that never ends: every delta after the first waits for the flush
  const timers = { setTimeout: () => 1, clearTimeout: () => {} };
  const b = new CoreBatcher({ send: (_f: string, e: any) => (sent.push(e), true), timers });
  b.register('acp', familyChats({ chatOf: (k: string) => k }).acp);
  const e = { kind: 'update', key: 'c', turnId: 't', update: text('x') };
  for (const event of [e, e, e, { ...e, replaces: 'y' }, e]) b.push('acp', event);
  b.flushAll();
  assert.deepEqual(
    sent.map((s) => `${s.update.content.text}${s.replaces ? ` for ${s.replaces}` : ''}`),
    ['x', 'xx', 'x for y', 'x'],
  );
});

test("the turn's completion text takes the replacement in place of the text it names", () => {
  const finished: any[] = [];
  const { c, state } = setup({ ids: ['acp1'], ctl: { onFinished: (e: any) => finished.push(e) } });
  state.patch('acp1', { plan: false });
  const key = 'acp:kimi:acp1';
  c.onAcpEvent({ key, kind: 'turnStart', turnId: 't1' });
  c.onAcpEvent({ key, kind: 'update', turnId: 't1', update: text('Hi. ') });
  c.onAcpEvent({ key, kind: 'update', turnId: 't1', update: text('while away') });
  c.onAcpEvent({ key, kind: 'update', turnId: 't1', update: text('fake-host: while away'), replaces: 'while away' });
  // a replacement that names text the turn does not end with adds to it
  c.onAcpEvent({ key, kind: 'update', turnId: 't1', update: text('!'), replaces: 'nope' });
  c.onAcpEvent({ key, kind: 'turnEnd', turnId: 't1', stopReason: 'end_turn' });
  assert.equal(finished[0].text, 'Hi. fake-host: while away!');
});

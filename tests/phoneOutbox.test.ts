// The phone's outbox: messages wait per computer, go out in order once, a refused one holds back its own chat, and a connection that dropped under a request sends it again under the same id.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createOutbox, restoreItems, FILES_LOST, MAX_QUEUED, NO_ID, STALE, WAS_SENDING, type QueuedSend } from '../mobile/src/outbox.ts';

function rig(o: { online?: boolean } = {}) {
  const state = {
    online: o.online ?? true,
    p2: false,
    idempotent: true,
    ready: true,
    gate: null as Promise<boolean> | null,
    readyError: null as unknown,
  };
  const sent: string[] = [];
  const ids: string[] = [];
  const changes: QueuedSend[][] = [];
  const gates: Array<{ item: QueuedSend; ok: () => void; fail: (e: unknown) => void }> = [];
  let n = 0;
  const box = createOutbox({
    online: (pairId) => (pairId === 'p1' ? state.online : state.p2),
    send: (item) => {
      sent.push(item.text);
      ids.push(item.id);
      return new Promise((resolve, reject) => gates.push({ item, ok: () => resolve({ sent: true }), fail: reject }));
    },
    lost: (error) => error instanceof Error && error.message === 'Connection closed',
    idempotent: () => state.idempotent,
    ready: () => state.gate ?? (state.readyError !== null ? Promise.reject(state.readyError) : Promise.resolve(state.ready)),
    newId: () => `id-${++n}`,
    now: () => 100 + n,
    onChange: (items) => changes.push(items),
  });
  const last = () => changes.at(-1) ?? [];
  const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
  const m = (text: string, chatId = 'c1', pairId = 'p1') => ({ pairId, chatId, text, attachments: [] as string[] });
  return { box, state, sent, ids, gates, last, tick, m };
}

test('a message typed while the computer is away waits, then goes once, and is gone when accepted', async () => {
  const r = rig({ online: false });
  const id = r.box.add(r.m('hello'));
  await r.tick();
  assert.deepEqual(r.sent, []);
  assert.deepEqual(r.last(), [{ id, pairId: 'p1', chatId: 'c1', text: 'hello', attachments: [], at: 101, status: 'queued', error: null }]);
  r.state.online = true;
  void r.box.flush('p1');
  await r.tick();
  assert.equal(r.last()[0].status, 'sending');
  r.gates[0].ok();
  await r.tick();
  assert.deepEqual(r.last(), []);
  assert.deepEqual(r.sent, ['hello']);
  // flushing again finds nothing and nothing is sent twice
  void r.box.flush('p1');
  await r.tick();
  assert.deepEqual(r.sent, ['hello']);
});

test('messages in one chat go in order, and an offline computer keeps its own messages', async () => {
  const r = rig();
  r.box.add(r.m('one'));
  r.box.add(r.m('two'));
  r.box.add(r.m('other', 'c1', 'p2'));
  await r.tick();
  assert.deepEqual(r.sent, ['one'], 'the second waits for the first');
  r.gates[0].ok();
  await r.tick();
  assert.deepEqual(r.sent, ['one', 'two']);
  r.gates[1].ok();
  await r.tick();
  assert.deepEqual(
    r.sent,
    ['one', 'two', 'other'].filter((t) => t !== 'other'),
    'p2 is not this computer’s',
  );
  assert.deepEqual(
    r.last().map((i) => [i.text, i.status]),
    [['other', 'queued']],
  );
  r.state.p2 = true;
  void r.box.flush('p2');
  await r.tick();
  assert.deepEqual(r.sent.at(-1), 'other');
});

test('a message added while a pass runs is picked up by it', async () => {
  const r = rig();
  r.box.add(r.m('first'));
  await r.tick();
  r.box.add(r.m('second'));
  await r.tick();
  r.gates[0].ok();
  await r.tick();
  r.gates[1].ok();
  await r.tick();
  assert.deepEqual(r.sent, ['first', 'second']);
  assert.deepEqual(r.last(), []);
});

test('a connection that dropped under a request puts the message back, with the same id', async () => {
  const r = rig();
  const id = r.box.add(r.m('keep me'));
  await r.tick();
  r.state.online = false;
  r.gates[0].fail(new Error('Connection closed'));
  await r.tick();
  assert.deepEqual(
    r.last().map((i) => [i.id, i.status]),
    [[id, 'queued']],
  );
  r.state.online = true;
  void r.box.flush('p1');
  await r.tick();
  assert.deepEqual(r.ids, [id, id], 'sent again under the one id the Mac de-duplicates by');
  r.gates[1].ok();
  await r.tick();
  assert.deepEqual(r.last(), []);
});

test('a refused message stays with what the computer said, holds back its chat, and goes again on Retry', async () => {
  const r = rig();
  const bad = r.box.add(r.m('bad'));
  r.box.add(r.m('later'));
  r.box.add(r.m('elsewhere', 'c2'));
  await r.tick();
  r.gates[0].fail(new Error('The harness did not accept the message.'));
  await r.tick();
  assert.deepEqual(r.sent, ['bad', 'elsewhere'], 'the same chat’s later message waits, another chat goes on');
  r.gates[1].ok();
  await r.tick();
  assert.deepEqual(
    r.last().map((i) => [i.text, i.status, i.error]),
    [
      ['bad', 'failed', 'The harness did not accept the message.'],
      ['later', 'queued', null],
    ],
  );
  assert.equal(r.box.retry('later'), false, 'only a refused message is sent again');
  assert.equal(r.box.retry('nope'), false);
  assert.equal(r.box.retry(bad), true);
  await r.tick();
  assert.equal(r.last()[0].status, 'sending');
  assert.deepEqual(r.ids.slice(0, 1).concat(r.ids.at(-1)!), [bad, bad], 'Retry keeps the id');
  r.gates.at(-1)!.ok();
  await r.tick();
  assert.deepEqual(r.sent.slice(-2), ['bad', 'later'], 'then the held message goes');
  r.gates.at(-1)!.ok();
  await r.tick();
  assert.deepEqual(r.last(), []);
});

test('a failure that is not an Error still shows a reason', async () => {
  const r = rig();
  r.box.add(r.m('x'));
  await r.tick();
  r.gates[0].fail('plain text');
  await r.tick();
  assert.equal(r.last()[0].error, 'The message was not sent.');
});

test('Cancel takes back a waiting or refused message, never one in flight', async () => {
  const r = rig({ online: false });
  const a = r.box.add(r.m('a'));
  assert.equal(r.box.cancel(a), true);
  assert.deepEqual(r.last(), []);
  assert.equal(r.box.cancel(a), false, 'already gone');
  r.state.online = true;
  const b = r.box.add(r.m('b'));
  await r.tick();
  assert.equal(r.box.cancel(b), false, 'in flight');
  r.gates[0].fail(new Error('refused'));
  await r.tick();
  assert.equal(r.box.cancel(b), true, 'a refused one can be dropped');
  assert.deepEqual(r.last(), []);
});

test('clearing or dropping while a message is in flight leaves nothing to update when it ends', async () => {
  const r = rig();
  r.box.add(r.m('one'));
  r.box.add(r.m('two', 'c2', 'p2'));
  await r.tick();
  r.box.clear();
  assert.deepEqual(r.last(), []);
  r.gates[0].ok();
  await r.tick();
  assert.deepEqual(r.last(), []);
  r.box.clear();
  // dropped while failing
  const q = rig();
  q.box.add(q.m('x'));
  await q.tick();
  q.box.drop('p1');
  q.box.drop('p1');
  q.gates[0].fail(new Error('refused'));
  await q.tick();
  assert.deepEqual(q.last(), []);
  // a drop of a computer with nothing queued changes nothing
  const before = q.last();
  q.box.drop('other');
  assert.equal(q.last(), before);
});

test('cancelling a refused message lets the ones it held back go', async () => {
  const r = rig();
  const bad = r.box.add(r.m('bad'));
  r.box.add(r.m('next'));
  await r.tick();
  r.gates[0].fail(new Error('refused'));
  await r.tick();
  assert.deepEqual(r.sent, ['bad']);
  assert.equal(r.box.cancel(bad), true);
  await r.tick();
  assert.deepEqual(r.sent, ['bad', 'next']);
  r.gates[1].ok();
  await r.tick();
  assert.deepEqual(r.last(), []);
});

test('a flush asked for while another computer’s pass runs is not lost', async () => {
  const r = rig();
  r.state.p2 = true;
  r.box.add(r.m('a', 'c1', 'p1'));
  await r.tick();
  r.box.add(r.m('b', 'c1', 'p2'));
  await r.tick();
  r.gates[0].ok();
  await r.tick();
  assert.deepEqual(r.sent, ['a', 'b'], 'the second computer’s message went after the first pass');
  r.gates[1].ok();
  await r.tick();
  assert.deepEqual(r.last(), []);
});

test('an older computer, which cannot recognise a repeated send, is never sent a message that may already have arrived', async () => {
  const r = rig();
  r.state.idempotent = false;
  r.box.add(r.m('maybe'));
  r.box.add(r.m('later'));
  await r.tick();
  r.gates[0].fail(new Error('Connection closed'));
  await r.tick();
  assert.deepEqual(
    r.last().map((i) => [i.text, i.status]),
    [
      ['maybe', 'failed'],
      ['later', 'queued'],
    ],
  );
  assert.match(r.last()[0].error!, /Check the chat/);
  assert.deepEqual(r.sent, ['maybe'], 'nothing is sent again by itself, and the chat’s later message waits for the person');
});

test('the computer is asked what it can do before the first message; a connection lost or a message taken back meanwhile sends nothing', async () => {
  const r = rig();
  r.state.ready = false;
  r.box.add(r.m('waits for the answer'));
  await r.tick();
  assert.deepEqual(r.sent, [], 'the connection went while it was asked');
  assert.equal(r.last()[0].status, 'queued');
  r.state.ready = true;
  void r.box.flush('p1');
  await r.tick();
  assert.deepEqual(r.sent, ['waits for the answer']);
  r.gates[0].ok();
  await r.tick();

  // taken back while the computer is asked
  const q = rig();
  let answer: (v: boolean) => void = () => undefined;
  q.state.gate = new Promise<boolean>((r2) => (answer = r2));
  const id = q.box.add(q.m('taken back'));
  await q.tick();
  q.box.cancel(id);
  answer(true);
  await q.tick();
  assert.deepEqual(q.sent, []);

  // the computer goes away while it is asked
  const w = rig();
  w.state.gate = new Promise<boolean>((r2) => (answer = r2));
  w.box.add(w.m('stays queued'));
  await w.tick();
  w.state.online = false;
  answer(true);
  await w.tick();
  assert.deepEqual(w.sent, []);
  assert.equal(w.last()[0].status, 'queued');
});

test('a computer that could not say what it can do gets no message blind; the message says why and can be sent again', async () => {
  const r = rig();
  r.state.readyError = new Error('The request failed.');
  const id = r.box.add(r.m('not blind'));
  r.box.add(r.m('other chat', 'c2'));
  await r.tick();
  assert.deepEqual(
    r.sent,
    ['other chat'].filter(() => false),
    'nothing was sent while the computer could not answer',
  );
  assert.deepEqual(
    r.last().map((i) => [i.text, i.status, i.error]),
    [
      ['not blind', 'failed', 'The request failed.'],
      ['other chat', 'failed', 'The request failed.'],
    ],
  );
  r.state.readyError = 'plain text';
  r.box.retry(id);
  await r.tick();
  assert.equal(r.last()[0].error, 'The computer did not answer.');
  r.state.readyError = null;
  r.box.retry(id);
  await r.tick();
  assert.deepEqual(r.sent, ['not blind']);
});

test('what was saved before the app closed comes back waiting, never in flight, never past the limits', async () => {
  const now = 10 * 24 * 60 * 60 * 1000;
  const pairs = new Set(['p1']);
  const saved = [
    { id: 'send-0001', pairId: 'p1', chatId: 'c1', text: 'waiting', attachments: [], at: now - 1000, status: 'queued', error: null },
    { id: 'send-0002', pairId: 'p1', chatId: 'c1', text: 'was in flight', attachments: [], at: now - 1000, status: 'sending', error: null },
    {
      id: 'send-0003',
      pairId: 'p1',
      chatId: 'c2',
      text: 'refused',
      attachments: [],
      at: now - 1000,
      status: 'failed',
      error: 'no',
      final: false,
    },
    { id: 'send-0004', pairId: 'p1', chatId: 'c2', text: 'final', attachments: [], at: now - 1000, status: 'failed', final: true },
    {
      id: 'send-0005',
      pairId: 'p1',
      chatId: 'c3',
      text: 'with a file',
      attachments: ['f1'],
      at: now - 1000,
      status: 'queued',
      error: null,
    },
    {
      id: 'send-0006',
      pairId: 'p1',
      chatId: 'c3',
      text: 'old',
      attachments: [],
      at: now - 8 * 24 * 60 * 60 * 1000,
      status: 'queued',
      error: null,
    },
    {
      id: 'send-0007',
      pairId: 'gone',
      chatId: 'c1',
      text: 'for a removed computer',
      attachments: [],
      at: now,
      status: 'queued',
      error: null,
    },
    { id: 'x', pairId: 'p1', chatId: 'c1', text: 'bad id', attachments: [], at: now, status: 'queued', error: null },
    { id: 'send-0008', pairId: 'p1', chatId: 'c1', text: 7, attachments: [], at: now, status: 'queued', error: null },
    { id: 'send-0009', pairId: 'p1', chatId: 'c1', text: 'no time', attachments: [], status: 'queued', error: null },
    {
      id: 'send-0010',
      pairId: 'p1',
      chatId: 'c4',
      text: 'from a clock that was ahead',
      attachments: [],
      at: now + 3600_000,
      status: 'queued',
      error: null,
    },
    null,
  ];
  const back = restoreItems(saved, { now, pairs });
  assert.deepEqual(
    back.map((i) => [i.text, i.status, i.final ?? false, i.attachments.length, i.restored]),
    [
      ['waiting', 'queued', false, 0, true],
      ['was in flight', 'failed', false, 0, true],
      ['refused', 'failed', false, 0, true],
      ['final', 'failed', true, 0, true],
      ['with a file', 'failed', false, 0, true],
      ['old', 'failed', true, 0, true],
      ['from a clock that was ahead', 'failed', true, 0, true],
    ],
  );
  assert.equal(back[1].error, WAS_SENDING);
  assert.equal(back[2].error, 'no');
  assert.equal(back[3].error, WAS_SENDING, 'a refusal without a reason still says something');
  assert.equal(back[4].error, FILES_LOST);
  assert.equal(back[5].error, STALE);
  assert.deepEqual(restoreItems('nothing', { now, pairs }), []);
  const many = Array.from({ length: MAX_QUEUED + 5 }, (_, i) => ({ ...saved[0], id: `send-${String(i).padStart(4, '0')}x` }));
  assert.equal(restoreItems(many, { now, pairs }).length, MAX_QUEUED);
});

test('a restored message is sent only to a computer that answers a repeated id once, and a final one can only be cancelled', async () => {
  const r = rig();
  const pairs = new Set(['p1']);
  const now = 1000;
  const mk = (id: string, text: string, status = 'queued') => ({
    id,
    pairId: 'p1',
    chatId: 'c1',
    text,
    attachments: [],
    at: now,
    status,
    error: null,
  });
  r.state.idempotent = false;
  r.box.restore(restoreItems([mk('send-0001', 'from before')], { now, pairs }));
  void r.box.flush('p1');
  await r.tick();
  assert.deepEqual(r.sent, [], 'not sent without the id being honoured');
  assert.equal(r.last()[0].error, NO_ID);
  assert.equal(r.box.retry('send-0001'), false, 'nothing to retry: it is final');
  assert.equal(r.box.cancel('send-0001'), true);
  r.state.idempotent = true;
  r.box.restore(restoreItems([mk('send-0002', 'from before again')], { now, pairs }));
  r.box.restore([]);
  void r.box.flush('p1');
  await r.tick();
  assert.deepEqual(r.sent, ['from before again']);
  assert.deepEqual(r.ids, ['send-0002'], 'under the id it was typed with');
  r.gates[0].ok();
  await r.tick();
  assert.deepEqual(r.last(), []);
  // the one that was in flight when the app closed waits for the person, and goes again on Retry under its id
  r.box.restore(restoreItems([mk('send-0003', 'maybe sent', 'sending')], { now, pairs }));
  void r.box.flush('p1');
  await r.tick();
  assert.deepEqual(r.sent, ['from before again'], 'never by itself');
  assert.equal(r.box.retry('send-0003'), true);
  await r.tick();
  assert.deepEqual(r.ids.at(-1), 'send-0003');
});

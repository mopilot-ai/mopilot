// Security review of Mobile Remote: an approval a phone answers must not take effect once the Mac has removed that phone, even when the removal lands while the answer is being checked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rig, settle } from './support/remote-kit.ts';

const ok = (r: any) => (assert.equal(r.ok, true, JSON.stringify(r.error)), r.result);
const answered = (r: any) => r.calls.filter((c: any[]) => c[0] === 'answer');

/** A chat with one card up, followed by p1, whose card list is read slowly so a request can be caught half way. */
async function slowCards() {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  let slow = false;
  const r = rig();
  const cardsOf = r.ops.cardsOf;
  r.ops.cardsOf = async (id: string) => {
    if (slow) await gate;
    return cardsOf(id);
  };
  r.state.patch('c1', { approvals: [{ id: 'a1', method: 'x', params: {} }] });
  const p = r.phone('p1');
  const snap = ok(await p.ask('chat.follow', { chatId: 'c1' }));
  slow = true;
  return { r, p, rev: snap.rev as number, release };
}

test('a card answer already in flight when the Mac removes the phone does not reach the harness', async () => {
  const { r, p, rev, release } = await slowCards();
  const id = 'p1-late';
  await p.send({ id, t: 1, kind: 'request', method: 'card.answer', params: { chatId: 'c1', cardId: 'a1', rev, key: 'once' } });
  await settle();
  // the Mac revokes the pair while the request is still being checked
  r.link.removePair('p1');
  release();
  await settle();
  assert.deepEqual(answered(r), [], 'a removed phone approved a command');
});

test('a MoMo card answer in flight when the Mac removes the phone is not delivered', async () => {
  let release!: () => void;
  const gate = new Promise<void>((res) => (release = res));
  const delivered: unknown[] = [];
  const approval = { id: 'm1', params: { kind: 'momoAction' } };
  const r = rig({
    momo: true,
    ops: {
      cardsOf: async () => {
        await gate;
        return [{ id: 'm1', title: 'Send it?', choices: [{ key: 'yes', label: 'Yes' }], version: 'v1' }];
      },
    },
  });
  r.service.momo = () => ({
    mainChatId: async () => 'c1',
    cardOf: () => approval,
    answerCard: (...args: unknown[]) => (delivered.push(args), true),
  });
  const p = r.phone('p1');
  // following does not read the cards for MoMo here: put the chat in the phone's follow set directly
  (r.service as any).phones.get('p1').client.follows.add('c1');
  r.state.patch('c1', {});
  await p.send({ id: 'late', t: 1, kind: 'request', method: 'momo.card.answer', params: { cardId: 'm1', rev: 0, key: 'yes' } });
  await settle();
  r.link.removePair('p1');
  release();
  await settle();
  assert.deepEqual(delivered, [], 'a removed phone answered a MoMo card');
});

test('the panel is always served; a phone only until its pair is removed', async () => {
  const r = rig();
  r.phone('p1');
  const client = (r.service as any).phones.get('p1').client;
  assert.equal(r.service.paired(client), true);
  assert.equal(r.service.paired({ kind: 'panel' }), true);
  r.link.removePair('p1');
  assert.equal(r.service.paired(client), false);
  // a new pair under the same id is another client, not the one removed
  r.link.addPair('p1');
  assert.equal(r.service.paired(client), false);
});

test('a message waiting behind a running turn is not sent once the Mac has removed the phone that wrote it', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const r = rig({
    ops: {
      send: async (p: any) => {
        r.calls.push(['send', p.text]);
        if (p.text === 'first') await gate;
        return { warning: null };
      },
    },
  });
  const p = r.phone('p1');
  await p.send({ id: 'a', t: 1, kind: 'request', method: 'chat.send', params: { chatId: 'c1', text: 'first' } });
  await settle();
  await p.send({ id: 'b', t: 1, kind: 'request', method: 'chat.send', params: { chatId: 'c1', text: 'second' } });
  await settle();
  r.link.removePair('p1');
  release();
  await settle();
  assert.deepEqual(
    r.calls.filter((c) => c[0] === 'send').map((c) => c[1]),
    ['first'],
    'a removed phone’s queued message was sent',
  );
});

test('a chat start and a MoMo send already in flight when the Mac removes the phone do not happen', async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const delivered: unknown[] = [];
  const r = rig({
    momo: true,
    ops: {
      usable: async () => {
        await gate;
        return true;
      },
    },
  });
  r.service.momo = () => ({
    mainChatId: async () => {
      await gate;
      return 'c1';
    },
    send: async (...args: unknown[]) => (delivered.push(['send', ...args]), null),
    stop: async (...args: unknown[]) => void delivered.push(['stop', ...args]),
  });
  const p = r.phone('p1');
  await p.send({ id: 'a', t: 1, kind: 'request', method: 'chat.start', params: { harness: 'codex', text: 'go' } });
  await p.send({ id: 'b', t: 1, kind: 'request', method: 'momo.chat.send', params: { id: 'send-0001', text: 'hi' } });
  await p.send({ id: 'c', t: 1, kind: 'request', method: 'momo.chat.stop', params: {} });
  await settle();
  r.link.removePair('p1');
  release();
  await settle();
  assert.deepEqual(delivered, [], 'a removed phone sent to MoMo');
  assert.deepEqual(
    r.calls.filter((c) => c[0] === 'start'),
    [],
    'a removed phone started a chat',
  );
});

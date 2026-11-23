// A machine's chat as Thread is given it (mobile/src/remote/hostChat.ts): the facade that sends reads and writes to the Host, the phone's own outbox, and the switch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { goesDirect, kitQueued, machineQueuedLine, macScreens, threadCards, MACHINE_AWAY } from '../mobile/src/remote/hostChat.ts';
import { PhoneHostError } from '../shared/remote/phoneHost.mjs';
import { waitFor } from './support/waitFor.ts';
import { rig } from './support/phone/host-chat-rig.ts';
import { createDirectHosts } from '../mobile/src/remote/directHosts.ts';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { CARD_ANSWERED } from '../shared/remote/cardAnswered.mjs';

test('the switch is off, and a chat goes direct only with the switch on, a machine the phone is enrolled with and the Mac away', () => {
  const { kit, phones } = rig();
  assert.equal(kit.enabled(), false);
  const ok = { on: true, kit, machineId: 'm1', phones, macAway: true };
  assert.equal(goesDirect(ok), true);
  for (const bad of [
    { on: false },
    { kit: null },
    { machineId: undefined },
    { machineId: 'm2' },
    { phones: undefined },
    { macAway: false },
  ])
    assert.equal(goesDirect({ ...ok, ...bad } as any), false);
  assert.equal(MACHINE_AWAY('Studio'), 'Will send when Studio is back');
});

test('reads and writes of the chat go to the Host; every other request goes to the Mac', async () => {
  const r = rig();
  const snap: any = await r.runtime.request('chat.follow', { chatId: 'c1', items: 50 });
  assert.equal(snap.chatId, 'c1');
  assert.deepEqual(await r.runtime.request('chat.stop', { chatId: 'c1' }), { stopped: true });
  assert.deepEqual(await r.runtime.request('chat.read', { chatId: 'c1', before: 3 }), { rows: [], more: false, omitted: 0 });
  assert.deepEqual(await r.runtime.request('chat.unfollow', { chatId: 'c1' }), { unfollowed: true });
  assert.equal(await r.runtime.request('chat.controls', { chatId: 'c1' }), 'mac:chat.controls');
  assert.equal(r.runtime.direct, 'the-direct');
});

test("a message is queued under the machine, sent with one key, and shown beside the Mac's own queue", async () => {
  const r = rig();
  const id = r.runtime.send('c1', 'hello');
  assert.equal(id, 'id1');
  await waitFor(() => r.sent.length === 1, 'the message to go to the Host');
  assert.equal(r.sent[0].text, 'hello');
  assert.deepEqual(
    r.runtime.snapshot().outbox.map((i: any) => i.id),
    ['mac1'],
  );
  assert.throws(() => r.runtime.send('c1', 'x', ['file']), /not sent to Studio/);
  assert.throws(() => r.runtime.send('c1', 'x', [], [], undefined, ['pic']), /not sent to Studio/);
});

test('a message waits while the machine is away and goes when it answers again; one that did not arrive is sent again under its key', async () => {
  const r = rig({ up: false });
  r.runtime.send('c1', 'later');
  await r.kit.outbox.flush('m1');
  assert.deepEqual(
    r.runtime.snapshot().outbox.map((i: any) => i.id),
    ['mac1', 'id1'],
  );
  assert.equal(r.kit.items()[0].status, 'queued');
  assert.equal(r.sent.length, 0);
  r.kit.flush('other');
  r.setUp(true);
  r.kit.flush('m1');
  await waitFor(() => r.sent.length === 1, 'the message to go once the machine is back');
  assert.equal(r.kit.items().length, 0);
  assert.ok(r.changes() > 0);

  let fail = true;
  const lost = rig({ sendError: () => (fail ? new PhoneHostError('unreachable', 'gone') : null) });
  lost.runtime.send('c1', 'try');
  await waitFor(() => lost.kit.items()[0]?.status === 'queued' && lost.kit.items()[0]?.uncertain, 'the message to wait after a lost path');
  fail = false;
  lost.kit.flush('m1');
  await waitFor(() => lost.sent.length === 1, 'the retry');
  const timed = rig({ sendError: () => new PhoneHostError('timeout', 'slow') });
  timed.runtime.send('c1', 'x');
  await waitFor(() => timed.kit.items()[0]?.uncertain === true, 'a timeout is a lost path too');
});

test("a message the Host refuses says so and can be sent again or cancelled; the Mac's queue answers for its own", async () => {
  let refuse = true;
  const r = rig({ sendError: () => (refuse ? new PhoneHostError('invalid', 'No.') : null) });
  const id = r.runtime.send('c1', 'nope');
  await waitFor(() => r.kit.items()[0]?.status === 'failed', 'a refusal');
  refuse = false;
  assert.equal(r.runtime.retrySend(id), true);
  await waitFor(() => r.sent.length === 1, 'the retry');
  const again = rig({ up: false });
  const queued = again.runtime.send('c1', 'one');
  assert.equal(again.runtime.editSend(queued, 'two'), true);
  assert.equal(again.kit.items()[0].text, 'two');
  assert.equal(again.runtime.cancelSend(queued), true);
  assert.equal(again.runtime.cancelSend('mac1'), true);
  assert.equal(again.runtime.editSend('mac1', 'x'), true);
  assert.equal(again.runtime.retrySend('mac1'), true);
  assert.equal(again.runtime.cancelSend('zzz'), false);
});

test("the Mac's events and the Host's reach the same listener, and each is unsubscribed", async () => {
  const r = rig();
  const heard: any[] = [];
  const off = r.runtime.onEvent((e: any) => heard.push(e));
  r.macFeed[0]({ ev: 'mac' });
  await r.runtime.request('chat.follow', { chatId: 'c1' });
  r.kit.chats.onEvent('m1', { event: 'frame', chatId: 'c1', frame: { t: 'delta', seq: 1, key: 'k', delta: { text: 'x' } } });
  assert.deepEqual(
    heard.map((e) => e.ev ?? e.ev),
    ['mac', 'items.append'],
  );
  off();
  assert.equal(r.macFeed.length, 0);
  r.kit.chats.onEvent('m1', { event: 'frame', chatId: 'c1', frame: { t: 'delta', seq: 2, key: 'k', delta: { text: 'y' } } });
  assert.equal(heard.length, 2);
  let ticks = 0;
  const unsub = r.runtime.subscribe(() => void ticks++);
  unsub();
});

const wire = (requestId: string, cardKind: string, chatId = 'c1') => ({
  chatId,
  epoch: 1,
  requestId,
  cardKind,
  summary: { tool: 'Bash', line: 'run ls' },
  options: [
    { optionId: 'allow', name: 'Allow', kind: 'allow' },
    { optionId: 'deny', name: 'Deny', kind: 'deny' },
  ],
  at: 1,
});

test('a card the Host waits on in this chat is a card row of the thread: a permission is answered there, any other is finished on the machine', async () => {
  const r = rig({ pending: [wire('r1', 'permission'), wire('r2', 'question'), wire('r3', 'permission', 'other')] });
  const snap: any = await r.runtime.request('chat.follow', { chatId: 'c1' });
  const cards = snap.session.cards;
  assert.deepEqual(
    cards.map((c: any) => [c.where, c.kind, c.waitingCopy]),
    [
      ['phone', 'permission', undefined],
      ['mac-only', 'question', 'Answer this on Studio.'],
    ],
  );
  assert.deepEqual(cards[0].choices, [
    { key: 'allow', label: 'Allow' },
    { key: 'deny', label: 'Deny', deny: true },
  ]);
  assert.equal(threadCards([], 'c1', 'Studio').length, 0);
  // a Claude Code chat's card carries the Host's name for it; the Thread follows the chat by the id the Mac lists
  const named = { ...r.cards.list()[0], card: { ...r.cards.list()[0].card, chatId: 'claude:11111111-2222-4333-8444-555555555555' } };
  assert.equal(threadCards([named], 'acp:host-claude:11111111-2222-4333-8444-555555555555', 'Studio').length, 1);
  assert.equal(threadCards([named], 'acp:host-claude:other', 'Studio').length, 0);
  // a card closed by the Host leaves the list
  r.cards.close(r.cards.list()[0].id, { kind: 'closed', line: 'done' });
  assert.equal(threadCards(r.cards.list(), 'c1', 'Studio').length, 1);
  // a refresh that fails still opens the chat
  const down = rig({ refreshFails: true });
  assert.deepEqual(((await down.runtime.request('chat.follow', { chatId: 'c1' })) as any).session.cards, []);
});

test("a card that changes reaches the chat followed, and an answer goes to the Host under the card's own identity", async () => {
  const r = rig({ pending: [wire('r1', 'permission')] });
  const heard: any[] = [];
  const off = r.runtime.onEvent((e: any) => heard.push(e));
  await r.runtime.request('chat.follow', { chatId: 'c1' });
  const id = r.cards.list()[0].id;
  r.cards.sending(id, 'allow');
  assert.equal(heard.at(-1)?.ev, 'cards.changed');
  assert.equal(heard.at(-1).chatId, 'c1');
  assert.deepEqual(await r.runtime.request('card.answer', { chatId: 'c1', cardId: id, rev: 0, key: 'allow' }), { answered: true });
  assert.deepEqual(r.answers, [['m1', 'Studio', id, 'allow']]);
  off();
});

test('an answer the Host refuses is the refusal the Thread reads: answered elsewhere, or the words of the failure', async () => {
  const elsewhere = rig({ pending: [wire('r1', 'permission')], answerError: { code: 'card_answered', message: 'x' } });
  await elsewhere.runtime.request('chat.follow', { chatId: 'c1' });
  await assert.rejects(
    elsewhere.runtime.request('card.answer', { chatId: 'c1', cardId: elsewhere.cards.list()[0].id, key: 'allow' }),
    (e: Error) => e.message === CARD_ANSWERED,
  );
  const other = rig({ pending: [wire('r1', 'permission')], answerError: { code: 'timeout', message: 'The Host did not answer.' } });
  await other.runtime.request('chat.follow', { chatId: 'c1' });
  await assert.rejects(other.runtime.request('card.answer', { chatId: 'c1', cardId: 'x', key: 'allow' }), /did not answer/);
});

test("the kit of a runtime's direct paths names its messages with random ids and takes the Host's lines", () => {
  const direct = createDirectHosts({
    prim: createNodePrimitives(),
    vault: { getHosts: async () => ({}) } as any,
    relayUrl: 'wss://r/v1/ws',
    auth: { relayToken: async () => 'tok' },
    open: () => ({}),
    request: async () => ({}),
    deviceName: () => 'Phone',
  });
  const a = direct.chat.outbox.add({ pairId: 'none', chatId: 'c', text: 'a', attachments: [] });
  const b = direct.chat.outbox.add({ pairId: 'none', chatId: 'c', text: 'b', attachments: [] });
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
  assert.equal(direct.chat.items().length, 2);
  direct.chat.chats.onEvent('m', { event: 'frame', chatId: 'nobody', frame: {} });
});

test('the kit of the direct paths reads the host-chat flag for every chat and tells it what the Mac says', () => {
  const log: string[] = [];
  let on = false;
  const make = (hostChat?: any) =>
    createDirectHosts({
      prim: createNodePrimitives(),
      vault: { getHosts: async () => ({}) } as any,
      relayUrl: 'wss://r/v1/ws',
      auth: { relayToken: async () => 'tok' },
      open: () => ({}),
      request: async () => ({}),
      deviceName: () => 'Phone',
      hostChat,
    });
  let heard = 0;
  const direct = make({
    on: () => on,
    told: (v: boolean, mac?: string) => log.push(`told ${v} ${mac ?? ''}`),
    subscribe: (fn: () => void) => ((heard = 1), fn(), () => undefined),
  });
  assert.equal(heard, 1, 'the flag changing is heard by the screens that follow the paths');
  assert.equal(direct.chat.enabled(), false);
  on = true;
  assert.equal(direct.chat.enabled(), true, 'read each time, not once');
  direct.chat.told(true, 'p1');
  assert.deepEqual(log, ['told true p1']);
  const bare = make();
  assert.equal(bare.chat.enabled(), false, 'no flag: no chat of its own');
  assert.equal(bare.chat.why(), 'off');
  bare.chat.told(true);
});

test('probe asks every enrolled Host and finishes even when one does not answer or the vault cannot be read (#4604)', async () => {
  const make = (vault: any) =>
    createDirectHosts({
      prim: createNodePrimitives(),
      vault,
      relayUrl: 'wss://r/v1/ws',
      auth: { relayToken: async () => 'tok' },
      open: () => ({}),
      request: async () => ({}),
      deviceName: () => 'Phone',
    });
  const direct = make({ getHosts: async () => ({}) });
  const asked: string[] = [];
  direct.phones.records = () => [{ machineId: 'h1' }, { machineId: 'h2' }] as any;
  direct.phones.refresh = async (id: string) => (asked.push(id), id === 'h1');
  const outOfDate: string[] = [];
  direct.chat.chats.sessionEnded = (id: string) => void outOfDate.push(id);
  await direct.probe();
  assert.deepEqual(asked, ['h1', 'h2']);
  assert.deepEqual(outOfDate, ['h1', 'h2'], 'the app was away: each machine’s followed chats are read again (#4858)');
  const broken = make({
    getHosts: async () => {
      throw new Error('vault unreadable');
    },
  });
  await broken.probe();
  assert.deepEqual(broken.phones.records(), []);
});

test("a Thread is given the machine's own runtime only while the switch is on and the Mac is away; otherwise the one it had", async () => {
  const { act, createElement, createRoot } = await import('./support/phone/component-kit.ts');
  const { useHostRuntime } = await import('../mobile/src/remote/useHostRuntime.ts');
  let on = true;
  const r = rig();
  const kit = { ...r.kit, enabled: () => on };
  const base = {
    ...r.base,
    direct: { chat: kit, subscribe: () => () => undefined, phones: { ...r.phones, records: () => [{ machineId: 'm1', name: 'Studio' }] } },
  };
  let seen: any = null;
  function Probe(p: { hostId?: string; away: boolean; runtime: any }) {
    seen = useHostRuntime(p.runtime, p.hostId, p.away);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  const show = (props: any) => act(async () => root.render(createElement(Probe, props)));
  await show({ hostId: 'm1', away: true, runtime: base });
  assert.notEqual(seen.runtime, base);
  assert.equal(seen.offline, false);
  await show({ hostId: 'm1', away: false, runtime: base });
  assert.equal(seen.runtime, base);
  assert.equal(seen.offline, false);
  on = false;
  await show({ hostId: 'm1', away: true, runtime: base });
  assert.equal(seen.runtime, base);
  assert.equal(seen.offline, true);
  await show({ hostId: undefined, away: true, runtime: { ...base, direct: null } });
  assert.equal(seen.offline, true);
  // a machine the phone has no name for is "the machine"
  on = true;
  const nameless = { ...base, direct: { chat: kit, subscribe: () => () => undefined, phones: { ...r.phones, records: () => [] } } };
  await show({ hostId: 'm1', away: true, runtime: nameless });
  assert.throws(() => seen.runtime.send('c', 'x', ['f']), /not sent to the machine/);
  await act(async () => root.unmount());
});

test('what waits for a machine says its name, "the machine" when the phone has none, and kitQueued is this chat on this machine', () => {
  const named = { phones: { records: () => [{ machineId: 'm1', name: 'Studio' }] } } as any;
  assert.equal(machineQueuedLine(named, 'm1'), 'Will send when Studio is back');
  assert.equal(machineQueuedLine(named, 'm9'), 'Will send when the machine is back');
  const items = [
    { id: 'a', pairId: 'm1', chatId: 'c1' },
    { id: 'b', pairId: 'm1', chatId: 'c2' },
    { id: 'c', pairId: 'm2', chatId: 'c1' },
  ];
  assert.deepEqual(
    kitQueued({ items: () => items } as any, 'm1', 'c1').map((i) => i.id),
    ['a'],
  );
});

test('a chat only the machine holds is never asked of the Mac: what the Host cannot do is refused in its name, the surface is none, and any other chat still goes to the Mac (#4859)', async () => {
  const r = rig();
  const begun = r.kit.begin('claude');
  await r.kit.start('m1', begun, { text: 'hello' });
  const mine = begun.chatId;
  // the one the Mac may know, as before
  assert.equal(await r.runtime.request('options.get', { chatId: 'c1' }), 'mac:options.get');
  assert.equal(await r.runtime.request('machine.hello', {}), 'mac:machine.hello', 'a request that names no chat is the Mac’s');
  // the phone's own chat: not the Mac's answer, which is gone or another machine's
  assert.deepEqual(await r.runtime.request('surface.current', { chatId: mine }), {});
  assert.equal(await r.runtime.request('chat.switch', { chatId: 'c1', harness: 'codex' }), 'mac:chat.switch');
  assert.equal(await r.runtime.request('options.set', { chatId: 'c1', value: 'default' }), 'mac:options.set');
  for (const method of ['diff.list', 'file.read', 'chats.pin', 'commands.list', 'steps.thumbnail']) {
    await assert.rejects(
      r.runtime.request(method, { chatId: mine }),
      (e: any) => e.code === 'unsupported' && /Studio/.test(e.message) && /from the phone yet/.test(e.message),
      method,
    );
  }
});

test('a card the Host raises while the chat is open reaches the thread without reopening it; a burst of card events reads the cards once, then once more (#4857)', async () => {
  const pending: any[] = [];
  const r = rig({ pending });
  const heard: any[] = [];
  const off = r.runtime.onEvent((e: any) => heard.push(e));
  await r.runtime.request('chat.follow', { chatId: 'c1' });
  assert.deepEqual(r.cards.list(), []);
  const item = (rev: number, event: object) => ({
    event: 'frame',
    chatId: 'c1',
    frame: { t: 'durable', seq: rev, rev, item: { t: 'event', family: 'acp', event: { turnId: 't1', ...event } } },
  });
  pending.push(wire('r1', 'permission'));
  r.kit.chats.onEvent('m1', item(1, { kind: 'permission', requestId: 'r1', toolCall: { title: 'Write', kind: 'edit' }, options: [] }));
  await waitFor(() => heard.some((e) => e.ev === 'cards.changed' && e.cards?.length === 1), 'the card to reach the open chat');
  // a burst while one read is out: one read now, one more after it
  const read = r.phones.refresh;
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  r.phones.refresh = async (m: string) => (reads++, await held, read(m));
  r.kit.chats.onEvent('m1', item(2, { kind: 'permissionCancelled', requestId: 'r1' }));
  r.kit.chats.onEvent('m1', item(3, { kind: 'permission', requestId: 'r2', toolCall: { title: 'Write', kind: 'edit' }, options: [] }));
  r.kit.chats.onEvent('m1', item(4, { kind: 'turnEnd', stopReason: 'end_turn' }));
  assert.equal(reads, 1, 'one read at a time');
  release();
  await waitFor(() => reads === 2, 'the one more read');
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.equal(reads, 2, 'not one per item');
  off();
});

test('Changes and Terminal are the Mac’s screens: a chat only the machine holds is offered neither, any other keeps them (#4859)', async () => {
  const r = rig();
  const begun = r.kit.begin('claude');
  await r.kit.start('m1', begun, { text: 'hello' });
  const base: any = { direct: { chat: r.kit } };
  const screens = { review: () => undefined, terminal: () => undefined };
  assert.deepEqual(macScreens(base, 'm1', begun.chatId, screens), {});
  assert.equal(macScreens(base, 'm1', 'c1', screens), screens, 'a chat the Mac may know keeps them');
  assert.equal(macScreens(base, undefined, begun.chatId, screens), screens, 'a chat of the Mac itself');
  assert.equal(macScreens({} as any, 'm1', begun.chatId, screens), screens, 'a phone with no direct paths');
});

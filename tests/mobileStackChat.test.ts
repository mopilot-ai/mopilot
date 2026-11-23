// Mobile Remote end to end, scenario 2: start a chat from the phone, follow it, see the streamed items, approve a card, Stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startRelay, startMac, startPhone, until, client, type Relay } from './support/mobileStack.ts';
import { CARD_CHOICES } from './support/remote-kit.ts';

/** A Mac and a phone paired and connected. */
async function online(relay: Relay, o: Parameters<typeof startMac>[1] = {}) {
  const mac = await startMac(relay, o);
  const phone = await startPhone(relay);
  await phone.pair(await mac.qr());
  await until(() => phone.snap().pairs.length === 1 && phone.snap().safetyNumber === null, 'the pair to commit');
  await phone.runtime.connect(phone.snap().pairs[0].pairId);
  return { mac, phone };
}

const codex = {
  turn: (method: string, status: string) => ({ method, params: { threadId: 'new-chat', turn: { id: 't1', status } } }),
  item: (method: string, id: string, text: string) => ({
    method,
    params: {
      threadId: 'new-chat',
      turnId: 't1',
      item: { type: 'agentMessage', id, text, phase: null, memoryCitation: null, delivery: null },
    },
  }),
  delta: (id: string, delta: string) => ({
    method: 'item/agentMessage/delta',
    params: { threadId: 'new-chat', turnId: 't1', itemId: id, delta },
  }),
};

/** What the phone holds after applying the events a chat's follower gets. */
function view(events: any[]) {
  const items: any[] = [];
  for (const e of events) {
    if (e.ev === 'items.append') items.push(...e.items.map((i: any) => ({ ...i })));
    else if (e.ev === 'items.replace') for (const i of e.items) items[items.findIndex((x) => x.id === i.id)] = { ...i };
    else if (e.ev === 'items.delta') items.find((x) => x.id === e.itemId)[e.field ?? 'text'] += e.text;
  }
  return items;
}

test('start from the phone with its client, follow, stream a reply, approve a card, stop', async () => {
  const relay = await startRelay();
  const { mac, phone } = await online(relay);
  const request = client.ownedRequest(phone.runtime);

  // the phone's own start screen code reads the menus and starts the chat
  const menus = await client.loadStart(request);
  assert.deepEqual(menus.harnesses, [{ id: 'codex', label: 'Codex' }]);
  const { chatId } = await client.startChat(request, {
    harness: 'codex',
    text: 'list the files',
    projectId: null,
    model: null,
    effort: null,
    permission: null,
    account: null,
    worktree: false,
    startId: '11111111-1111-4111-8111-111111111111',
    attachments: [],
  });
  assert.equal(chatId, 'new-chat');
  assert.equal(mac.calls.find((c) => c[0] === 'start')![1].text, 'list the files');

  mac.known.add(chatId);
  const snap = await phone.ask('chat.follow', { chatId });
  assert.equal(snap.chatId, chatId);

  // a streamed reply and a tool-less turn, as the controller would hand them over
  mac.emit('codex', codex.turn('turn/started', 'inProgress'));
  mac.emit('codex', codex.item('item/started', 'm', ''));
  mac.emit('codex', codex.delta('m', 'Hel'));
  mac.emit('codex', codex.delta('m', 'lo'));
  mac.emit('codex', codex.item('item/completed', 'm', 'Hello'));
  await until(() => view(phone.events).find((i) => i.type === 'agentMessage')?.text === 'Hello', 'the streamed reply');
  const reply = view(phone.events).find((i) => i.type === 'agentMessage');
  assert.equal(reply.text, 'Hello');
  assert.equal(phone.eventsOf('turn.state')[0].started, true);
  // events carry the order the Mac made them in
  const seqs = phone.events.filter((e) => e.feedSeq !== undefined).map((e) => e.feedSeq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );

  // a card goes up in the chat and fills in separately from the state patch
  mac.cards[chatId] = [{ id: 'a1', title: 'Run this command?', detail: 'ls', choices: CARD_CHOICES, version: 'v1' }];
  mac.state.patch(chatId, { approvals: [{ id: 'a1', method: 'x', params: {} }] });
  await until(() => phone.eventsOf('cards.changed').some((e) => e.chatId === chatId), 'the ready card');
  const patch = phone.eventsOf('cards.changed').find((e) => e.chatId === chatId)!;
  assert.equal(patch.cards[0].id, 'a1');
  assert.deepEqual(await phone.ask('card.answer', { chatId, cardId: 'a1', rev: patch.rev, key: 'once' }), { answered: true });
  assert.deepEqual(mac.calls.find((c) => c[0] === 'answer')![1], { chatId, approvalId: 'a1', choice: 'once', version: 'v1' });
  // a second answer to the same card is refused
  await assert.rejects(phone.ask('card.answer', { chatId, cardId: 'a1', rev: patch.rev, key: 'once' }), /already answered/);

  // Stop reaches the harness
  assert.deepEqual(await phone.ask('chat.stop', { chatId }), { stopped: true });
  assert.deepEqual(
    mac.calls.find((c) => c[0] === 'stop'),
    ['stop', chatId],
  );
});

test('a phone that does not follow a chat hears nothing of it, and an unknown chat is gone', async () => {
  const relay = await startRelay();
  const { mac, phone } = await online(relay);
  mac.emit('codex', codex.turn('turn/started', 'inProgress'));
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(phone.eventsOf('turn.state').length, 0);
  await assert.rejects(phone.ask('chat.follow', { chatId: 'nope' }), /isn't in MoPilot/);
});

test('a tool item whose output is larger than one frame still reaches the phone, shortened, and later events for it follow', async () => {
  const relay = await startRelay();
  const { mac, phone } = await online(relay);
  mac.known.add('new-chat');
  await phone.ask('chat.follow', { chatId: 'new-chat' });
  const cmd = (status: string, output: string | null) => ({
    method: status === 'inProgress' ? 'item/started' : 'item/completed',
    params: {
      threadId: 'new-chat',
      turnId: 't1',
      item: {
        type: 'commandExecution',
        id: 'x',
        command: 'npm test',
        cwd: '',
        processId: null,
        source: 'agent',
        status,
        commandActions: [],
        aggregatedOutput: output,
        exitCode: output === null ? null : 0,
        durationMs: null,
        pluginId: null,
        scriptPath: null,
      },
    },
  });
  mac.emit('codex', codex.turn('turn/started', 'inProgress'));
  mac.emit('codex', cmd('inProgress', null));
  mac.emit('codex', cmd('completed', 'line of build log\n'.repeat(30_000)));
  mac.emit('codex', codex.item('item/started', 'after', 'done'));
  await until(() => view(phone.events).some((i) => i.id === 'after'), 'the item after the large one');
  const tool = view(phone.events).find((i) => i.id === 'x');
  assert.equal(tool.status, 'completed', 'the phone learns the command finished');
  assert.ok(String(tool.aggregatedOutput).startsWith('line of build log'), 'with the start of its output');
  assert.ok(String(tool.aggregatedOutput).length < 200_000);
});

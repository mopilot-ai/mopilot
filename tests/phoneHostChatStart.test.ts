// Starting a chat on a machine from the phone (mobile/src/remote/hostChat.ts): named for its agent the way the Mac names one, started once under one key, launched at once with its first message sending, and Not sent with Retry when the machine refuses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostChatKit, uuidOf } from '../mobile/src/remote/hostChat.ts';
import { rig } from './support/phone/host-chat-rig.ts';
import { waitFor } from './support/waitFor.ts';

test('a new chat is named for its agent the way the Mac names one, started once under one key, and remembered as running on the machine', async () => {
  const r = rig();
  let n = 0;
  const hex = () => (++n).toString(16).padStart(32, 'a');
  let heard = 0;
  const kit = createHostChatKit({ phones: () => r.phones, cards: r.cards, newId: hex, now: () => 1000 + n, changed: () => void heard++ });
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
  const claude = kit.begin('claude');
  assert.match(claude.chatId, new RegExp(`^acp:host-claude:${uuid.source}`));
  assert.match(kit.begin('codex').chatId, new RegExp(`^acp:host-codex:${uuid.source}`));
  assert.match(kit.begin('gemini').chatId, new RegExp(`^acp:gemini:${uuid.source}`));
  assert.notEqual(kit.begin('claude').chatId, claude.chatId);
  const id = await kit.start('m1', claude, { text: ' fix the build\nnow ', cwd: '/srv/app' });
  assert.equal(id, claude.chatId);
  const sent = r.sent.at(-1);
  assert.deepEqual(
    [sent.chatId, sent.harness, sent.text, sent.cwd, sent.human, sent.epoch],
    [`claude:${claude.chatId.slice('acp:host-claude:'.length)}`, 'claude', ' fix the build\nnow ', '/srv/app', true, 0],
    'the Host is told the chat its own way',
  );
  assert.match(sent.key, /^phone-/);
  // a basic agent is named for the Host as acp:<agent>, and a start with no folder says none
  const gem = kit.begin('gemini');
  await kit.start('m1', gem, { text: 'hi' });
  assert.deepEqual([r.sent.at(-1).harness, 'cwd' in r.sent.at(-1), r.sent.at(-1).chatId], ['acp:gemini', false, gem.chatId]);
  // a start that is tried again is the same request
  await kit.start('m1', gem, { text: 'hi' });
  assert.equal(r.sent.at(-1).key, r.sent.at(-2).key);
  assert.equal(kit.hostOf(claude.chatId), 'm1');
  assert.equal(kit.hostOf('other'), undefined);
  assert.deepEqual(
    kit.startedOn('m1').map((c) => [c.chatId === gem.chatId ? 'gem' : 'claude', c.title]),
    [
      ['gem', 'hi'],
      ['claude', 'fix the build'],
    ],
    'newest first, titled by the first line',
  );
  assert.deepEqual(kit.startedOn('m2'), []);
  assert.ok(heard >= 3, 'the screens are told');
  assert.match(uuidOf('0'.repeat(32)), /^0{8}-0{4}-40{3}-80{3}-0{12}$/);
  assert.match(uuidOf('3'.repeat(32)), /-b3{3}-/);
});

test('launch returns at once with the first message sending, drops it when the machine took it, and a refusal is Not sent: Retry is the same start', async () => {
  let waiter: (() => void) | null = null;
  const release = async () => {
    await waitFor(() => waiter !== null, 'the start to reach the machine');
    const go = waiter!;
    waiter = null;
    go();
  };
  let refuse: Error | null = null;
  const r = rig({
    start: async () => {
      await new Promise<void>((resolve) => (waiter = resolve));
      if (refuse) throw refuse;
    },
  });
  let n = 0;
  const kit = createHostChatKit({
    phones: () => r.phones,
    cards: r.cards,
    newId: () => (++n).toString(16).padStart(32, 'b'),
    changed: () => undefined,
  });
  const begun = kit.begin('codex');
  const id = kit.launch('m1', begun, { text: ' build it\nnow ', cwd: '/srv' });
  assert.equal(id, begun.chatId, 'the chat is known at once');
  assert.equal(kit.hostOf(id), 'm1');
  assert.equal(kit.titleOf(id), 'build it', 'called what it was asked until the machine names it');
  assert.deepEqual(
    kit.items().map((i) => [i.id, i.chatId, i.text.trim(), i.status]),
    [[begun.startId, id, 'build it\nnow', 'sending']],
    'its first message shows, sending',
  );
  refuse = Object.assign(new Error('Sign in to Codex on Studio.'), { code: 'harness_not_configured' });
  await release();
  await waitFor(() => kit.items()[0]?.status === 'failed', 'the refusal');
  assert.equal(kit.items()[0].error, 'Sign in to Codex on Studio.');
  const keyOf = () => r.sent.filter((p: any) => p.chatId).length;
  assert.equal(kit.starts.retry('nobody'), false);
  assert.equal(kit.starts.retry(begun.startId), true, 'Retry starts it again');
  assert.equal(kit.items()[0].status, 'sending');
  refuse = null;
  await release();
  await waitFor(() => kit.items().length === 0, 'the machine to take it');
  assert.equal(keyOf(), 1, 'taken once');
  assert.equal(kit.startedOn('m1').length, 1);
  // a refused start can be dropped; one that is not refused cannot
  const second = kit.begin('codex');
  kit.launch('m1', second, { text: 'again' });
  assert.equal(kit.starts.cancel(second.startId), false, 'one in flight is not cancelled');
  refuse = 'No.' as unknown as Error;
  await release();
  await waitFor(() => kit.items()[0]?.status === 'failed', 'the second refusal');
  assert.equal(kit.items()[0].error, 'No.', 'a refusal that is plain words is shown as they are');
  assert.equal(kit.starts.cancel(second.startId), true);
  assert.equal(kit.items().length, 0);
});

test('a chat launched on an agent that is not built in is known by its ACP name, so its controls can move it (#4859)', async () => {
  const r = rig();
  const begun = r.kit.begin('gemini');
  r.kit.launch('m1', begun, { text: 'hello' });
  assert.equal(r.kit.harnessOf(begun.chatId), 'acp:gemini');
  const built = r.kit.begin('codex');
  r.kit.launch('m1', built, { text: 'hello' });
  assert.equal(r.kit.harnessOf(built.chatId), 'codex');
  assert.equal(r.kit.harnessOf('nobody'), undefined);
});

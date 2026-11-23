// The chats the phone starts on a machine outlive the app (#4884): kept in the sealed vault once the Host took them, put back when the app starts, gone with the machine or the account.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHostChatKit } from '../mobile/src/remote/hostChat.ts';
import { createDirectHosts } from '../mobile/src/remote/directHosts.ts';
import { createPhoneVault } from '../shared/remote/phoneVault.mjs';
import { createNodePrimitives } from '../shared/remote/nodePrimitives.mjs';
import { prim } from './support/phonePairingFixture.ts';
import { rig } from './support/phone/host-chat-rig.ts';
import { waitFor } from './support/waitFor.ts';

/** One stored vault row that a new run of the app opens again. */
function stored() {
  let row: string | null = null;
  let key: string | null = null;
  let queue = Promise.resolve();
  const storage = {
    key: { get: async () => key, set: async (v: string) => void (key = v) },
    transaction: async (fn: any) => {
      const result = queue.then(async () => {
        let next = row;
        const value = await fn({ read: async () => row, write: async (v: string) => void (next = v) });
        row = next;
        return value;
      });
      queue = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
  return () => createPhoneVault({ prim, ...storage });
}

/** The direct paths of one run of the app over a vault, with the machines it is enrolled with. */
function run(vault: any, machines: string[]) {
  const direct = createDirectHosts({
    prim: createNodePrimitives(),
    vault,
    relayUrl: 'wss://r/v1/ws',
    auth: { relayToken: async () => 'tok' },
    open: () => ({}),
    request: async () => ({}),
    deviceName: () => 'Phone',
  });
  direct.phones.records = () => machines.map((machineId) => ({ machineId })) as any;
  direct.phones.refresh = async () => true;
  direct.chat.chats.start = (async () => ({})) as any;
  return direct;
}

test('a chat started on a machine is there again after the app starts, with its title, agent and machine, until the machine is forgotten (#4884)', async () => {
  const open = stored();
  const first = run(open(), ['m1', 'm2']);
  await first.probe();
  const claude = first.chat.begin('claude');
  const codex = first.chat.begin('codex');
  await first.chat.start('m1', claude, { text: 'first line\nmore' });
  await first.chat.start('m2', codex, { text: 'on the other machine' });
  await waitFor(async () => Object.keys(await open().getStarted()).length === 2);

  // a cold start: new objects over the same sealed state
  const second = run(open(), ['m1', 'm2']);
  assert.deepEqual(second.chat.startedOn('m1'), [], 'nothing before the machines are read');
  await second.probe();
  assert.deepEqual(
    second.chat.startedOn('m1').map((c) => [c.chatId, c.machineId, c.title, c.harness]),
    [[claude.chatId, 'm1', 'first line', 'claude']],
  );
  assert.equal(second.chat.hostOf(codex.chatId), 'm2', 'the chat opens on the machine it runs on');
  assert.equal(second.chat.titleOf(claude.chatId), 'first line');

  // giving a machine's direct access up drops its chats at once, not at the next start; another machine's stay
  await second.phones.forget('m1');
  assert.deepEqual([second.chat.hostOf(claude.chatId), second.chat.hostOf(codex.chatId)], [undefined, 'm2']);

  // a machine this phone no longer has is not shown, and forgetting it forgets its chats
  const third = run(open(), ['m1']);
  await third.probe();
  assert.equal(third.chat.hostOf(codex.chatId), undefined);
  await open().removeHost('m1');
  assert.deepEqual(Object.keys(await open().getStarted()), ['m2']);
  const fourth = run(open(), ['m1', 'm2']);
  await fourth.probe();
  assert.deepEqual(fourth.chat.startedOn('m1'), []);
});

test("the vault keeps a machine's chats apart, replaces them and drops them with the account", async () => {
  const open = stored();
  const v = open();
  assert.deepEqual(await v.getStarted(), {});
  await v.setAccount({ user: { id: 'one' }, deviceId: 'phone_1234' });
  await v.setStarted('m1', [{ chatId: 'a' }]);
  await v.setStarted('m2', [{ chatId: 'b' }]);
  await v.setStarted('m1', [{ chatId: 'c' }]);
  assert.deepEqual(await open().getStarted(), { m1: [{ chatId: 'c' }], m2: [{ chatId: 'b' }] });
  await v.setStarted('m2', []);
  assert.deepEqual(await open().getStarted(), { m1: [{ chatId: 'c' }] });
  await v.removeHost('nobody');
  assert.deepEqual(await open().getStarted(), { m1: [{ chatId: 'c' }] }, 'a machine it never knew changes nothing');
  await v.setAccount({ user: { id: 'one' }, deviceId: 'phone_1234' });
  assert.deepEqual(await open().getStarted(), { m1: [{ chatId: 'c' }] }, 'the same account keeps them');
  await v.setAccount({ user: { id: 'two' }, deviceId: 'phone_5678' });
  assert.deepEqual(await open().getStarted(), {}, "another account's chats are not this one's");
});

/** A kit over a fake store, and what it was asked to save. */
function kept(o: { load?: () => Promise<Record<string, unknown>>; save?: (m: string, c: any[]) => Promise<unknown> } = {}) {
  let refuse = false;
  const r = rig({
    start: () => {
      if (refuse) throw new Error('no');
    },
  });
  const saves: [string, any[]][] = [];
  let n = 0;
  const kit = createHostChatKit({
    phones: () => r.phones,
    cards: r.cards,
    newId: () => (++n).toString(16).padStart(32, 'a'),
    now: () => 1000 + n,
    changed: () => undefined,
    store: {
      load: o.load ?? (async () => ({})),
      save: async (m, c) => {
        saves.push([m, c]);
        return o.save?.(m, c);
      },
    },
  });
  return { kit, saves, phones: r.phones, refuse: (v: boolean) => void (refuse = v) };
}

const entry = (chatId: string, machineId = 'm1', at = 1) => ({ chatId, machineId, title: chatId, at, harness: 'claude' });

test('only a start the Host took is kept, and one started before the saved chats were read is written with them, the chat known now winning', async () => {
  const disk: Record<string, unknown> = {};
  const { kit, saves, refuse } = kept({ load: async () => disk });
  const begun = kit.begin('claude');
  disk.m1 = [entry('old', 'm1', 5), { ...entry(begun.chatId, 'm1', 6), title: 'stale' }];
  await kit.start('m1', begun, { text: 'early' });
  assert.equal(saves.length, 0, 'nothing is written over what was kept before it is read');
  await kit.restore(['m1']);
  await waitFor(async () => saves.length === 1);
  assert.deepEqual(saves[0][1].map((c) => c.title).sort(), ['early', 'old']);
  // a start the Host refuses is not kept
  refuse(true);
  const refused = kit.begin('claude');
  assert.equal(kit.launch('m1', refused, { text: 'refused' }), refused.chatId);
  await waitFor(async () => kit.items().some((i) => i.status === 'failed'));
  assert.equal(saves.length, 1);
});

test('what was kept is read once: a chat known now wins, odd entries and unknown machines are left, a list cut to the newest is written back', async () => {
  const many = Array.from({ length: 101 }, (_, i) => entry(`c${i}`, 'm1', i));
  const { kit, saves } = kept({
    load: async () => ({
      m1: [
        entry('known', 'm1', 9),
        ...many,
        { chatId: 1 },
        null,
        entry('other', 'm2'),
        { ...entry('t'), title: 3 },
        { ...entry('h'), harness: 7 },
      ],
      m2: 'not a list',
      m3: [entry('gone', 'm3')],
    }),
  });
  await kit.restore(['m1', 'm2']);
  const ids = kit.startedOn('m1').map((c) => c.chatId);
  assert.ok(ids.includes('known') && ids.includes('c100'));
  assert.ok(!ids.includes('other') && !ids.includes('t') && !ids.includes('a') && !ids.includes('h'), 'odd entries are left out');
  assert.equal(kit.hostOf('gone'), undefined);
  assert.deepEqual(kit.startedOn('m2'), []);
  await waitFor(async () => saves.length === 1);
  assert.equal(saves[0][0], 'm1');
  assert.equal(saves[0][1].length, 100, 'the newest hundred are kept');
  assert.deepEqual(
    [saves[0][1][0].chatId, saves[0][1].some((c) => c.chatId === 'known'), saves[0][1].some((c) => c.chatId === 'c0')],
    ['c100', true, false],
    'newest first, the oldest cut',
  );
});

test('a vault that cannot be read starts the list empty, one that cannot be written leaves the chat known, and a kit with no store keeps nothing', async () => {
  const broken = kept({
    load: async () => {
      throw new Error('vault unreadable');
    },
    save: async () => {
      throw new Error('disk full');
    },
  });
  await broken.kit.restore(['m1']);
  assert.deepEqual(broken.kit.startedOn('m1'), []);
  const begun = broken.kit.begin('claude');
  await broken.kit.start('m1', begun, { text: 'hi' });
  await waitFor(async () => broken.saves.length === 1);
  assert.equal(broken.kit.hostOf(begun.chatId), 'm1', 'the app still knows it until it closes');
  // the next change is written again after a failed one
  await broken.kit.start('m1', broken.kit.begin('codex'), { text: 'again' });
  await waitFor(async () => broken.saves.length === 2);

  const r = rig();
  const bare = createHostChatKit({ phones: () => r.phones, cards: r.cards, newId: () => 'a'.repeat(32), changed: () => undefined });
  await bare.restore(['m1']);
  await bare.start('m1', bare.begin('claude'), { text: 'hi' });
  assert.equal(bare.startedOn('m1').length, 1);
});

/** A Host that lists `rows` (or answers as given), over the rig's phones. */
const lists = (phones: any, o: { rows?: unknown; feature?: boolean; fail?: boolean } = {}) => {
  const asked: unknown[] = [];
  phones.session = async () => {
    if (o.fail) throw new Error('away');
    return {
      supportsChatList: () => o.feature ?? true,
      chats: async (p: unknown) => (asked.push(p), { chats: o.rows }),
    };
  };
  return asked;
};
const row = (chatId: string, over: object = {}) => ({ chatId, title: `t-${chatId}`, harness: 'claude', updatedAt: 5000, ...over });

test('the Host’s list becomes the phone’s list for that machine: its rows in app ids, what it no longer holds gone, what is being started kept (#4884)', async () => {
  const { kit, saves, phones } = kept({
    load: async () => ({ m1: [entry('acp:host-claude:gone', 'm1', 1), entry('acp:host-claude:kept', 'm1', 2)] }),
  });
  await kit.restore(['m1']);
  const asked = lists(phones, {
    rows: [
      row('claude:kept', { title: '' }),
      row('0b2f', { harness: 'codex', title: 'Codex one' }),
      row('acp:kimi:7', { harness: 'acp:kimi' }),
      { chatId: 3 },
      null,
      row('bad-time', { updatedAt: 'x' }),
    ],
  });
  // a chat being started is not on the Host's list yet; a chat started after the list was asked for either
  const begun = kit.begin('claude');
  kit.launch('m1', begun, { text: 'in flight' });
  assert.equal(await kit.sync('m1'), true);
  assert.deepEqual(asked, [{ limit: 200 }]);
  const listed = Object.fromEntries(kit.startedOn('m1').map((c) => [c.chatId, [c.title, c.harness, c.at]]));
  assert.deepEqual(
    listed['acp:host-claude:kept'],
    ['acp:host-claude:kept', 'claude', 5000],
    'an empty Host title keeps the one the phone made',
  );
  assert.deepEqual(listed['acp:host-codex:0b2f'], ['Codex one', 'codex', 5000], 'a bare Host id is a Codex chat');
  assert.deepEqual(listed['acp:kimi:7'], ['t-acp:kimi:7', 'acp:kimi', 5000]);
  assert.equal(listed['acp:host-claude:gone'], undefined, 'a chat the Host no longer holds is gone');
  assert.ok(listed[begun.chatId], 'a chat still being started stays');
  assert.equal(Object.keys(listed).length, 4, 'malformed rows are left out');
  await waitFor(async () => saves.some(([, c]) => c.some((x) => x.chatId === 'acp:kimi:7')));
  assert.equal(saves.at(-1)?.[0], 'm1', 'and the list is kept for the next start');
});

test('a Host that cannot list, does not answer or answers oddly leaves the phone’s list as it was', async () => {
  const { kit, phones } = kept({ load: async () => ({ m1: [entry('acp:host-claude:mine', 'm1', 1)] }) });
  await kit.restore(['m1']);
  for (const o of [{ feature: false, rows: [] }, { fail: true }, { rows: undefined }]) {
    lists(phones, o);
    assert.equal(await kit.sync('m1'), false);
    assert.deepEqual(
      kit.startedOn('m1').map((c) => c.chatId),
      ['acp:host-claude:mine'],
    );
  }
  lists(phones, { rows: [] });
  assert.equal(await kit.sync('m1'), true);
  assert.deepEqual(kit.startedOn('m1'), [], 'a Host that answers an empty list holds none');
});

test('after a reinstall the Host’s list brings the chats back with the Mac off; a probe asks only machines that answered (#4884)', async () => {
  const direct = run(stored()(), ['m1', 'm2']);
  const asked: string[] = [];
  direct.phones.refresh = async (id: string) => id === 'm1';
  (direct.phones as any).session = async (id: string) => ({
    supportsChatList: () => true,
    chats: async () => (asked.push(id), { chats: [row('claude:from-host', { title: 'Back again' })] }),
  });
  await direct.probe();
  assert.deepEqual(asked, ['m1']);
  assert.deepEqual(
    direct.chat.startedOn('m1').map((c) => [c.chatId, c.title]),
    [['acp:host-claude:from-host', 'Back again']],
  );
  assert.equal(direct.chat.hostOf('acp:host-claude:from-host'), 'm1', 'it opens through the machine');
  assert.deepEqual(direct.chat.startedOn('m2'), []);
});

test('an answer as long as the Host answers at most may be cut: nothing the phone knows is dropped for it (#4884)', async () => {
  const { kit, phones } = kept({ load: async () => ({ m1: [entry('acp:host-claude:old', 'm1', 1)] }) });
  await kit.restore(['m1']);
  const full = Array.from({ length: 200 }, (_, i) => row(`claude:n${i}`));
  lists(phones, { rows: full });
  assert.equal(await kit.sync('m1'), true);
  assert.ok(kit.hostOf('acp:host-claude:old'), 'an older chat beyond the bound is still the phone’s');
  assert.equal(kit.startedOn('m1').length, 201);
  lists(phones, { rows: full.slice(1) });
  await kit.sync('m1');
  assert.equal(kit.hostOf('acp:host-claude:old'), undefined, 'a shorter answer is the whole list');
});

test('a machine that first answers in a session has its chats read without a probe, once; a new session reads them again (#4894)', async () => {
  const direct = run(stored()(), ['m1', 'm2']);
  const asked: string[] = [];
  const up = new Set<string>();
  (direct.phones as any).link = (id: string) => (up.has(id) ? 'up' : 'unknown');
  (direct.phones as any).session = async (id: string) => ({
    supportsChatList: () => id !== 'm2',
    chats: async () => (asked.push(id), { chats: [row(`claude:on-${id}`)] }),
  });
  const touch = () => direct.cards.setPending('k', []);
  touch();
  assert.equal(asked.length, 0, 'nothing is read while the machines have not answered');
  up.add('m1');
  up.add('m2');
  touch();
  await waitFor(async () => direct.chat.hostOf('acp:host-claude:on-m1') === 'm1');
  touch();
  touch();
  assert.deepEqual(asked.sort(), ['m1'], 'once for a machine that lists; a machine that cannot is not asked again by every change');
  assert.equal(direct.chat.hostOf('acp:host-claude:on-m2'), undefined);
  // the Host went away and came back: it may have been updated, so it is read again
  direct.sessionEnded('m1');
  direct.sessionEnded('m2');
  touch();
  await waitFor(async () => asked.filter((id) => id === 'm1').length === 2);
  // access given up and enrolled again in the same run (no reinstall): the machine's list is read again without a probe
  const before = asked.filter((id) => id === 'm1').length;
  await direct.phones.forget('m1');
  touch();
  await waitFor(async () => asked.filter((id) => id === 'm1').length === before + 1);

  // a probe while a read is in flight shares it
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => (open = resolve));
  (direct.phones as any).session = async (id: string) => ({
    supportsChatList: () => true,
    chats: async () => (await gate, asked.push(id), { chats: [] }),
  });
  direct.sessionEnded('m1');
  touch();
  direct.phones.refresh = async () => true;
  const probing = direct.probe();
  await new Promise((resolve) => setTimeout(resolve, 10));
  open();
  await probing;
  assert.equal(asked.filter((id) => id === 'm1').length, before + 2, 'the change and the probe read it once between them');
});

test('a Host row with no title and nothing the phone made leaves the title empty', async () => {
  const { kit, phones } = kept();
  await kit.restore(['m1']);
  lists(phones, { rows: [row('claude:untitled', { title: '' })] });
  assert.equal(await kit.sync('m1'), true);
  assert.equal(kit.titleOf('acp:host-claude:untitled'), '');
});

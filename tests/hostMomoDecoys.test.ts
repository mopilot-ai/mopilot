// The ids of MoMo's chats and the chats made for callers that may not see them (host/src/momoChats.mjs, host/src/chatVeil.mjs): the form of MoMo's ids is one no generator of the product makes and a client's id of that form is refused; a chat made for another caller is private to its connection, bounded, and removed with it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore: plain ESM without declarations
import { createChatVeil, MAX_DECOYS } from '../host/src/chatVeil.mjs';
// @ts-ignore
import { MOMO_FORM } from '../host/src/momoChats.mjs';
import { servedHost } from './support/hostClientsWorld.ts';
import { world } from './support/host/momoVeilKit.ts';

/** A version 7 uuid, as Codex's threads have: the time in the first 48 bits, then random ones. */
const v7 = () => {
  const b = crypto.getRandomValues(new Uint8Array(16));
  const ms = BigInt(Date.now());
  for (let i = 0; i < 6; i++) b[i] = Number((ms >> BigInt(8 * (5 - i))) & 0xffn);
  b[6] = (b[6] & 0x0f) | 0x70;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

test('the form of MoMo’s ids is one no generator of the product makes: version 8, which neither version 4 (the app, the Host, the phone, Claude Code) nor version 7 (Codex) can be', () => {
  // every id generator found in electron/, host/, shared/, src/ and mobile/src is crypto.randomUUID (version 4), or Swift's UUID() (4);
  // Claude Code's own session ids are 4 and Codex's thread ids 7: the version nibble is fixed by the standard each follows
  for (let i = 0; i < 200_000; i++) {
    const id = crypto.randomUUID();
    assert.equal(MOMO_FORM.test(id) || MOMO_FORM.test(`claude:${id}`) || MOMO_FORM.test(`acp:kimi:${id}`), false);
  }
  for (let i = 0; i < 50_000; i++) assert.equal(MOMO_FORM.test(v7()), false);
  // the same ids with the marker's last group still are not: the version is what keeps them apart
  for (let i = 0; i < 1000; i++) assert.equal(MOMO_FORM.test(crypto.randomUUID().replace(/[0-9a-f]{4}([0-9a-f]{8})$/, 'c0de$1')), false);
  assert.equal(MOMO_FORM.test('claude:12345678-1234-8234-8234-c0de12345678'), true);
});

test('a client cannot make an id of MoMo’s form: it is refused when it would create a chat, whoever asks; the Host’s own chat is still messaged', async (t) => {
  const w = await world(t);
  const host = await servedHost(t, { momo: w.home });
  const { conn } = await host.paired('mac', 'Mac');
  const made = `claude:${crypto
    .randomUUID()
    .replace(/^([0-9a-f]{8}-[0-9a-f]{4}-)[0-9a-f]/, '$18')
    .replace(/[0-9a-f]{4}([0-9a-f]{8})$/, 'c0de$1')}`;
  assert.match(made, MOMO_FORM);
  const plain = { chatId: `claude:${crypto.randomUUID()}`, epoch: 0, key: 'key-00000001', text: 'hi', cwd: w.dir };
  assert.ok(await conn.request('chat.send', plain), 'an ordinary new chat is sent to');
  for (const [method, params] of [
    ['chat.send', { ...plain, chatId: made, key: 'key-00000002' }],
    ['chat.start', { ...plain, chatId: made, key: 'key-00000003', harness: 'claude', projectId: null }],
  ] as const)
    for (const client of [conn, host.line()])
      await assert.rejects(
        client.request(method, params),
        (e: any) => ['invalid', 'unknown_client'].includes(e.code) && (e.code === 'unknown_client' || /cannot be used/.test(e.message)),
        method,
      );
  // a chat the Host made is another matter: the registry and the record know it
  assert.ok(await conn.request('chat.send', { ...plain, chatId: w.M, key: 'key-00000004' }));
  assert.equal(w.home.chats!.rules.forged(w.M), false);
  assert.equal(w.home.chats!.rules.forged(made), true);
});

test('a chat made for a caller that may not see MoMo’s is shown to no one else, bounded, and removed when the connection ends', async (t) => {
  const w = await world(t);
  const a = await w.connect(null);
  const b = await w.connect(null);
  const granted = await w.connect({ fingerprint: 'f' });
  await a.conn.call('chat.send', { chatId: w.M, epoch: 0, key: 'key-00000001', text: 'hi' });
  const decoy = w.sends.at(-1).key;
  assert.notEqual(decoy, w.M);
  w.card(decoy, 'r-decoy');
  const ids = async (c: any) => ((await c.conn.call('host.pending', {})) as any).cards.map((x: any) => x.chatId);
  assert.deepEqual(await ids(a), [w.M], 'the asker sees it, under the id it asked about');
  assert.deepEqual(await ids(b), [], 'no other connection is told of it');
  assert.deepEqual(await ids(granted), [], 'nor the one that may see MoMo’s chats');
  assert.deepEqual(
    w.told.filter((m) => m.chatId === decoy || m.chatId === w.M),
    [],
    'no push',
  );
  assert.doesNotMatch(JSON.stringify([...b.out, ...granted.out]), new RegExp(decoy));
  // the asker goes: the chat made for it is let go of, in the Host's journal too
  assert.equal(w.home.chats!.rules.isDecoy(decoy), true);
  a.conn.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(w.home.chats!.rules.isDecoy(decoy), false);
});

test('unit: a connection may ask about a few hidden chats only, each gets a chat of its own, and every one is let go of when the connection ends', async () => {
  const ids = Array.from({ length: MAX_DECOYS + 2 }, (_, n) => `claude:h${n}`);
  const decoys: [string, boolean][] = [];
  const reports: string[] = [];
  const rules = {
    any: () => true,
    state: (id: string) => (ids.includes(id) ? 'hidden' : 'open'),
    seen: () => false,
    guard: (_m: string, p: any) => p,
    forged: () => false,
    isDecoy: (id: string) => decoys.some(([d, on]) => d === id && on),
    invalid: () => new Error('invalid id'),
    decoy: (id: string, on: boolean) => void decoys.push([id, on]),
  };
  let n = 0;
  const calls: [string, any][] = [];
  let closed = 0;
  const { wrap } = createChatVeil(rules, { newId: () => `fresh-${++n}`, report: (m: string) => reports.push(m) })(() => undefined, {
    principal: () => ({}),
  });
  const conn = wrap({
    close: () => void closed++,
    call: async (method: string, raw: any) => {
      calls.push([method, raw]);
      if (method === 'chat.remove' && raw.chatId.endsWith('fresh-2')) throw new Error('already gone');
      return {};
    },
  });
  await conn.call('host.hello', {});
  for (const id of ids.slice(0, MAX_DECOYS)) await conn.call('chat.send', { chatId: id, epoch: 3, key: 'key-00000001' });
  await assert.rejects(conn.call('chat.send', { chatId: ids[MAX_DECOYS], epoch: 3, key: 'key-00000001' }), /invalid id/);
  assert.equal(decoys.length, MAX_DECOYS);
  conn.close();
  await new Promise((r) => setImmediate(r));
  const removed = calls.filter(([m]) => m === 'chat.remove');
  assert.equal(removed.length, MAX_DECOYS);
  assert.ok(removed.every(([, p]) => p.epoch === 3 && /^key-[0-9a-f]{8}$/.test(p.key)));
  assert.deepEqual(decoys.filter(([, on]) => !on).length, MAX_DECOYS);
  assert.equal(closed, 1);
  assert.match(reports.join(), /could not be removed: already gone/);
  // a decoy asked about before any epoch is let go at epoch 0
  const second = createChatVeil(rules)(() => undefined, { principal: () => ({}) }).wrap({
    close: () => undefined,
    call: async (m: string, r: any) => (calls.push([m, r]), m === 'chat.remove' ? Promise.reject(new Error('x')) : {}),
  });
  await second.call('host.hello', {});
  await second.call('chat.subscribe', { chatId: ids[0] });
  second.close();
  assert.equal(calls.at(-1)![1].epoch, 0);
  await new Promise((r) => setImmediate(r));
});

test('unit: a failed removal is told to the Host’s report when the feature loader has one, and to no one when it has not', async () => {
  const { collectHandlers } = await import('../host/src/methodHandlers.mjs');
  const rules = {
    any: () => true,
    state: (id: string) => (id === 'claude:h' ? 'hidden' : 'open'),
    seen: () => false,
    guard: (_m: string, p: any) => p,
    forged: () => false,
    isDecoy: () => false,
    invalid: () => new Error('invalid'),
    decoy: () => undefined,
  };
  const reports: string[] = [];
  for (const deps of [{ report: (m: string) => reports.push(m) }, {}]) {
    const { chatVeil } = collectHandlers(['a.mjs'], () => () => ({ chatRules: rules }), deps);
    const conn = chatVeil(() => undefined, { principal: () => ({}) }).wrap({
      close: () => undefined,
      call: async (method: string, _raw: unknown) => {
        if (method === 'chat.remove') throw new Error('gone');
        return {};
      },
    });
    await conn.call('host.hello', {});
    await conn.call('chat.stop', { chatId: 'claude:h', epoch: 1, key: 'key-00000001' });
    conn.close();
    await new Promise((r) => setImmediate(r));
  }
  assert.equal(reports.length, 1);
  assert.match(reports[0], /could not be removed: gone/);
});

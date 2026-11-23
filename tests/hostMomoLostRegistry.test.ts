// A MoMo registry that cannot be read (another key, a damaged file) loses nothing (host/src/momoChats.mjs): MoMo's chats stay hidden and refused by their id and their record, ordinary chats and the Host's own results are served as ever, a restart changes none of it, and a read that failed is tried again after a second.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createChatVeil } from '../host/src/chatVeil.mjs';
// @ts-ignore
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoChats } from '../host/src/momoChats.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { PROVIDER_ENV, world } from './support/host/momoVeilKit.ts';

/**
 * MoMo's chats over a registry that cannot be read (another key, or a damaged file), with the chat records as a restart keeps
 * them. `restart` is a new instance over the same disk and records.
 */
async function lostRegistry(t: any, how: 'rotated' | 'damaged') {
  const w = await world(t);
  const records = new Map<string, any>();
  const tagged = (id: string) => records.set(id, { meta: { momo: 'main' } });
  tagged(w.M);
  const ordinary = `claude:${crypto.randomUUID()}`;
  records.set(ordinary, { meta: {} });
  const real = createFileSafeStorage(path.join(w.dir, 'config'));
  let decrypts = 0;
  const safeStorage = {
    isEncryptionAvailable: () => true,
    encryptString: (v: string) => real.encryptString(v),
    decryptString: (b: Buffer) => {
      decrypts++;
      if (how === 'rotated') throw new Error('wrong key');
      return real.decryptString(b);
    },
  };
  if (how === 'damaged') fs.writeFileSync(path.join(w.dir, 'data', 'momo', 'chats.json'), 'not a sealed file');
  let clock = 1_000_000;
  const reports: string[] = [];
  const restart = () => {
    const home: any = createMomoHome({ hostId: 'home-aaaa-1111', dataDir: path.join(w.dir, 'data'), safeStorage });
    home.granted = () => true;
    const sessions: any = { chats: { records, patchMeta: () => undefined }, isolated: () => true };
    return createMomoChats({
      home,
      sessions,
      epochs: w.epochs,
      env: PROVIDER_ENV,
      now: () => clock,
      report: (m: string) => reports.push(m),
    });
  };
  return { w, records, ordinary, restart, reports, decrypts: () => decrypts, tick: (ms: number) => (clock += ms) };
}

for (const how of ['rotated', 'damaged'] as const)
  test(`a registry that cannot be read (${how}) loses nothing: MoMo’s chats stay hidden and refused by their id and their record, ordinary chats and the Host’s own results are served as ever, and a restart changes none of it`, async (t) => {
    const lost = await lostRegistry(t, how);
    for (const round of ['first', 'after a restart']) {
      const chats = lost.restart();
      assert.equal(chats.rules.state(lost.w.M), 'hidden', `${round}: the tagged chat`);
      assert.equal(chats.rules.state(`claude:${crypto.randomUUID()}`), 'open', `${round}: an ordinary new chat`);
      assert.equal(chats.rules.state(lost.ordinary), 'open', `${round}: an ordinary chat`);
      // an id made the way MoMo's are is MoMo's even with no record and no registry
      assert.equal(chats.rules.state('claude:00000000-0000-8000-8000-c0de12345678'), 'hidden', `${round}: by its form`);
      const hasMomo = chats.rules.any();
      assert.equal(hasMomo, true);
      const results = { cards: [{ chatId: lost.ordinary }], note: 'plain', byChat: { [lost.ordinary]: 1 } };
      const seen = (principal: unknown) => createChatVeil(chats.rules)(() => undefined, { principal: () => principal });
      const stranger = seen(null).wrap({ close: () => undefined, call: async (_m: string, _r: unknown) => results });
      await stranger.call('host.hello', {});
      assert.equal(await stranger.call('host.pending', {}), results, `${round}: the Host's own results are the very value it made`);
      assert.equal(await stranger.call('chat.send', { chatId: lost.ordinary }), results);
      // MoMo's chat is a fresh one to a stranger, and refused to a granted caller, with no registry to ask
      let reached: any;
      const probe = seen(null).wrap({ close: () => undefined, call: async (_m: string, raw: any) => ((reached = raw), results) });
      await probe.call('host.hello', {});
      await probe.call('chat.send', { chatId: lost.w.M });
      assert.notEqual(reached.chatId, lost.w.M, `${round}: a stranger's message never reaches it`);
      const granted = seen({ fingerprint: 'f', kind: 'desktop' }).wrap({
        close: () => undefined,
        call: async (_m: string, _r: unknown) => results,
      });
      await granted.call('host.hello', {});
      await assert.rejects(granted.call('chat.permit', { chatId: lost.w.M }), (e: any) => e.code === 'momo_chat_fixed');
      // with the registry unreadable MoMo has no main chat to name
      if (chats.state().registry === 'unreadable') assert.equal(chats.main(), null);
      assert.deepEqual(
        chats.state(),
        { registry: how === 'rotated' ? 'unreadable' : round === 'first' ? 'unreadable' : 'ok' },
        `${round}: status says so`,
      );
      // nothing can start as MoMo while the registry cannot say what is there (after a restart a damaged file is gone, a rotated one is not)
      if (!(how === 'damaged' && round !== 'first'))
        await assert.rejects(chats.start({ harness: 'claude' }), (e: any) => e.code === 'momo_registry_unreadable');
    }
    assert.ok(lost.reports.length > 0, 'it is reported');
  });

test('a failed read is tried again after a second, not on every request', async (t) => {
  const lost = await lostRegistry(t, 'rotated');
  const chats = lost.restart();
  const first = lost.decrypts();
  const plain = `claude:${crypto.randomUUID()}`;
  for (let i = 0; i < 20; i++) chats.rules.state(plain);
  const burst = lost.decrypts() - first;
  assert.ok(burst <= 1, 'one read for a burst of requests');
  lost.tick(1500);
  chats.rules.state(plain);
  assert.ok(lost.decrypts() - first > burst, 'and again a second later');
});

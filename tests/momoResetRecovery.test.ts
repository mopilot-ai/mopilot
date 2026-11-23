// Whole-repository invariant for Reset MoMo (#2291, #2307): after Reset, a write to every registered MoMo store
// (electron/momo/stores.cjs MOMO_STORES) succeeds in the same process, with no restart: a store whose folder Reset
// removes makes it again when it next writes, or Reset reopens it. A store added to MOMO_STORES needs its write here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';

export const GUARDS = ['electron/'];

const require = createRequire(import.meta.url);
const { MOMO_STORES, resetMomoStores, whileResetting } = require('../electron/momo/stores.cjs');
const { setMomoContextProvider } = require('../electron/momo/contract/context.cjs');

const SWEEP = { name: 'Inbox sweep', prompt: 'Summarize what needs a reply.', rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0' };

/** One write to each store through its service, as the app makes it; each throws (or fails an assertion) if it can't. */
const WRITES: Record<string, (w: any) => Promise<unknown>> = {
  memory: async (w) => assert.equal((await w.call('momoMemory:add', 'Du likes tea')).ok, true),
  // a source read: connected, decided by the sentinel and recorded in the audit log (the #2307 repro)
  sources: async (w) => {
    w.m.sources.hub.connect('calendar');
    const r = await w.m.sources.hub.read(
      { source: 'calendar', action: 'calendar.events', chatId: 'mc', summary: 'this week' },
      async () => ({
        count: 1,
      }),
    );
    assert.equal(r.count, 1);
  },
  // a connector's tokens in the sealed vault, read back
  connectors: async (w) => {
    await w.m.sources.connectorVault.put('fake', { accessToken: 'a', scopes: ['read'] });
    assert.equal(w.m.sources.connectorVault.get('fake')?.accessToken, 'a');
  },
  routines: (w) => w.m.routineStore.add(SWEEP, { approved: true }),
  approvals: async (w) => {
    w.m.sentinel.noteOutcome('mc', 'fp', 'done');
    await w.m.sentinel.idle();
    assert.equal(w.m.sentinel.writeError ?? null, null);
    assert.ok(fs.existsSync(path.join(w.m.dir, 'approvals.bin')));
  },
  audit: async (w) => {
    await w.m.audit.intent({ action: 'calendar.events', chatId: 'mc', decision: 'allowed' });
    assert.equal((await w.m.audit.verify()).ok, true);
  },
  // a MoMo chat's turn in the index of past chats, found by a later search
  history: async (w) => {
    const added = w.m.history.add([
      { chatId: 'mc', turnId: `t${Date.now()}`, at: Date.now(), harness: 'claude', kind: 'main', user: 'tea in Kyoto', assistant: 'noted' },
    ]);
    assert.equal(added, 1);
    assert.equal(w.m.history.search('Kyoto').length >= 1, true);
  },
  chats: async (w) => {
    const made = await w.call('momoChat:mainChat');
    assert.ok(made.value?.chatId, JSON.stringify(made));
    assert.equal(w.m.mainChat.current(), made.value.chatId);
  },
};

test('every registered MoMo store has a write in this test', () => {
  assert.deepEqual(Object.keys(WRITES).sort(), MOMO_STORES.map((s: any) => s.id).sort());
});

test('after Reset, a write to every MoMo store succeeds without a restart', async () => {
  const w = world({ allowed: true });
  w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 'mc', start: 0, count: null }], meta: { momo: 'main' } });
  for (const [id, write] of Object.entries(WRITES)) await write(w).catch((e) => assert.fail(`${id} before Reset: ${e}`));
  const r = await resetMomoStores();
  assert.deepEqual(r.notReset, [], 'every store reset');
  assert.deepEqual(
    w.m.sources.hub.list().filter((s: any) => s.connected),
    [],
    'nothing is left from before',
  );
  for (const [id, write] of Object.entries(WRITES)) await write(w).catch((e) => assert.fail(`${id} after Reset: ${e}`));
  // and a second Reset over what was written after the first
  assert.deepEqual((await resetMomoStores()).notReset, []);
  await w.m.close();
  setMomoContextProvider(null);
});

test('no chat of MoMo is made while Reset runs: the main chat and background chats are refused until it ends', async () => {
  const w = world({ allowed: true });
  await whileResetting(async () => {
    const r = await w.call('momoChat:mainChat');
    assert.equal(r.error.code, 'resetting');
    await assert.rejects(w.m.mainChat.startBackground({ harness: 'claude' }, { momo: 'routine' }), (e: any) => e.code === 'resetting');
  });
  assert.ok((await w.call('momoChat:mainChat')).value.chatId, 'made once Reset is over');
  await w.m.close();
  setMomoContextProvider(null);
});

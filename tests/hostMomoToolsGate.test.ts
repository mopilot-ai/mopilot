// MoMo's gate (host/src/momoServices/gate.mjs) behind the real tool registry of the Host (host/src/momoTools.mjs, #4843): a call is allowed, refused by an owner's rule, or asks for a card in a chat that holds outside content, and an answered card is spent by the model's retry exactly once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { test } from 'node:test';
// @ts-ignore: plain ESM without declarations
import { createMomoHome } from '../host/src/momoHome.mjs';
// @ts-ignore
import { createMomoChats } from '../host/src/momoChats.mjs';
// @ts-ignore
import { registerMomoTools } from '../host/src/momoTools.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
// @ts-ignore
import { createEpochStore } from '../host/src/epochs.mjs';
// @ts-ignore
import gateService from '../host/src/momoServices/gate.mjs';
// @ts-ignore
import learningService from '../host/src/momoServices/learning.mjs';

const require = createRequire(import.meta.url);
const { Registry } = require('../electron/capabilities/contract/registry.cjs');
const { segmentKey } = require('../electron/platform/segmentOwner.cjs');

const MOMO = ['momo'];
const ENV = { ANTHROPIC_API_KEY: 'test-key', HOME: '/nonexistent-home', XDG_DATA_HOME: '/nonexistent-data' };

/** A Host's registry with MoMo's home active and one MoMo chat, the gate service behind the registry's chokepoint. */
async function world(t: any, { grant = true, start = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-tools-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const registry = new Registry();
  const ran: string[] = [];
  for (const name of ['browser_open', 'shell_run'])
    registry.register({
      name,
      policy: 'observe',
      description: name,
      schema: { type: 'object', properties: {} },
      handler: () => (ran.push(name), 'done'),
    });
  const records = new Map<string, any>();
  const patchMeta = (id: string, patch: object) => {
    const rec = records.get(id) ?? {
      id,
      segments: [{ kind: 'claude', nativeId: id.replace(/^claude:/, ''), start: 0, count: null }],
      meta: {},
    };
    records.set(id, { ...rec, meta: { ...rec.meta, ...patch } });
  };
  const sessions: any = { chats: { records, patchMeta }, isolated: () => true };
  const home: any = createMomoHome({
    hostId: 'home-aaaa-1111',
    dataDir: path.join(dir, 'data'),
    safeStorage: createFileSafeStorage(path.join(dir, 'config')),
    isMomoChat: (id: string) => !!home.chats?.isMomoChat(id),
  });
  if (grant) await home.grant({ account: 'a1', features: MOMO });
  const epochs = createEpochStore(path.join(dir, 'e.json'), { report: () => undefined });
  home.chats = createMomoChats({ home, sessions, epochs, env: ENV });
  if (start) await home.start({ name: 'Studio' });
  t.after(() => home.lifecycle('pause'));
  const { chatId: M } = await home.chats.start({ harness: 'claude' });
  const coding = `claude:${crypto.randomUUID()}`;
  patchMeta(coding, {});
  gateService({ home, now: () => Date.now() });
  learningService({ home, now: () => Date.now() });
  const off = registerMomoTools({ registry, home, sessions });
  const segment = (id: string) => segmentKey('claude', id.replace(/^claude:/, ''));
  const call = (chatId: string, tool: string, args: object = {}) => registry.invoke(chatId, segment(chatId), tool, args);
  const names = (chatId: string) =>
    registry
      .list({ chatId })
      .map((x: any) => x.name)
      .sort();
  return { dir, registry, home, M, coding, ran, call, names, off, records, sessionsOf: sessions, epochs };
}

/** What a call said: its text when it ran, or the refusal's code. */
const said = (r: any) => (r.ok ? r.content.map((c: any) => c.text).join('\n') : `refused:${r.error.code}`);

test('MoMo’s own tools run through the real registry behind the gate, and an owner rule that denies one is a refusal the model reads', async (t) => {
  const w = await world(t);
  assert.equal((await w.call(w.M, 'momo_memory_save', { text: 'Lives in Berlin' })).ok, true);
  assert.equal(w.home.stores().memory.list().facts.length, 1);
  await w.home
    .service('learning')
    .addOwnerRule({ id: 'no', behavior: 'deny', tool: 'momo_memory_save', effect: '*', scope: '*', text: 'Never save' }, 'phone:a');
  assert.equal(said(await w.call(w.M, 'momo_memory_save', { text: 'second' })), 'refused:denied');
  assert.equal(w.home.stores().memory.list().facts.length, 1, 'a refused call did not run');
  assert.equal((await w.home.stores().audit.verify()).ok, true);
});

test('in a chat that read outside content, the owner’s memory write is a card with the exact line, and the retry after Allow saves it once', async (t) => {
  const w = await world(t);
  assert.equal((await w.call(w.M, 'momo_memory_save', { text: 'Lives in Berlin' })).ok, true);
  await w.home.service('gate').taintFor(w.M).toolResult('outside');
  assert.equal(w.home.gate.taintFor(w.M).tainted(), true);
  const args = { text: 'Dana prefers mornings' };
  assert.equal(said(await w.call(w.M, 'momo_memory_save', args)), 'refused:approval_pending');
  assert.equal(said(await w.call(w.M, 'momo_memory_forget', { id: 'x' })), 'refused:approval_pending');
  assert.equal(w.home.stores().memory.list().facts.length, 1);
  const cards = (await w.home.service('gate').cards('phone:a')).filter((c: any) => c.status === 'pending');
  const card = cards.find((c: any) => c.fields.some((f: any) => f.label === 'text' && f.value === args.text));
  assert.ok(card, 'a card shows the exact line');
  await w.home.service('gate').answer(card.id, 'allow', 'phone:a', 'Phone');
  assert.equal((await w.call(w.M, 'momo_memory_save', args)).ok, true);
  assert.equal(w.home.stores().memory.list().facts.length, 2);
  assert.equal(said(await w.call(w.M, 'momo_memory_save', args)), 'refused:approval_pending');
  assert.equal(w.home.stores().memory.list().facts.length, 2);
  assert.match(said(await w.call(w.M, 'momo_memory_search', { query: 'Berlin' })), /Lives in Berlin/);
  assert.equal((await w.call(w.M, 'momo_open_loops', { action: 'list' })).ok, true);
});

test('a chat that is not the MoMo home’s is not the gate’s business, and a MoMo chat on a Host that is not the home runs nothing', async (t) => {
  const w = await world(t, { start: false });
  assert.equal(said(await w.call(w.M ?? 'claude:none', 'momo_memory_save', { text: 'x' })), 'refused:unavailable');
});

test('after a move a chat id this Host does not know is not clean, however it got there, and a chat it registers is clean', async (t) => {
  const w = await world(t);
  const taint = w.home.gate.taint;
  assert.equal(taint.has(w.M), false);
  // a record that came with the move, keyed by an id of the old Host's chats, and an id nobody registered
  await taint.mark('old-host-chat');
  assert.deepEqual([taint.has('old-host-chat'), taint.has('claude:never-registered'), taint.has(undefined)], [true, true, true]);
  assert.equal(said(await w.call('claude:never-registered', 'momo_memory_save', { text: 'x' })), 'refused:unavailable');
  assert.equal(w.home.gate.taintFor('claude:never-registered').tainted(), true);
  // a chat created here after the move starts clean
  const { chatId } = await w.home.chats.start({ harness: 'claude' });
  assert.equal(taint.has(chatId), false);
});

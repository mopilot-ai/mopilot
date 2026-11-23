// How main runs MoMo's search aliases (electron/app/momoAliases.cjs, #2999 P2): a batch chat is a MoMo background chat
// started isolated and unattended on the brain's cheap model, within a sealed day of background tokens, never on battery,
// paused or during a reset; and MoMo's data-only background chats (the memory pass's and the aliases', one predicate:
// shared/momoChat.mjs isMomoDataMeta) get no tool, no memory tool, no memory context, and are never a past chat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fakeSafe, scratch } from './support/momo-memory.ts';
import { world } from './support/momoAppWorld.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { openMomoAliases, onBatteryPower, tickMsOf } = require('../electron/app/momoAliases.cjs');
const { passKind } = require('../electron/app/momoBackground.cjs');
const { kindOfMeta } = require('../electron/app/momoHistory.cjs');
const { HistoryIndex } = require('../electron/momo/historyIndex.cjs');
const { UNATTENDED, ISOLATION } = require('../electron/momo/routines.cjs');
const { dataOnlyMeta, isolateChatTools } = require('../electron/momo/contract/toolIsolation.cjs');
const { momoContextFor, setMomoContextProvider } = require('../electron/momo/contract/context.cjs');
const { whileResetting } = require('../electron/momo/stores.cjs');
const { isMomoDataMeta, MOMO_DATA_TAGS } = require('../shared/momoChat.mjs');

function deps(o: { paused?: boolean; battery?: boolean } = {}) {
  const dir = scratch();
  const history = new HistoryIndex({ dir: path.join(dir, 'history'), safeStorage: null });
  history.add([{ chatId: 'c1', turnId: 't1', at: 1, harness: 'claude', kind: 'main', user: 'Bob rents me the flat', assistant: 'Noted.' }]);
  const started: any[] = [];
  const patched: any[] = [];
  const sent: any[] = [];
  const d = {
    core: { dir, history },
    live: { sessions: { patch: (id: string, p: any) => void patched.push([id, p]) } },
    allowed: () => true,
    safeStorage: fakeSafe(),
    startChat: async (brain: any, tag: any) => (started.push([brain, tag]), 'al-1'),
    send: async (id: string, item: any) => void sent.push([id, item]),
    authored: (id: string, text: string, show: any) => ({ id, text, show }),
    discardChat: () => {},
    limitOf: () => ({ go: {} }),
    momoPrefs: () => ({ brain: { main: { harness: 'claude', model: 'opus' } }, ...(o.paused ? { paused: true } : {}) }),
    onBattery: () => o.battery === true,
  };
  return { d, dir, history, started, patched, sent };
}

test('a batch chat starts isolated and unattended on the cheap model, and its tokens count in the sealed day', async () => {
  const t = deps();
  const { aliases, budget } = openMomoAliases(t.d);
  assert.equal(await aliases.tick(), true);
  assert.equal(t.started[0][0].model, 'haiku');
  assert.deepEqual(t.started[0][1], { momo: 'aliases', isolation: ISOLATION });
  assert.deepEqual(t.patched, [['al-1', { scheduled: UNATTENDED }]]);
  assert.equal(t.sent[0][1].show.title, 'Search aliases');
  assert.match(t.sent[0][1].text, /Bob rents me the flat/);
  await aliases.finished({ chatId: 'al-1', text: '{"1":"landlord 房东"}' });
  assert.deepEqual(
    t.history.search('房东').map((c: any) => c.turnId),
    ['t1'],
  );
  assert.ok(budget.byKind().aliases > 0);
  assert.ok(fs.existsSync(path.join(t.dir, 'background-tokens.json')));
  aliases.cancelAll();
});

test('no batch while MoMo is paused or being reset, or on battery', async () => {
  for (const o of [{ paused: true }, { battery: true }]) {
    const t = deps(o);
    assert.equal(await openMomoAliases(t.d).aliases.tick(), false, JSON.stringify(o));
  }
  const t = deps();
  const { aliases } = openMomoAliases(t.d);
  await whileResetting(async () => assert.equal(await aliases.tick(), false));
  assert.equal(t.started.length, 0);
});

test('a development build may tick faster for the E2E runs; any other build keeps the writer’s own', () => {
  assert.equal(tickMsOf({ MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_ALIAS_TICK_MS: '2000' }), 2000);
  assert.equal(tickMsOf({ MOPILOT_MOMO_ALIAS_TICK_MS: '2000' }), undefined, 'not a MoMo development build');
  assert.equal(tickMsOf({ MOPILOT_MOMO_DEV: '1', MOPILOT_MOMO_ALIAS_TICK_MS: '10' }), undefined, 'too fast');
  assert.equal(tickMsOf({ MOPILOT_MOMO_DEV: '1' }), undefined);
  assert.equal(tickMsOf(), undefined);
});

test("the battery is read from Electron's powerMonitor, and is never a reason to fail", () => {
  assert.equal(
    onBatteryPower(() => ({ powerMonitor: { isOnBatteryPower: () => true } })),
    true,
  );
  assert.equal(
    onBatteryPower(() => ({ powerMonitor: { isOnBatteryPower: () => false } })),
    false,
  );
  assert.equal(
    onBatteryPower(() => ({})),
    false,
  );
  assert.equal(
    onBatteryPower(() => {
      throw new Error('no electron');
    }),
    false,
  );
  assert.equal(onBatteryPower(), false, 'outside Electron');
});

test('the memory pass and the aliases are data-only chats: no tools, never a past chat or a pass source', () => {
  assert.deepEqual([...MOMO_DATA_TAGS], ['memory', 'aliases', 'nudge', 'brief']);
  for (const momo of MOMO_DATA_TAGS) {
    assert.equal(isMomoDataMeta({ momo }), true);
    assert.equal(dataOnlyMeta({ momo }), true);
    assert.equal(passKind({ momo }), 'pass');
    assert.equal(kindOfMeta({ momo }), null, `${momo} chats quote other chats: never indexed`);
  }
  for (const meta of [{ momo: 'main' }, { momo: 'routine' }, {}, null, 'x'])
    assert.equal(isMomoDataMeta(meta), false, JSON.stringify(meta));
  assert.equal(kindOfMeta({ momo: 'routine' }), 'routine');
  assert.equal(kindOfMeta({ momo: 'previous' }), 'previous');
  assert.equal(kindOfMeta({ momo: 'main' }), 'main');
});

test("in the app, a data-only chat gets no tool and no memory context; MoMo's background service runs the aliases", async () => {
  const w = world({ allowed: true, deletion: true });
  await w.call('momoMemory:add', 'Du likes tea');
  w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }], meta: { momo: 'main' } });
  w.chats.commit({ id: 'al', segments: [{ kind: 'claude', nativeId: 's2', start: 0, count: null }], meta: { momo: 'aliases' } });
  w.chats.commit({ id: 'mp', segments: [{ kind: 'claude', nativeId: 's3', start: 0, count: null }], meta: { momo: 'memory' } });
  // the scope main installs over the registry (app/agentTools.cjs)
  isolateChatTools(w.live.capabilities, () => w.chats);
  const names = (chatId: string) => w.live.capabilities.list({ chatId }).map((t: any) => t.name);
  assert.ok(names('mc').includes('momo_history_search'));
  assert.deepEqual(names('al'), []);
  assert.deepEqual(names('mp'), []);
  assert.match(momoContextFor('mc', { session: 's1', query: 'tea' }) ?? '', /Du likes tea/);
  assert.equal(momoContextFor('al', { session: 's2', query: 'tea' }), null);
  assert.equal(momoContextFor('mp', { session: 's3', query: 'tea' }), null);
  // each turn's end reaches the aliases, and MoMo going off stops them
  const gone: string[] = [];
  w.m.aliases.deleted = (id: string) => void gone.push(id);
  await w.live.chatDeletion.onDeleted({ chatId: 'al' });
  assert.deepEqual(gone, ['al'], 'a deleted chat (Reset deletes MoMo’s) reaches the aliases');
  const seen: string[] = [];
  let cancelled = 0;
  let started = 0;
  w.m.aliases.finished = async (e: any) => void seen.push(e.chatId);
  w.m.aliases.cancelAll = () => void cancelled++;
  w.m.aliases.start = () => void started++;
  await w.live.controller.onFinished({ chatId: 'mc' });
  await waitFor(() => seen.length, 'the finished chat to be seen');
  assert.deepEqual(seen, ['mc']);
  for (const cb of w.access) cb(false);
  assert.equal(cancelled, 1);
  for (const cb of w.access) cb(true);
  assert.equal(started, 1);
  assert.deepEqual(w.m.backgroundBudget.byKind(), { memory: 0, aliases: 0, nudges: 0 });
  // the writer's facts source reads the app's own memory, and its aliases reach the memory's search
  const [item] = w.m.factAliases.source.needing(5);
  assert.equal(item.text, 'Du likes tea');
  await w.m.factAliases.source.set([{ item, aliases: '喝茶 绿茶' }]);
  assert.deepEqual(
    w.m.memory.search('喝茶').map((f: any) => f.text),
    ['Du likes tea'],
  );
  await w.m.close();
  setMomoContextProvider(null);
});

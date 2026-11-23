// MoMo in main (electron/app/momo.cjs): every service is made over <userData>/momo with its IPC, tools and Reset store;
// each refuses while MoMo isn't allowed; the trust layer starts once MoMo is allowed and lets go at quit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { world } from './support/momoAppWorld.ts';
import { waitFor } from './support/waitFor.ts';

const require = createRequire(import.meta.url);
const { lazyHelper, harnessKinds } = require('../electron/app/momo.cjs');
const { ApprovalBroker } = require('../electron/capabilities/contract/approvals.cjs');
const { LEVELS } = require('../electron/momo/sentinel.cjs');
const { resetMomoStores } = require('../electron/momo/stores.cjs');
const { momoContextFor, setMomoContextProvider } = require('../electron/momo/contract/context.cjs');

test('every service is made over <userData>/momo with its IPC and tools, and refuses while MoMo is not allowed', async () => {
  const w = world();
  assert.equal(w.m.dir, path.join(w.root, 'momo'));
  for (const ch of [
    'momoMemory:list',
    'momoSources:list',
    'momoChat:mainChat',
    'momoChat:brain:get',
    'momoAsk:chat',
    'momoAsk:send',
    'momoAsk:open',
    'momoDraft:openInMail',
  ])
    assert.ok(w.handlers.has(ch), ch);
  for (const t of ['momo_memory_search', 'momo_memory_save', 'momo_memory_forget', 'momo_calendar_events', 'momo_files_read', 'momo_draft'])
    assert.ok(w.live.capabilities.has(t), t);
  assert.equal((await w.call('momoMemory:list')).reason, 'not_allowed');
  assert.equal((await w.call('momoSources:list')).reason, 'not_allowed');
  assert.equal((await w.call('momoChat:mainChat')).error.code, 'not_allowed');
  assert.equal((await w.call('momoDraft:openInMail', { body: 'x' })).reason, 'not_allowed');
  // nothing of MoMo's is on disk while it isn't allowed
  assert.equal(fs.existsSync(w.m.dir), false);
  setMomoContextProvider(null);
});

test('allowed: memory works, MoMo chats get their context, the trust layer starts, and access coming back starts it again', async () => {
  const w = world({ allowed: true });
  assert.equal((await w.call('momoMemory:add', 'Du likes tea')).ok, true);
  assert.deepEqual(
    w.broadcasts.filter(([c]: any) => c === 'momoMemory:changed'),
    [['momoMemory:changed', undefined]],
  );
  const facts = (await w.call('momoMemory:list')).facts;
  assert.deepEqual(
    facts.map((f: any) => f.text),
    ['Du likes tea'],
  );
  // a MoMo chat's turn carries the memory; any other chat none
  w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }], meta: { momo: 'main' } });
  w.chats.commit({ id: 'cc', segments: [{ kind: 'claude', nativeId: 's2', start: 0, count: null }], meta: {} });
  assert.match(momoContextFor('mc', { session: 's1', query: 'tea' }) ?? '', /Du likes tea/);
  assert.equal(momoContextFor('cc', { session: 's2', query: 'tea' }), null);
  assert.equal(w.m.isMomoChat('mc'), true);
  await w.m.audit.idle();
  await w.m.sentinel.idle();
  // the audit log settled what a quit left open: its folder exists now, its key sealed
  assert.ok(fs.existsSync(path.join(w.m.dir, 'audit')));
  w.allowed = false;
  w.access[0](false);
  w.allowed = true;
  w.access[0](true);
  await w.m.close();
  setMomoContextProvider(null);
});

test('a start that fails is noted, never thrown', async () => {
  const w = world();
  w.allowed = true;
  w.m.audit.settleUnfinished = async () => {
    throw new Error('locked');
  };
  w.m.sentinel.load = async () => {
    throw new Error('locked');
  };
  w.access[0](true);
  await new Promise((r) => setImmediate(r));
  setMomoContextProvider(null);
});

test('sources: the folder dialog runs over the asking window, privacy panes open in the browser, reads go through the trust layer', async () => {
  const w = world({ allowed: true });
  assert.equal((await w.from('nope', 'momoSources:addFolder')).ok, false, 'a sender that is no app window gets no dialog');
  assert.equal((await w.call('momoSources:addFolder')).cancelled, true);
  w.dialog = { canceled: false, filePaths: [] };
  assert.equal((await w.call('momoSources:addFolder')).cancelled, true, 'no folder picked');
  w.dialog = { canceled: false, filePaths: ['/'] };
  assert.equal((await w.call('momoSources:addFolder')).ok, false, 'a folder outside home is refused by the source');
  await w.call('momoSources:openPrivacy', 'calendar');
  assert.ok(w.opened.some((u: unknown) => typeof u === 'string' && u.startsWith('x-apple')));
  // a read of a source that isn't connected is refused and recorded
  await assert.rejects(
    w.m.sources.hub.read({ source: 'files', action: 'list', chatId: 'mc', summary: 'list' }, async () => ({ count: 0 })),
  );
  await w.m.close();
  setMomoContextProvider(null);
});

test('the main chat: made on the default brain with the first Claude login, its account lanes, kinds and changes told', async () => {
  const w = world({ allowed: true });
  const o = w.m.mainChat.o;
  assert.deepEqual(o.accounts.claudeLogins(), ['du@work']);
  assert.equal(o.accounts.laneOf('claude', 'du@work'), 'subscription');
  assert.equal(o.accounts.laneOf('codex', 'nope'), null);
  assert.equal(o.accounts.codex(), null);
  assert.deepEqual(o.kinds(), ['claude', 'codex', 'acp:opencode']);
  // a harness's setup is read from the ACP host's login-shell env, else this process's (#2357)
  assert.equal(o.env(), process.env);
  w.live.acpHost = {};
  assert.equal(o.env(), process.env);
  const shell = { HOME: '/h' };
  w.live.acpHost = { envOf: () => shell };
  assert.equal(o.env(), shell);
  w.live.acpHost = undefined;
  const made = await w.call('momoChat:mainChat');
  const chatId = made.value.chatId;
  assert.equal(w.chats.record(chatId).meta.momo, 'main');
  assert.ok(w.broadcasts.some(([c, p]: any) => c === 'chats:changed' && p.id === chatId));
  assert.ok(w.broadcasts.some(([c]: any) => c === 'momoChat:brainChanged'));
  // a message to a MoMo chat goes after the brain change a window made just before it (#3907); any other chat's goes at once
  let release: () => void = () => undefined;
  w.m.mainChat.tail = new Promise<void>((r) => (release = r));
  let sent = false;
  const going = w.live.controller.beforeDispatch({ chatId }).then(() => (sent = true));
  await w.live.controller.beforeDispatch({ chatId: 'someone-elses' });
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent, false);
  release();
  await going;
  assert.equal(sent, true);
  // the right panel reads MoMo's activity through the same IPC, from the services made with its background work
  w.live.momoActivity = { list: async () => ({ items: [{ id: 'routine:r' }] }) };
  assert.deepEqual(await w.call('momoChat:activity:list'), { value: { items: [{ id: 'routine:r' }] } });
  assert.equal(w.prefs.momo.brain.main.harness, 'claude');
  assert.equal(o.prefs.get(), w.prefs);
  w.live.patchPrefs = undefined;
  assert.equal(o.prefs.patch({}), false, 'prefs that cannot be saved say so');
  await w.m.close();
  setMomoContextProvider(null);
});

test('Ask MoMo: from Quick Chat only, sent to the main chat once the app window is ready, opened in the app', async () => {
  const w = world({ allowed: true });
  const qc = w.live.mini.webContents;
  assert.equal((await w.call('momoAsk:chat')).error.code, 'not_quick_chat');
  assert.ok((await w.from(qc, 'momoAsk:chat')).value.chatId);
  const sent = await w.from(qc, 'momoAsk:send', { id: 'r1', text: 'hi' });
  assert.equal(sent.value.note, null);
  assert.equal(w.sends[0].item.text, 'hi');
  assert.equal(w.sends[0].senderId, 7);
  assert.equal(w.sends[0].now, true);
  await w.from(qc, 'momoAsk:open');
  assert.deepEqual(w.opened.slice(-2), ['momo', 'hide']);
  w.live.mini = null;
  await w.from(qc, 'momoAsk:open');
  await w.m.close();
  setMomoContextProvider(null);
});

test('Reset MoMo deletes every store the services keep, MoMo chats through the app’s own deletion', async () => {
  const w = world({ allowed: true });
  await w.call('momoMemory:add', 'Du likes tea');
  const { value } = await w.call('momoChat:mainChat');
  await w.m.audit.idle();
  w.m.sentinel.clearChat = ((orig) => (id: string) => ((w.cleared = [...(w.cleared ?? []), id]), orig.call(w.m.sentinel, id)))(
    w.m.sentinel.clearChat,
  );
  w.deleted.push('already');
  w.chats.commit({ id: 'already', segments: [{ kind: 'claude', nativeId: 'z', start: 0, count: null }], meta: { momo: 'previous' } });
  fs.mkdirSync(path.join(w.m.dir, 'sources'), { recursive: true });
  const r = await resetMomoStores();
  assert.deepEqual(
    r.notReset.map((s: any) => s.id),
    [],
    'every store is registered by its service',
  );
  assert.deepEqual(w.deleted, ['already', value.chatId], 'a chat deleted already is not deleted again');
  assert.ok(w.cleared.includes(value.chatId), 'its taint and runs go with it');
  for (const f of ['facts.jsonl', 'approvals.bin', 'audit', 'state.json', 'workspace', 'sources'])
    assert.equal(fs.existsSync(path.join(w.m.dir, f)), false, f);
  assert.equal(w.m.mainChat.savedId, undefined, 'the main chat is read again from what is left');
  setMomoContextProvider(null);
});

test('Reset MoMo before the chats are open says MoMo’s chats were not reset; no registry means no tools', async () => {
  const w = world({ allowed: true, deletion: false, capabilities: false });
  const r = await resetMomoStores();
  assert.ok(r.notReset.some((s: any) => s.id === 'chats' && s.reason === 'failed'));
  await w.m.close();
  setMomoContextProvider(null);
});

test('a deleted chat that is not MoMo’s leaves the sentinel alone; the kinds without admission', async () => {
  const w = world({ allowed: true });
  let cleared = 0;
  w.m.sentinel.clearChat = () => void cleared++;
  w.chats.commit({ id: 'cc', segments: [{ kind: 'claude', nativeId: 's2', start: 0, count: null }], meta: {} });
  w.live.chatDeletion.onDeleted({ chatId: 'cc' });
  assert.equal(cleared, 0);
  assert.deepEqual(harnessKinds(null), ['claude', 'codex']);
  // a call names its chat only when that chat records the call's segment
  assert.equal(w.m.owner({ chatId: 'cc', segmentId: 'claude:s2' }), 'cc');
  assert.equal(w.m.owner({ chatId: 'cc', segmentId: 'claude:other' }), null);
  // no identity yet: no logins, no lanes
  w.live.identity = null;
  assert.deepEqual(w.m.mainChat.o.accounts.claudeLogins(), []);
  assert.equal(w.m.mainChat.o.accounts.laneOf('claude', 'du@work'), null);
  await w.m.close();
  setMomoContextProvider(null);
});

test('Calendar and Reminders reach the macOS helper computer use sets up after MoMo; until then they read as unavailable', async () => {
  const live: any = { computerUse: null };
  const helper = lazyHelper(live);
  await assert.rejects(helper.call('eventkit.status', {}, {}), (e: any) => e.reason === 'helper_unavailable');
  const calls: any[] = [];
  live.computerUse = { helper: { call: async (...a: any[]) => (calls.push(a), { calendar: 'granted', reminders: 'denied' }) } };
  assert.deepEqual(await helper.call('eventkit.status', { x: 1 }, { timeoutMs: 5 }), { calendar: 'granted', reminders: 'denied' });
  assert.deepEqual(calls, [['eventkit.status', { x: 1 }, { timeoutMs: 5 }]]);
  // the helper is quit while System Settings is open, and its grants are read by one launched for the read; neither before computer use is up
  assert.equal(helper.release(), 'none');
  await assert.rejects(helper.offlineStatus('eventkit'), /not set up yet/);
  const up = live.computerUse;
  live.computerUse = null;
  assert.equal(helper.release(), 'none');
  await assert.rejects(helper.offlineStatus('eventkit'), /not set up yet/);
  live.computerUse = up;
  const launched: string[] = [];
  live.computerUse.releaseHelper = () => 'busy';
  live.computerUse.offlineStatus = async (kind: string) => (launched.push(kind), { calendar: 'granted' });
  assert.equal(helper.release(), 'busy');
  assert.deepEqual(await helper.offlineStatus('eventkit'), { calendar: 'granted' });
  assert.deepEqual(launched, ['eventkit']);
  delete live.computerUse.releaseHelper;
  delete live.computerUse.offlineStatus;
  // a request macOS answered without its prompt clears the helper's grant record (#2999), through the platform's tccutil call
  const cleared: any[] = [];
  const reset = async (entity: string, o: object) => (cleared.push([entity, o]), entity === 'reminders');
  const clearing = lazyHelper(live, reset as any);
  assert.equal(await clearing.resetGrant('calendar'), false, 'not before computer use is up');
  live.computerUse = { helper: {}, helperInfo: { bundleId: 'ai.example.helper' } };
  assert.equal(await clearing.resetGrant('reminders'), true);
  assert.equal(await clearing.resetGrant('calendar'), false);
  assert.deepEqual(cleared, [
    ['reminders', { bundleId: 'ai.example.helper' }],
    ['calendar', { bundleId: 'ai.example.helper' }],
  ]);
  // no helper app to clear a record for: a fake helper on a socket, none yet, or no bundle id
  live.computerUse = { helper: { connectTo: '/tmp/fake.sock' }, helperInfo: { bundleId: 'ai.example.helper' } };
  assert.equal(await clearing.resetGrant('reminders'), false);
  live.computerUse = { helperInfo: { bundleId: 'ai.example.helper' } };
  assert.equal(await clearing.resetGrant('reminders'), false);
  live.computerUse = { helper: {} };
  assert.equal(await clearing.resetGrant('reminders'), false);
  assert.equal(cleared.length, 2, 'none of those reached tccutil');
  live.computerUse = up;
  // the sources service reads through it: a status before computer use is up says unavailable
  const w = world({ allowed: true });
  assert.deepEqual(await w.m.sources.eventKit.status(), { calendar: 'unavailable', reminders: 'unavailable' });
  w.live.computerUse = live.computerUse;
  assert.deepEqual(await w.m.sources.eventKit.status(), { calendar: 'granted', reminders: 'denied' });
  await w.m.close();
  setMomoContextProvider(null);
});

test('MoMo asks through the app’s approval card: one MoMo needs you notice while it is up, withdrawn when MoMo is turned off', async () => {
  const w = world({ allowed: true });
  const cards: any[] = [];
  // as the ChatController does: a card added says 'approval', which the Notifier keeps quiet for a MoMo chat
  const addApproval = (chatId: string, a: any) => {
    cards.push({ chatId, ...a });
    w.live.notifier.quiet('approval', chatId);
  };
  w.live.computerUse.broker = new ApprovalBroker({ controller: { addApproval, resolveApproval: () => true } });
  w.chats.commit({ id: 'mc', segments: [{ kind: 'codex', nativeId: 't1', start: 0, count: null }], meta: { momo: 'main' } });
  w.m.sentinel.setSource('notes', { level: LEVELS.ASK, name: 'Notes' });
  const call = { chatId: 'mc', tool: 'notes_write', source: 'notes', kind: 'change', args: { text: 'hi' }, summary: 'Write a note' };
  const until = async (cond: () => boolean) => {
    await waitFor(cond, 'the condition');
  };
  const first = w.m.sentinel.decide(call);
  await until(() => cards.length === 1);
  assert.equal(cards[0].method, 'sage/momoAction');
  assert.equal(cards[0].params.harness, 'codex');
  assert.equal(cards[0].params.momo.source, 'Notes');
  assert.equal(w.m.asks.openFor('mc'), 1);
  // one ask, one notice: the chat's
  assert.deepEqual(
    w.live.notifier.shown.filter(([kind]: any) => kind === 'momo').map(([, key]: any) => key),
    ['momo:chat:mc'],
  );
  w.live.computerUse.broker.answer(cards[0].id, { decision: 'allow', scope: 'once' });
  assert.equal((await first).allow, true);
  assert.equal(w.m.asks.openFor('mc'), 0);
  // MoMo turned off for the account: the card still up goes unanswered
  const second = w.m.sentinel.decide({ ...call, summary: 'again' });
  await until(() => cards.length === 2);
  w.allowed = false;
  for (const cb of w.access) cb(false);
  assert.equal((await second).reason, 'no-answer');
  w.allowed = true;
  assert.equal(w.m.asks.openFor('mc'), 0);
  await w.m.close();
  setMomoContextProvider(null);
});

test('MoMo’s test tool is there for E2E runs only (SAGE_DEBUG_TOOLS=1), its card naming the chat’s harness', async () => {
  const plain = world();
  assert.equal(plain.live.capabilities.has('momo_debug_action'), false);
  await plain.m.close();
  process.env.SAGE_DEBUG_TOOLS = '1';
  try {
    const w = world({ allowed: true });
    assert.equal(w.live.capabilities.has('momo_debug_action'), true);
    const cards: any[] = [];
    w.live.computerUse.broker = new ApprovalBroker({
      controller: { addApproval: (chatId: string, a: any) => cards.push({ chatId, ...a }), resolveApproval: () => true },
    });
    w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }], meta: { momo: 'main' } });
    const tool = w.live.capabilities.tools.get('momo_debug_action');
    const p = tool.handler({ text: 'hi' }, { chatId: 'mc', segmentId: 'claude:s1' });
    await waitFor(() => cards.length, 'a card');
    assert.equal(cards[0].params.harness, 'claude');
    w.live.computerUse.broker.answer(cards[0].id, { decision: 'deny' });
    await assert.rejects(p, (e: any) => e.code === 'denied');
    assert.equal(w.m.asks.openFor('mc'), 0);
    await w.m.close();
    const none = world({ controller: false });
    assert.equal(none.live.capabilities.has('momo_debug_action'), true);
    await none.m.close();
  } finally {
    delete process.env.SAGE_DEBUG_TOOLS;
  }
  setMomoContextProvider(null);
});

test('a routine run’s card is asked like any MoMo chat’s; a deleted MoMo chat’s card goes', async () => {
  const w = world({ allowed: true });
  const cards: any[] = [];
  w.live.computerUse.broker = new ApprovalBroker({
    controller: { addApproval: (chatId: string, a: any) => cards.push({ chatId, ...a }), resolveApproval: () => true },
  });
  const seg = (n: string) => [{ kind: 'claude', nativeId: n, start: 0, count: null }];
  w.chats.commit({ id: 'rr', segments: seg('r'), meta: { momo: 'routine', routineId: 'momo.r1' } });
  w.chats.commit({ id: 'mc', segments: seg('m'), meta: { momo: 'main' } });
  w.m.sentinel.setSource('notes', { level: LEVELS.ASK, name: 'Notes' });
  const call = (chatId: string) => ({ chatId, tool: 'notes_write', source: 'notes', kind: 'change', args: { chatId }, summary: 'Write' });
  const until = async (cond: () => boolean) => {
    await waitFor(cond, 'the condition');
  };
  const r = w.m.sentinel.decide(call('rr'));
  await until(() => cards.length === 1);
  assert.equal(w.m.asks.openFor('rr'), 1);
  w.live.computerUse.broker.answer(cards[0].id, { decision: 'deny' });
  await r;
  assert.equal(w.m.asks.openFor('rr'), 0);
  const m = w.m.sentinel.decide(call('mc'));
  await until(() => cards.length === 2);
  await w.live.chatDeletion.delete('mc');
  assert.equal((await m).reason, 'no-answer');
  // a deleted chat that isn't MoMo's has no cards of MoMo's
  w.chats.commit({ id: 'cc', segments: seg('c'), meta: {} });
  w.live.chatDeletion.onDeleted({ chatId: 'cc' });
  assert.equal(w.m.asks.openFor('mc'), 0);
  await w.m.close();
  setMomoContextProvider(null);
});

test('the connect card: asked in an attended MoMo chat, never in a routine run, withdrawn when MoMo is turned off or the chat is deleted', async () => {
  const w = world({ allowed: true });
  const cards: any[] = [];
  w.live.computerUse.broker = new ApprovalBroker({
    controller: { addApproval: (chatId: string, a: any) => cards.push({ chatId, ...a }), resolveApproval: () => true },
  });
  const seg = (n: string) => [{ kind: 'claude', nativeId: n, start: 0, count: null }];
  w.chats.commit({ id: 'mc', segments: seg('m'), meta: { momo: 'main' } });
  w.chats.commit({ id: 'rr', segments: seg('r'), meta: { momo: 'routine', routineId: 'momo.r1' } });
  const until = async (cond: () => boolean) => {
    await waitFor(cond, 'the condition');
  };
  // a routine's run has a scope (the sources its routine reads): nobody is there to click
  w.m.sources.hub.setScope((chatId: string) => (chatId === 'rr' ? { name: 'Morning', sources: ['calendar'] } : null));
  assert.equal(await w.m.connects.ask({ chatId: 'rr', source: 'calendar' }), 'none');
  assert.equal(cards.length, 0);
  const first = w.m.connects.ask({ chatId: 'mc', source: 'calendar' });
  await until(() => cards.length === 1);
  assert.equal(cards[0].method, 'sage/momoConnect');
  assert.deepEqual(cards[0].params, { kind: 'momoConnect', harness: 'claude', momoConnect: { source: 'calendar' } });
  // the chat is deleted: its card goes unanswered
  await w.live.chatDeletion.delete('mc');
  assert.equal(await first, 'none');
  // a deleted chat that isn't MoMo's has no card
  w.chats.commit({ id: 'cc', segments: seg('c'), meta: {} });
  w.live.chatDeletion.onDeleted({ chatId: 'cc' });
  // MoMo turned off for the account: a card still up goes unanswered
  w.chats.commit({ id: 'm2', segments: seg('m2'), meta: { momo: 'main' } });
  const second = w.m.connects.ask({ chatId: 'm2', source: 'reminders' });
  await until(() => cards.length === 2);
  w.allowed = false;
  for (const cb of w.access) cb(false);
  assert.equal(await second, 'none');
  assert.equal(w.m.connects.openCount(), 0);
  await w.m.close();
  setMomoContextProvider(null);
});

test('Outputs: behind the momo.outputs flag, its panel calls reach the real shell and save dialog, its tools are listed, and a save marks a chat that read private data', async () => {
  const { initFlags } = require('../electron/platform/flags.cjs');
  const flags = initFlags({
    file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'momo-flags-')), 'flags.json'),
    url: 'http://127.0.0.1:9/api/flags',
    channel: () => 'stable',
    version: '0.0.0',
    fetch: async () => ({ ok: false }),
    override: { 'momo.outputs': true },
  });
  try {
    const w = world({ allowed: true });
    const made = await w.m.sources.outputs.save({ name: 'plan.md', content: '# plan', chatId: 'mc' });
    assert.equal((await w.call('momoOutputs:list')).files.length, 1);
    assert.equal((await w.call('momoOutputs:open', made.id)).ok, true);
    assert.equal((await w.call('momoOutputs:reveal', made.id)).ok, true);
    assert.equal(w.openedPaths.length, 1);
    assert.equal(w.revealed.length, 1);
    // Save a copy: a sender that is no app window gets no dialog; a cancelled dialog copies nothing; a picked path gets the copy
    assert.equal((await w.from('nope', 'momoOutputs:saveCopy', made.id)).ok, false);
    assert.equal((await w.call('momoOutputs:saveCopy', made.id)).cancelled, true);
    const copy = path.join(w.root, 'copy.md');
    w.saveDialog = { canceled: false, filePath: copy };
    assert.equal((await w.call('momoOutputs:saveCopy', made.id)).cancelled, false);
    assert.equal(fs.readFileSync(copy, 'utf8'), '# plan');
    w.saveDialog = { canceled: false };
    assert.equal((await w.call('momoOutputs:saveCopy', made.id)).cancelled, true, 'no path picked');
    // the tools are listed to a MoMo chat while the flag is on, and a save after a private read says so
    for (const t of ['momo_save_file', 'momo_save_sheet', 'momo_outputs_list']) assert.ok(w.live.capabilities.has(t), t);
    // a MoMo chat saves through the registry: the file lands, and its chat's private reads are marked (sentinel.tainted)
    w.chats.commit({ id: 'mc', segments: [{ kind: 'claude', nativeId: 's1', start: 0, count: null }], meta: { momo: 'main' } });
    const saved = await w.live.capabilities.tools
      .get('momo_save_file')
      .handler({ name: 'via-tool.md', content: 'x' }, { chatId: 'mc', segmentId: 'claude:s1' });
    assert.match(saved, /^Saved via-tool\.md/);
    assert.equal(
      w.m.sources.outputs.list().some((f: any) => f.name === 'via-tool.md' && f.fromPrivate === false),
      true,
    );
    await w.m.close();
  } finally {
    flags.stop();
    setMomoContextProvider(null);
  }
});

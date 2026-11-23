// electron/momo/brainEffort.cjs and its use in electron/momo/mainChat.cjs (#2139): MoMo's brain keeps an effort, checked
// against the efforts its model offers (one it lacks becomes its default; none without levels), carried across a model or
// harness change, pinned for the main chat's turns on Codex and Claude Code (over a window's push and a switch's config),
// and never on a basic harness (its session's own thought level). Background passes ask for low effort.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { world, switched, gate } from './support/momoWorld.ts';

const require = createRequire(import.meta.url);
const { askedEffort, effortOn, brainEffort, effortSources, LISTS } = require('../electron/momo/brainEffort.cjs');
const { brainOf, pinModel } = require('../electron/momo/brainModel.cjs');
const { momoEffortOf, MOMO_EFFORT_KEY } = require('../shared/momoChat.mjs');
const { claudeTurnSettings } = require('../electron/harness/claude/turnSettings.cjs');
const { adapterSettings } = require('../electron/session/adapterSettings.cjs');
const { windowPatch } = require('../electron/platform/windowMetaPatch.cjs');
const { settledFor } = require('../electron/momo/settle.cjs');

/** Codex's model/list: gpt-5 offers low..high (default medium), gpt-mini only minimal, gpt-flat none. */
const codexList = async () => ({
  data: [
    {
      model: 'gpt-5',
      isDefault: true,
      supportedReasoningEfforts: [{ reasoningEffort: 'low' }, { reasoningEffort: 'medium' }, { reasoningEffort: 'high' }],
      defaultReasoningEffort: 'medium',
    },
    { model: 'gpt-mini', supportedReasoningEfforts: ['minimal'], defaultReasoningEffort: 'minimal' },
    { model: 'gpt-flat' },
  ],
});
/** Claude Code's probe: opus offers low..max (default high), haiku none. */
const claudeProbe = () => ({
  models: [
    { value: 'opus', displayName: 'Opus', supportedEffortLevels: ['low', 'medium', 'high', 'max'] },
    { value: 'haiku', displayName: 'Haiku' },
  ],
});

test('the effort asked for: given (a non-string is none), else the one MoMo had', () => {
  assert.equal(askedEffort({ effort: 'high' }, { effort: 'low' }), 'high');
  assert.equal(askedEffort({ effort: null }, { effort: 'low' }), null);
  assert.equal(askedEffort({ effort: 5 }, { effort: 'low' }), null);
  assert.equal(askedEffort({ effort: '' }, { effort: 'low' }), null);
  assert.equal(askedEffort({ effort: undefined }, { effort: 'low' }), 'low');
  assert.equal(askedEffort({}, { effort: 'low' }), 'low');
  assert.equal(askedEffort(null, null), null);
  assert.equal(askedEffort({}, {}), null);
});

test('an effort on a model: kept where offered, else its default; none without levels; an unknown model keeps it', () => {
  const m = { id: 'x', efforts: ['low', 'high'], defaultEffort: 'high' };
  assert.equal(effortOn('low', m), 'low');
  assert.equal(effortOn('max', m), 'high');
  assert.equal(effortOn(null, m), 'high');
  assert.equal(effortOn('max', { ...m, defaultEffort: null }), null);
  assert.equal(effortOn('low', { id: 'x', efforts: [], defaultEffort: null }), null);
  assert.equal(effortOn('max', undefined), 'max');
});

test('a brain’s effort is checked against its harness’s live list', async () => {
  const src = { codexModels: codexList, claudeProbe };
  const codex = (model: string | null, effort: string | null) => brainEffort({ harness: 'codex', account: null, model, effort }, src);
  assert.equal(await codex('gpt-5', 'high'), 'high');
  assert.equal(await codex('gpt-5', 'max'), 'medium');
  // no model named: the harness's default model
  assert.equal(await codex(null, 'max'), 'medium');
  // efforts listed as bare ids too
  assert.equal(await codex('gpt-mini', 'high'), 'minimal');
  assert.equal(await codex('gpt-flat', 'high'), null);
  // a model the list doesn't have, a list that isn't one, one that fails: the effort as asked
  assert.equal(await codex('gpt-9', 'xhigh'), 'xhigh');
  assert.equal(await brainEffort({ harness: 'codex', model: 'gpt-5', effort: 'max' }, { ...src, codexModels: async () => ({}) }), 'max');
  const down = {
    ...src,
    codexModels: async () => {
      throw new Error('app-server down');
    },
  };
  assert.equal(await brainEffort({ harness: 'codex', model: 'gpt-5', effort: 'max' }, down), 'max');
  const claude = (model: string, effort: string | null, account: string | null = null) =>
    brainEffort({ harness: 'claude', account, model, effort }, src);
  assert.equal(await claude('opus', 'max'), 'max');
  assert.equal(await claude('opus', 'xhigh'), 'high');
  assert.equal(await claude('haiku', 'high'), null);
  // the login's own probe, and none yet
  const asked: unknown[] = [];
  await brainEffort(
    { harness: 'claude', account: 'du@work', model: 'opus', effort: 'low' },
    { ...src, claudeProbe: (a: unknown) => (asked.push(a), null) },
  );
  assert.deepEqual(asked, ['du@work']);
  assert.equal(
    await brainEffort({ harness: 'claude', account: null, model: 'opus', effort: 'low' }, { ...src, claudeProbe: () => ({}) }),
    'low',
  );
  assert.equal(
    await brainEffort({ harness: 'claude', account: null, model: 'opus', effort: 'low' }, { ...src, claudeProbe: () => null }),
    'low',
  );
  // nothing to read: as asked; a basic harness: none
  assert.equal(await brainEffort({ harness: 'claude', model: 'opus', effort: 'low' }, undefined), 'low');
  assert.equal(await brainEffort({ harness: 'acp:kimi', model: null, effort: 'high' }, src), null);
  assert.equal(LISTS.acp, null);
});

test('main’s sources: Codex’s app-server list and the login’s last Claude Code probe, none before they exist', async () => {
  const asked: unknown[] = [];
  const src = effortSources({
    codex: { modelList: async () => ({ data: [] }) },
    claudeTurns: { probeInfo: (a: unknown) => (asked.push(a), a === 'du@work' ? { models: [] } : undefined) },
  });
  assert.deepEqual(await src.codexModels(), { data: [] });
  assert.deepEqual(src.claudeProbe('du@work'), { models: [] });
  assert.equal(src.claudeProbe('other'), null);
  assert.deepEqual(asked, ['du@work', 'other']);
  const none = effortSources({});
  assert.equal(await none.codexModels(), undefined);
  assert.equal(none.claudeProbe(), null);
});

test('a brain is read with its effort; a basic harness names none', () => {
  assert.equal(brainOf({ harness: 'codex', effort: 'high' }).effort, 'high');
  assert.equal(brainOf({ harness: 'codex', effort: 3 }).effort, null);
  assert.equal(brainOf({ harness: 'acp:kimi', effort: 'high' }).effort, null);
});

test('setBrain keeps the effort asked for where the model offers it, else the model’s default; carried across changes', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'opus' } } } } });
  w.codexModels = codexList;
  w.claudeProbe = claudeProbe;
  const { chatId } = await w.svc.ensureMainChat();
  let r = await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'max' });
  assert.equal(r.brain.effort, 'max');
  assert.equal(w.svc.getBrain().effort, 'max');
  // applied now: the pin over a window's push, and the chat's own pick
  assert.equal(w.chats.records.get(chatId).meta.momoEffort, 'max');
  assert.equal(w.brains.at(-1).effort, 'max');
  // one opus doesn't offer: its default
  r = await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'xhigh' });
  assert.equal(r.brain.effort, 'high');
  // a model change that names no effort keeps it where the new model offers it
  await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'low' });
  r = await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus' });
  assert.equal(r.brain.effort, 'low');
  // a model without levels has none, and its pin clears
  r = await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'haiku' });
  assert.equal(r.brain.effort, null);
  assert.equal(w.chats.records.get(chatId).meta.momoEffort, null);
  // the composer's own model pick (#2304) goes through the same check
  await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'max' });
  await w.svc.setChatModel(chatId, 'haiku', 'Haiku');
  assert.equal(w.svc.getBrain().effort, null);
});

test('a harness change carries the effort where the new harness’s model offers it, pinned for the switch’s own turn', async () => {
  const w = world({ prefs: { model: 'gpt-5', momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'opus' } } } } });
  w.codexModels = codexList;
  w.claudeProbe = claudeProbe;
  const { chatId } = await w.svc.ensureMainChat();
  await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'high' });
  // to Codex: high is one gpt-5 offers, pinned now (the switch rewrites the chat's config when it lands)
  let r = await w.svc.setBrain({ harness: 'codex', account: null, model: 'gpt-5' });
  assert.equal(r.applied, 'nextMessage');
  assert.equal(r.brain.effort, 'high');
  assert.deepEqual([w.chats.records.get(chatId).meta.momoModel, w.chats.records.get(chatId).meta.momoEffort], [null, 'high']);
  // the switch lands: max isn't one gpt-5 offers, so its default
  switched(w, chatId, 'codex', 'th-7');
  r = await w.svc.setBrain({ harness: 'codex', account: null, model: 'gpt-5', effort: 'max' });
  assert.equal(r.brain.effort, 'medium');
  assert.equal(w.chats.records.get(chatId).meta.momoEffort, 'medium');
  // back to Claude Code with no effort named: medium is one opus offers
  r = await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus' });
  assert.equal(r.brain.effort, 'medium');
  assert.equal(w.chats.records.get(chatId).meta.momoEffort, 'medium');
});

test('a basic harness’s brain names no effort, and its chat has no pin', async () => {
  const w = world();
  const { chatId } = await w.svc.ensureMainChat();
  await w.svc.setBrain({ harness: 'codex', account: null, model: 'gpt-6', effort: 'high' });
  assert.equal(w.chats.records.get(chatId).meta.momoEffort, 'high');
  const r = await w.svc.setBrain({ harness: 'acp:opencode', effort: 'high' });
  assert.equal(r.brain.effort, null);
  assert.equal(w.chats.records.get(r.chatId).meta.momoEffort, null);
});

test('a background pass runs at the effort it asks for, where its model offers it', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'opus', effort: 'max' } } } } });
  w.claudeProbe = claudeProbe;
  const run = await w.svc.startBackground({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'low' }, { momo: 'memory' });
  assert.equal(w.chats.records.get(run).meta.momoEffort, 'low');
  // haiku has no levels: none
  const cheap = await w.svc.startBackground({ harness: 'claude', account: 'du@work', model: 'haiku', effort: 'low' }, { momo: 'nudge' });
  assert.equal(w.chats.records.get(cheap).meta.momoEffort, null);
  // the main brain's effort is untouched
  assert.equal(w.svc.getBrain().effort, 'max');
});

test('the pin: model and effort together; only MoMo’s chats read it; only main writes it', () => {
  const metas = new Map<string, any>([['m', { meta: { momo: 'main' } }]]);
  const chats = {
    records: metas,
    patchMeta: (id: string, patch: object) => (metas.set(id, { meta: { ...metas.get(id)?.meta, ...patch } }), true),
  };
  assert.equal(pinModel(chats, 'm', { harness: 'claude', model: 'opus', effort: 'max' }), true);
  assert.equal(momoEffortOf(metas.get('m').meta), 'max');
  assert.equal(pinModel(chats, 'm', { harness: 'claude', model: 'opus', effort: 'max' }), false);
  // the effort alone changing is a change
  assert.equal(pinModel(chats, 'm', { harness: 'claude', model: 'opus' }), true);
  assert.equal(momoEffortOf(metas.get('m').meta), null);
  assert.equal(momoEffortOf({ momoEffort: 'max' }), null);
  assert.equal(momoEffortOf({ momo: 'main', momoEffort: '' }), null);
  assert.equal(MOMO_EFFORT_KEY, 'momoEffort');
  // a window can't write it
  assert.deepEqual(windowPatch({ momoEffort: 'max', unread: true }, { momo: 'main', momoEffort: 'low' }), { unread: true });
  const live = { chats: { records: new Map([['m', { meta: { momo: 'main', momoModel: 'opus', momoEffort: 'max' } }]]) } };
  const s = adapterSettings(live);
  assert.deepEqual([s.pinnedModel('m'), s.pinnedEffort('m'), s.pinnedModel('x'), s.pinnedEffort('x')], ['opus', 'max', null, null]);
  // Codex reads it over the chat's config; a chat with no pin reads its config as it is
  live.chats.records.set('k', { meta: { momo: 'main', momoEffort: 'low', config: { model: 'gpt-5', effort: 'high' } } } as any);
  live.chats.records.set('p', { meta: { config: { model: 'gpt-5', effort: 'high' } } } as any);
  assert.deepEqual(s.codex.chatConfig('k'), { model: 'gpt-5', effort: 'low' });
  assert.deepEqual(s.codex.chatConfig('p'), { model: 'gpt-5', effort: 'high' });
  assert.deepEqual(s.codex.chatConfig('m'), { effort: 'max' });
  assert.equal(s.codex.chatConfig('x'), null);
});

test('a Claude Code turn runs at the pinned effort over a window’s push; unpinned, the chat’s own then the default', () => {
  const adapter = (pinned: string | null, effort: string | null, own: any) => ({
    prefs: () => ({ claudeSelection: { model: 'sonnet', effort: 'medium' } }),
    accountOf: () => null,
    savedSettings: () => null,
    own: new Map(own ? [['c', own]] : []),
    pinnedModel: () => pinned,
    pinnedEffort: () => effort,
    probeInfo: () => null,
  });
  const st = (a: any) => claudeTurnSettings(a, 'c', {});
  assert.equal(st(adapter('opus', 'max', { model: 'opus', effort: 'low' })).effort, 'max');
  // pinned with no effort: the chat's own for that model, else the default
  assert.equal(st(adapter('opus', null, { model: 'opus', effort: 'low' })).effort, 'low');
  assert.equal(st(adapter('opus', null, { model: 'sonnet', effort: 'low' })).effort, 'medium');
  // a brain that names no model still pins its effort, over the chat's own and with no model at all
  assert.equal(st(adapter(null, 'max', { model: 'opus', effort: 'low' })).effort, 'max');
  assert.deepEqual([st(adapter(null, 'max', null)).model, st(adapter(null, 'max', null)).effort], ['sonnet', 'max']);
  // no pin: the chat's own, else the default
  assert.equal(st(adapter(null, null, { model: 'opus', effort: 'low' })).effort, 'low');
  assert.equal(st(adapter(null, null, null)).effort, 'medium');
  // a message's own effort still wins
  assert.equal(claudeTurnSettings(adapter('opus', 'max', null), 'c', { effort: 'low' }).effort, 'low');
});

/** What a Claude Code turn starting now would run at in `chatId`: the pin it reads (adapterSettings → turnSettings). */
const turnEffort = (w: any, chatId: string, base: string | null = null) =>
  claudeTurnSettings(
    {
      prefs: () => ({ claudeSelection: { model: 'opus', effort: base } }),
      accountOf: () => null,
      savedSettings: () => null,
      own: new Map(),
      pinnedModel: () => null,
      pinnedEffort: (id: string) => momoEffortOf(w.chats.records.get(id)?.meta),
      probeInfo: () => null,
    },
    chatId,
    {},
  ).effort;

test('a message sent right after an effort pick runs at the effort the chip shows: the send waits for the change main is still checking (#3907)', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'opus' } } } } });
  w.claudeProbe = claudeProbe;
  const { chatId } = await w.svc.ensureMainChat();
  // the chip moved at once; main is still checking that the harness can run, which comes before the pin is written
  const list = gate();
  w.usableGate = list.p;
  const change = w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'medium' });
  await new Promise((r) => setTimeout(r, 5));
  assert.notEqual(
    turnEffort(w, chatId),
    'medium',
    'the window the bug lived in: the pick is not pinned yet, a turn would run on the old effort',
  );
  let sent = false;
  const waiting = settledFor(w.svc, chatId).then(() => (sent = true));
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(sent, false, 'the send waits for the change');
  list.open();
  await change;
  await waiting;
  assert.equal(turnEffort(w, chatId), 'medium', 'and then runs at the pick');
});

test('the wait for a brain change: not for a chat that is not MoMo’s, over when the change failed (the pin is what main has), bounded, and never for later changes', async () => {
  const w = world({ prefs: { momo: { brain: { main: { harness: 'claude', account: 'du@work', model: 'opus', effort: 'high' } } } } });
  w.claudeProbe = claudeProbe;
  const { chatId } = await w.svc.ensureMainChat();
  await w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'high' });
  // nothing in flight, a chat that is not MoMo's, or MoMo off: no wait and no failure
  await settledFor(w.svc, chatId);
  await settledFor(w.svc, 'someone-elses');
  w.allowed = false;
  await settledFor(w.svc, chatId);
  w.allowed = true;
  // a change that fails: the send goes on with the pin main has, and the failure stays the change's own
  const list = gate();
  w.usableGate = list.p;
  w.unusable.add('claude');
  const failing = w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'low' });
  const failed = assert.rejects(failing, { code: 'unavailable' });
  const settled = settledFor(w.svc, chatId);
  list.open();
  await failed;
  await settled;
  assert.equal(turnEffort(w, chatId), 'high', 'a failed change leaves the pin it had');
  w.unusable.clear();
  // a change that never settles: the send is held only for the bound
  const stuck = gate();
  w.usableGate = stuck.p;
  const hung = w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'low' });
  const t0 = Date.now();
  await settledFor(w.svc, chatId, 30);
  assert.ok(Date.now() - t0 >= 25 && Date.now() - t0 < 2000, 'bounded');
  // a change asked for after the send began is not waited for
  stuck.open();
  await hung;
  const later = gate();
  w.usableGate = later.p;
  const early = settledFor(w.svc, chatId);
  const after = w.svc.setBrain({ harness: 'claude', account: 'du@work', model: 'opus', effort: 'medium' });
  await early;
  later.open();
  await after;
});

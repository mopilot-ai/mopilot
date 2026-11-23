// The edges of MoMo's Host adapters (host/src/momoCoreHost.mjs, the notes, gate and learning services, the notes wire methods): the card store's retention and compare-and-set, the audit sink, a home that moves under a running call, a build that fails, an idle Host, and every parser of the notes wire methods.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createAuditSink, createCardStore, createKeyedHash } from '../host/src/momoCoreHost.mjs';
// @ts-ignore
import gateService from '../host/src/momoServices/gate.mjs';
// @ts-ignore
import learningService from '../host/src/momoServices/learning.mjs';
// @ts-ignore
import notesService from '../host/src/momoServices/notes.mjs';
// @ts-ignore
import momoNotesMethods from '../host/src/methods/momoNotes.mjs';
// @ts-ignore
import notesWire from '../shared/host/methods/momoNotes.mjs';
// @ts-ignore
import { createFileSafeStorage } from '../host/src/secretStore.mjs';
import { A, host } from './support/host/momoMoveWorld.ts';

const DAY = 86_400_000;
const NOW = 1_700_000_000_000;
const card = (over: object = {}): any => ({
  id: 'c1',
  fingerprint: 'f',
  bindKey: 'b',
  tool: 't',
  effect: 'send',
  scope: 's',
  summary: 'x',
  origin: 'chat',
  tainted: false,
  reason: 'no_rule',
  createdAt: NOW,
  expiresAt: null,
  status: 'open',
  ...over,
});
const send = (over: object = {}) => ({
  tool: 'gmail.send',
  effect: 'send' as const,
  scope: 'd@x.com',
  args: { n: 1 },
  origin: 'chat' as const,
  chatId: 'c1',
  summary: 's',
  ...over,
});

test('the card store keeps recent cards, drops old settled and malformed ones, and changes a card only from the status expected', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-cards-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let at = NOW;
  const store = createCardStore({ dir, safeStorage: createFileSafeStorage(path.join(dir, 'k')), now: () => at });
  assert.deepEqual(await store.list(), []);
  await store.put(card({ id: 'open-old', createdAt: NOW - 30 * DAY }));
  await store.put(card({ id: 'used-old', status: 'used', usedAt: NOW - 30 * DAY, decidedAt: NOW }));
  await store.put(card({ id: 'denied-old', status: 'denied', decidedAt: NOW - 30 * DAY }));
  await store.put(card({ id: 'expired-old', status: 'expired', createdAt: NOW - 30 * DAY }));
  await store.put(card({ id: 'denied-new', status: 'denied', decidedAt: NOW - DAY, fingerprint: 'g' }));
  await store.put({ id: 'bad', status: 'open' } as any);
  await store.put({ id: 'bad2' } as any);
  await store.put({ status: 'open', fingerprint: 'h' } as any);
  assert.deepEqual((await store.list()).map((c: any) => c.id).sort(), ['denied-new', 'open-old']);
  assert.deepEqual(
    (await store.list(['denied'])).map((c: any) => c.id),
    ['denied-new'],
  );
  assert.deepEqual(
    (await store.byFingerprint('g')).map((c: any) => c.id),
    ['denied-new'],
  );
  assert.equal((await store.get('open-old'))?.id, 'open-old');
  assert.equal(await store.transition('open-old', 'allowed', { status: 'used' }), undefined);
  assert.equal(await store.transition('nope', 'open', { status: 'used' }), undefined);
  await store.transition('open-old', 'open', { status: 'deciding', decidedBy: 'a' });
  const back: any = await store.transition('open-old', 'deciding', { status: 'open', decidedBy: undefined });
  assert.deepEqual([back.status, 'decidedBy' in back], ['open', false]);
  at += 1;
});

test('the audit sink writes a refusal as a refusal and everything else as an intent with its outcome, and fails when there is no log', async () => {
  const lines: any[] = [];
  const log = {
    refusal: async (f: any) => void lines.push(['refusal', f]),
    intent: async (f: any) => (lines.push(['intent', f]), { id: 'i1' }),
    outcome: async (id: string, o: any) => void lines.push(['outcome', id, o]),
  };
  const sink = createAuditSink(() => log);
  await sink.append({ event: 'action.refused', at: 1, tool: 'gmail.send', chatId: 'c1', reason: 'rule_deny', fingerprint: 'f' });
  await sink.append({ event: 'approval.decided', at: 1, cardId: 'c', verdict: 'allowed', by: 'phone:abc' });
  await sink.append({ event: 'approval.policy.changed', at: 1, reason: 'added' });
  assert.deepEqual(
    lines.map((l) => l[0]),
    ['refusal', 'intent', 'outcome', 'intent', 'outcome'],
  );
  assert.deepEqual([lines[1][1].device, lines[1][1].chatId, lines[1][1].decision], ['phone:abc', 'none', 'allowed']);
  assert.equal(lines[3][1].decision, 'added');
  assert.equal(lines[0][1].args.fingerprint, 'f');
  await assert.rejects(createAuditSink(() => null).append({ event: 'action.allowed', at: 1 }), /audit log is not available/);
});

test('the keyed hash is made once and is the same after a restart', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const safeStorage = createFileSafeStorage(path.join(dir, 'k'));
  const first = await createKeyedHash({ dir, safeStorage, now: () => NOW });
  const again = await createKeyedHash({ dir, safeStorage, now: () => NOW });
  assert.equal(first.keyed, true);
  assert.equal(first('x'), again('x'));
  assert.notEqual(first('x'), first('y'));
});

test('the gate on a home that moves under a call, on a home with no rules service, and with a build that fails', async (t) => {
  const h = await host(t, A);
  await h.home.start(A);
  const reports: string[] = [];
  let current = true;
  const home: any = Object.assign(Object.create(h.home), { current: () => current });
  gateService({ home, now: () => NOW, report: (m: string) => reports.push(m) });
  const gate = h.home.service('gate') ?? home.service('gate');
  // no chat id, no learning service: the gate still decides
  assert.equal((await gate.run(send({ chatId: undefined, effect: 'read', scope: 'inbox' }), () => 1)).done, true);
  const asked = await gate.run(send(), () => 1);
  await gate.answer(asked.card.id, 'allow', 'phone:abc');
  current = false;
  assert.deepEqual(await gate.run(send({ effect: 'read', scope: 'inbox', args: {} }), () => 1), { refused: true, reason: 'moved' });
  const ran: any = await gate.resume(asked.card.id, send({ chatId: undefined }), () => 1);
  assert.deepEqual(ran, { refused: true, reason: 'mismatch' });
  const refused = await gate.resume(asked.card.id, send(), () => 1);
  assert.deepEqual(refused, { refused: true, reason: 'moved' });
  current = true;
  const noChat = await gate.run(send({ chatId: undefined, args: { z: 1 } }), () => 1);
  await gate.answer(noChat.card.id, 'allow', 'phone:abc');
  current = false;
  assert.deepEqual(await gate.resume(noChat.card.id, send({ chatId: undefined, args: { z: 1 } }), () => 1), {
    refused: true,
    reason: 'moved',
  });
  assert.equal((await gate.cards('phone:abc')).find((c: any) => c.id === noChat.card.id).status, 'failed');
  // a build that fails is reported and tried again next time
  const broken: any = Object.assign(Object.create(h.home), { storage: undefined });
  const services = new Map<string, any>();
  broken.provide = (id: string, api: any) => services.set(id, api);
  broken.use = () => undefined;
  gateService({ home: broken, now: () => NOW });
  await assert.rejects(services.get('gate').cards('a'));
  await assert.rejects(services.get('gate').cards('a'));
});

test('an idle Host keeps nothing: the learning and notes services answer empty and write nothing', async (t) => {
  const h = await host(t, A);
  const deps = { home: h.home, now: () => NOW };
  learningService(deps);
  notesService(deps);
  gateService(deps);
  const learning = h.home.service('learning');
  const notes = h.home.service('notes');
  assert.deepEqual(
    [await learning.react({ pattern: 'p', label: 'x', kind: 'dismiss' }), await learning.suggest({ text: 'a', sourceId: 's', quote: 'q' })],
    [null, null],
  );
  assert.deepEqual(
    [await notes.undo('j', 'a'), await notes.edit('n', 'l', 'x', 'a'), await notes.tidyIfDue(), await notes.restore('s', 'a')],
    [null, null, null, null],
  );
  assert.deepEqual(notes.snapshotTree(), { notes: [], archive: [] });
  const methods: any = momoNotesMethods({ momo: h.home });
  assert.deepEqual(
    await methods.handlers['host.momoReact']({ cardId: 'c', kind: 'deny' }, 'phone', {
      principal: () => ({ kind: 'phone', fingerprint: 'a' }),
    }),
    { counted: false, change: null, retired: [] },
  );
  await h.home.lifecycle('pause');
});

test('notes keep the last 300 changes and drop the undo entries of the ones that fell off, and say how many lines an undo restored', async (t) => {
  const h = await host(t, A);
  await h.home.start(A);
  let at = NOW;
  const deps = { home: h.home, now: () => at };
  gateService(deps);
  learningService(deps);
  notesService(deps);
  const notes = h.home.service('notes');
  t.after(() => h.home.lifecycle('pause'));
  const chat = {
    id: 'm1',
    kind: 'chat',
    at: '2026-11-22T10:00:00.000Z',
    text: 'I prefer email to calls. I also like tea in the evening.',
    owner: true,
  };
  const add = (text: string, quote: string) => ({ type: 'add', title: 'Dana', kind: 'person', sourceId: 'm1', text, quote });
  const two = await notes.ops(
    [add('Prefers email to calls', 'I prefer email to calls'), add('Likes tea in the evening', 'like tea in the evening')],
    { chatId: 'momo-chat', sources: [chat], trigger: 'chat' },
  );
  assert.equal(two.applied.length, 2);
  assert.equal(await h.home.service('learning').suggest({ text: '  ', sourceId: 's', quote: 'q' }), null);
  const journalId = notes.view()[0].history[0].id;
  assert.deepEqual(await notes.undo(journalId, 'phone:abc'), { restored: 2, skipped: 0, found: true });
  const first = await notes.ops([add('Prefers email to calls', 'I prefer email to calls')], {
    chatId: 'momo-chat',
    sources: [chat],
    trigger: 'chat',
  });
  assert.equal(first.applied.length, 1);
  const firstId = notes.view()[0].history.at(-1).id;
  for (let i = 0; i < 305; i++) await notes.ops([{ type: 'nope' }], { chatId: 'momo-chat', sources: [chat], trigger: 'chat' });
  assert.deepEqual(await notes.undo(firstId, 'phone:abc'), { restored: 0, skipped: 0, found: false });
  // a night with something to let go keeps an undo for it
  const mail = {
    id: 'mail1',
    kind: 'mail',
    at: '2026-11-22T10:00:00.000Z',
    text: 'He lives in Berlin now and likes cycling',
    owner: false,
  };
  await notes.ops(
    [{ type: 'add', title: 'Bob', kind: 'person', sourceId: 'mail1', text: 'Lives in Berlin now', quote: 'lives in Berlin now' }],
    { chatId: 'momo-chat', sources: [mail], trigger: 'change' },
  );
  at += 70 * DAY;
  const night = await notes.tidyIfDue();
  assert.equal(night.deferred, 0);
  const bob = notes.view().find((n: any) => n.title === 'Bob');
  assert.deepEqual(
    bob.lines.map((l: any) => l.status),
    ['let-go'],
  );
  assert.equal(bob.history.at(-1).undoable, true);
});

test('every parser of the notes wire methods accepts a whole request and refuses the rest', () => {
  const bad = (m: string) => new Error(m);
  const matchOf = (v: unknown, re: RegExp, message: string) => {
    if (typeof v !== 'string' || !re.test(v)) throw bad(message);
    return v;
  };
  const { methods, features } = notesWire({ bad, matchOf }) as any;
  assert.deepEqual(features, ['momo']);
  const parse = (m: string, p: unknown) => methods[m].parse(p);
  assert.deepEqual([parse('host.momoCards', {}), parse('host.momoNotes', {}), parse('host.momoRules', {})], [{}, {}, {}]);
  assert.deepEqual(parse('host.momoCardAnswer', { cardId: 'c-1', decision: 'deny' }), { cardId: 'c-1', decision: 'deny' });
  assert.throws(() => parse('host.momoCardAnswer', { cardId: 'c-1', decision: 'maybe' }), /not an answer/);
  assert.throws(() => parse('host.momoCardAnswer', { cardId: 'c 1', decision: 'allow' }), /card id/);
  assert.deepEqual(parse('host.momoNoteAct', { op: 'tidy' }), { op: 'tidy' });
  assert.deepEqual(parse('host.momoNoteAct', { op: 'undo', journalId: 'j1' }), { op: 'undo', journalId: 'j1' });
  assert.deepEqual(parse('host.momoNoteAct', { op: 'restore', snapshotId: 's1' }), { op: 'restore', snapshotId: 's1' });
  assert.deepEqual(parse('host.momoNoteAct', { op: 'bring-back', lineId: 'l1' }), { op: 'bring-back', lineId: 'l1' });
  assert.deepEqual(parse('host.momoNoteAct', { op: 'edit', noteId: 'n1', lineId: 'l1', text: 'Hi' }), {
    op: 'edit',
    noteId: 'n1',
    lineId: 'l1',
    text: 'Hi',
  });
  for (const p of [
    { op: 'wipe' },
    { op: 'edit', noteId: 'n1', lineId: 'l1', text: '  ' },
    { op: 'edit', noteId: 'n1', lineId: 'l1', text: 'x'.repeat(4001) },
    { op: 'undo' },
  ])
    assert.throws(() => parse('host.momoNoteAct', p));
  assert.deepEqual(parse('host.momoRuleAct', { op: 'confirm', ruleId: 'r1' }), { op: 'confirm', ruleId: 'r1' });
  assert.deepEqual(parse('host.momoRuleAct', { op: 'edit', ruleId: 'r1', text: 'Quiet' }), { op: 'edit', ruleId: 'r1', text: 'Quiet' });
  assert.throws(() => parse('host.momoRuleAct', { op: 'edit', ruleId: 'r1' }), /not a rule/);
  assert.throws(() => parse('host.momoRuleAct', { op: 'zap', ruleId: 'r1' }), /something to do with a rule/);
  assert.deepEqual(parse('host.momoReact', { cardId: 'c-1', kind: 'always_allow' }), { cardId: 'c-1', kind: 'always_allow' });
  assert.deepEqual(parse('host.momoReact', { cardId: 'c-1', kind: 'deny', pattern: 'forged', action: { tool: 'x' } }), {
    cardId: 'c-1',
    kind: 'deny',
  });
  for (const p of [{ cardId: 'c-1', kind: 'dismiss' }, { cardId: 'c 1', kind: 'deny' }, { kind: 'deny' }])
    assert.throws(() => parse('host.momoReact', p));
});

test('the tool registry’s chokepoint: MoMo’s own tools run, an unknown tool needs a card, a refusal is a readable error, an Allow is spent by the retry, and the phones are told', async (t) => {
  const h = await host(t, A);
  await h.home.start(A);
  const pushed: any[] = [];
  (h.home as any).push = { cardChanged: (c: any) => pushed.push(c) };
  const deps = { home: h.home, now: () => NOW };
  learningService(deps);
  gateService(deps);
  t.after(() => h.home.lifecycle('pause'));
  const gate = (h.home as any).gate;
  let ran = 0;
  const run = () => ++ran;
  assert.equal(await gate.run({ chatId: 'momo-chat', tool: 'momo_memory_save', args: { text: 'x' }, origin: 'chat' }, run), 1);
  assert.equal(await gate.run({ chatId: 'momo-chat', tool: 'momo_memory_search', origin: 'chat' }, run), 2);
  assert.equal(h.home.service('gate').taintFor('momo-chat').tainted(), false);
  const call = { chatId: 'momo-chat', tool: 'web_fetch', args: { url: 'https://example.org' }, origin: 'chat' as const };
  const waiting = await gate.run(call, run).catch((e: any) => e);
  assert.deepEqual([waiting.code, ran], ['approval_pending', 2]);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pushed[0].status, 'open');
  assert.equal(pushed[0].chatId, 'momo-chat');
  const [card] = (await h.home.service('gate').cards('phone:abc')).filter((c: any) => c.status === 'pending');
  await h.home.service('gate').answer(card.id, 'allow', 'phone:abc');
  assert.equal(await gate.run(call, run), 3);
  assert.equal(h.home.service('gate').taintFor('momo-chat').tainted(), true);
  const again = await gate.run(call, run).catch((e: any) => e);
  assert.equal(again.code, 'approval_pending');
  // refusals the model can read, by their codes
  const owner = { id: 'no', behavior: 'deny' as const, tool: 'momo_*', effect: '*', scope: '*', text: 'Never' };
  await h.home.service('learning').addOwnerRule(owner, 'desktop:def');
  assert.equal(
    (await gate.run({ chatId: 'c', tool: 'momo_memory_search', args: {}, origin: 'chat' }, run).catch((e: any) => e)).code,
    'denied',
  );
  assert.equal(
    (await gate.run({ chatId: 'c', tool: 'momo_memory_save', args: {}, origin: 'unprompted' }, run).catch((e: any) => e)).code,
    'denied',
  );
  await h.home.service('learning').removeOwnerRule('no', 'desktop:def');
  assert.equal(
    (await gate.run({ chatId: 'c', tool: 'web_fetch', args: {}, origin: 'unprompted' }, run).catch((e: any) => e)).code,
    'read_only',
  );
  assert.equal(
    (await gate.run({ chatId: 'c', tool: 'momo_memory_save', args: { when: new Date() }, origin: 'chat' }, run).catch((e: any) => e)).code,
    'invalid',
  );
  // a tool that fails keeps its own code and message; a reason nobody listed is just refused
  const boom = Object.assign(new Error('The store is closed'), { code: 'unavailable' });
  const failed = await gate
    .run({ chatId: 'c', tool: 'momo_memory_search', args: { q: 1 }, origin: 'chat' }, () => Promise.reject(boom))
    .catch((e: any) => e);
  assert.deepEqual([failed.message, failed.code], ['The store is closed', 'unavailable']);
  const plain = await gate
    .run({ chatId: 'c', tool: 'momo_memory_search', args: { q: 2 }, origin: 'chat' }, () => Promise.reject(new Error('x')))
    .catch((e: any) => e);
  assert.equal(plain.code, 'failed');
  const idle = await host(t, A);
  gateService({ home: idle.home, now: () => NOW });
  assert.equal(
    (
      (await (idle.home as any).gate
        .run({ chatId: 'c', tool: 'momo_memory_search', args: {}, origin: 'chat' }, run)
        .catch((e: any) => e)) as any
    ).code,
    'unavailable',
  );
  assert.equal(
    ((await (idle.home as any).gate.run({ chatId: 'c', tool: 'web_fetch', args: {}, origin: 'chat' }, run).catch((e: any) => e)) as any)
      .code,
    'unavailable',
  );
});

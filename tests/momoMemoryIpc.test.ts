// MoMo's Memory tab IPC (#2139, electron/momo/memoryIpc.cjs) over a fake ipcMain and a real store: every handler refuses while MoMo is not allowed, the list shows expired facts and a search does not, edits and deletes reach the store, wrong input fails with a reason, and the handlers can be removed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { CHANNELS: LOOP_CHANNELS } = require('../electron/momo/loopsIpc.cjs');
const { MemoryStore } = require('../electron/momo/memory.cjs');
const { registerMemoryIpc, CHANNELS, NOT_ALLOWED } = require('../electron/momo/memoryIpc.cjs');
const { loadBridge, channelsOf } = require('../electron/bridge/spec.cjs');
import { fakeSafe } from './support/momo-memory.ts';

const made: string[] = [];
after(() => {
  for (const d of made) fs.rmSync(d, { recursive: true, force: true });
});

function setup() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ipc-'));
  made.push(d);
  let now = 1_000;
  let n = 0;
  const safe = fakeSafe();
  const store = new MemoryStore({
    dir: d,
    safeStorage: safe,
    isMomoChat: (id: string) => id === 'momo-main',
    now: () => now,
    newId: () => `f${++n}`,
  });
  const handlers = new Map<string, Function>();
  const ipcMain = { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: (ch: string) => handlers.delete(ch) };
  const gate = { allowed: true };
  const sent: string[] = [];
  const off = registerMemoryIpc(ipcMain, { store, allowed: () => gate.allowed, broadcast: (ch: string) => sent.push(ch) });
  const call = (ch: string, ...args: any[]) => handlers.get(`momoMemory:${ch}`)!({}, ...args);
  return { store, safe, handlers, gate, off, call, sent, setNow: (t: number) => (now = t) };
}
const src = { chatId: 'momo-main', harness: 'codex' };

test('every channel the bridge declares is handled here, and each refuses while MoMo is not allowed', async () => {
  const { handlers, gate, call, store } = setup();
  assert.deepEqual([...handlers.keys()], CHANNELS);
  assert.deepEqual(
    channelsOf({ momoMemory: loadBridge().momoMemory }).map((c: any) => c.channel),
    // the open loops' channels (loopsIpc.cjs, tested in momoLoopControl.test.ts) share the bridge
    [...CHANNELS, ...LOOP_CHANNELS, 'momoMemory:changed'],
  );
  await store.save({ text: 'Secret-ish fact', source: src });
  gate.allowed = false;
  for (const [ch, args] of [
    ['list', []],
    ['update', ['f1', { text: 'changed' }]],
    ['forget', ['f1']],
    ['files', []],
    ['writeFile', ['aboutYou', 'x']],
    ['changes', []],
    ['undo', ['c1']],
    ['past', []],
    ['background', []],
  ] as const)
    assert.deepEqual(await call(ch, ...args), NOT_ALLOWED, ch);
  assert.deepEqual(
    store.list().facts.map((f: any) => f.text),
    ['Secret-ish fact'],
    'nothing changed',
  );
  assert.equal(store.readFile('aboutYou'), '');
});

test('the list shows expired facts with the time to judge them by; a search shows only unexpired matches', async () => {
  const { store, call, setNow } = setup();
  await store.save({ text: 'In Rome this week', source: src, expiresAt: 2_000 });
  await store.save({ text: 'Likes Rome', source: src });
  setNow(3_000);
  const all = await call('list');
  assert.equal(all.ok, true);
  assert.deepEqual(
    all.facts.map((f: any) => f.text),
    ['In Rome this week', 'Likes Rome'],
  );
  assert.equal(all.unreadable, 0);
  assert.equal(typeof all.now, 'number');
  const found = await call('list', { query: ' rome ' });
  assert.deepEqual(
    found.facts.map((f: any) => f.text),
    ['Likes Rome'],
  );
  assert.equal((await call('list', { query: 7 })).facts.length, 2, 'a query that is not text lists everything');
  assert.equal((await call('list', 'rome')).facts.length, 2);
});

test('edit, delete and the two documents reach the store; a stale id or wrong input fails with a reason', async () => {
  const { store, call } = setup();
  await store.save({ text: 'Has two kids', source: src });
  const edited = await call('update', 'f1', { text: 'Has three kids', confidence: 'likely', source: { chatId: 'forged' } });
  assert.equal(edited.ok, true);
  assert.deepEqual(edited.fact, { ...store.list().facts[0] });
  assert.equal(edited.fact.source.chatId, 'momo-main', 'the source is not editable');
  assert.equal(edited.fact.confidence, 'sure', 'what the user wrote is sure');
  await store.update('f1', { confidence: 'likely' });
  assert.equal((await call('update', 'f1', { confidence: 'likely' })).fact.confidence, 'likely', 'without new text, as asked');
  assert.deepEqual(await call('update', 'nope', { text: 'x' }), { ok: false, error: 'That fact is no longer in memory' });
  assert.deepEqual(await call('update', '', { text: 'x' }), { ok: false, error: 'A fact id is needed' });
  assert.deepEqual(await call('update', 'f1', { text: '' }), { ok: false, error: 'A fact needs its text' });
  assert.equal((await call('update', 'f1', null)).ok, true, 'no patch changes nothing');
  assert.deepEqual(await call('forget', 'f1'), { ok: true });
  assert.deepEqual(await call('forget', 'f1'), { ok: false, error: 'That fact is no longer in memory' });
  assert.deepEqual(await call('forget', 3), { ok: false, error: 'A fact id is needed' });
  assert.deepEqual(await call('writeFile', 'aboutYou', 'Du, Berlin'), { ok: true });
  assert.deepEqual(await call('writeFile', 'persona', 'Brief.'), { ok: true });
  assert.deepEqual(await call('files'), { ok: true, aboutYou: 'Du, Berlin', persona: 'Brief.', unreadable: [] });
  assert.deepEqual(await call('writeFile', 'toString', 'x'), { ok: false, error: 'No such memory file: toString' });
  assert.deepEqual(await call('writeFile', 'persona', 5), { ok: false, error: 'The file text must be a string' });
});

test('a store that cannot be read answers a failure, not an empty memory', async () => {
  const { store, call } = setup();
  fs.mkdirSync(path.join(store.dir, 'facts.jsonl'), { recursive: true });
  const r = await call('list');
  assert.equal(r.ok, false);
  assert.match(r.error, /EISDIR/);
});

test("every change, the agent's included, tells the windows to read again, while MoMo is allowed; a failed write does not", async () => {
  const { store, gate, sent, call, off } = setup();
  await store.save({ text: 'From the agent', source: src });
  await call('writeFile', 'persona', 'Brief.');
  assert.deepEqual(sent, ['momoMemory:changed', 'momoMemory:changed']);
  await call('update', 'f1', { text: '' });
  assert.equal(sent.length, 2, 'refused: no change');
  gate.allowed = false;
  await store.save({ text: 'While not allowed', source: src });
  assert.equal(sent.length, 2, 'not allowed: no trace');
  gate.allowed = true;
  off();
  await store.save({ text: 'After removal', source: src });
  assert.equal(sent.length, 2);
  assert.equal(store.listenerCount('changed'), 0);
  // the default broadcast sends nothing anywhere
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'momo-ipc-'));
  made.push(d);
  const quiet = new MemoryStore({ dir: d, safeStorage: fakeSafe(), isMomoChat: () => true });
  registerMemoryIpc({ handle() {}, removeHandler() {} }, { store: quiet, allowed: () => true });
  await quiet.save({ text: 'x', source: src });
});

test('correcting an expired fact brings it back; the tab can never set a new expiry, so one left expired is gone', async () => {
  const { store, call, setNow } = setup();
  await store.save({ text: 'In Rome', source: src, expiresAt: 2_000 });
  await store.save({ text: 'In Paris', source: src, expiresAt: 2_000 });
  setNow(3_000);
  const back = await call('update', 'f1', { text: 'Lives in Rome', expiresAt: null });
  assert.equal('expiresAt' in back.fact, false);
  assert.equal(store.search('Rome').length, 1);
  // an expiry the tab sends is not taken: the fact stays expired, and the write pruned it
  assert.deepEqual(await call('update', 'f2', { text: 'In Paris', expiresAt: 99_999 }), {
    ok: false,
    error: 'That fact is no longer in memory',
  });
  assert.deepEqual(
    store.list({ includeExpired: true }).facts.map((f: any) => f.id),
    ['f1'],
  );
});

test('Add saves what the user typed as theirs and sure; the same text twice is kept once', async () => {
  const { store, call } = setup();
  const r = await call('add', '  Prefers tea ');
  assert.equal(r.ok, true);
  assert.equal(r.saved, true);
  assert.deepEqual(store.list().facts[0], { id: 'f1', text: 'Prefers tea', source: 'user', createdAt: 1000, confidence: 'sure' });
  assert.equal((await call('add', 'prefers tea')).saved, false);
  assert.deepEqual(await call('add', ''), { ok: false, error: 'A fact needs its text' });
  assert.deepEqual(await call('add', 5), { ok: false, error: 'A fact needs its text' });
});

test("without encryption every call says memory is off; a document that can't be decrypted reads as empty and is named", async () => {
  const { store, safe, call } = setup();
  await store.writeFile('persona', 'Brief.');
  fs.writeFileSync(path.join(store.dir, 'about-you.md'), 'tampered');
  assert.deepEqual(await call('files'), { ok: true, aboutYou: '', persona: 'Brief.', unreadable: ['aboutYou'] });
  safe.available = false;
  for (const [ch, args] of [
    ['list', []],
    ['add', ['x']],
    ['files', []],
    ['writeFile', ['persona', 'x']],
  ] as const) {
    const r = await call(ch, ...args);
    assert.equal(r.ok, false, ch);
    assert.equal(r.reason, 'unavailable', ch);
    assert.match(r.error, /can't encrypt it/, ch);
  }
});

test('the contract the tab is typed by is types only: loading it runs nothing', async () => {
  const mod = await import('../src/lib/native/contracts/momoMemory.ts');
  assert.deepEqual(
    Object.keys(mod).filter((k) => k !== 'default' && k !== 'module.exports'),
    [],
  );
});

test('the returned function removes every handler', () => {
  const { handlers, off } = setup();
  off();
  assert.equal(handlers.size, 0);
});

test('the recent changes come newest first with whether Undo can take each back; Undo reverts, or says a fact changed since', async () => {
  const { call, store, setNow } = setup();
  await call('add', 'Likes tea');
  setNow(2_000);
  await call('update', 'f1', { text: 'Likes green tea' });
  const first = await call('changes');
  assert.equal(first.ok, true);
  assert.deepEqual(
    first.changes.map((c: any) => [c.op, c.undoable]),
    [
      ['update', true],
      ['save', true],
    ],
  );
  // the save can't be undone while the fact it made has changed since
  const refused = await call('undo', first.changes[1].id);
  assert.deepEqual(refused, { ok: false, error: 'That fact changed since; undo the later change first' });
  const undone = await call('undo', first.changes[0].id);
  assert.equal(undone.ok, true);
  assert.equal(undone.change.op, 'undo');
  assert.equal(store.list().facts[0].text, 'Likes tea');
  const after = await call('changes');
  assert.deepEqual(
    after.changes.map((c: any) => [c.op, c.undoable]),
    [
      ['undo', false],
      ['update', false],
      ['save', true],
    ],
    'an undo and an undone change offer no Undo',
  );
  assert.deepEqual(await call('undo', ''), { ok: false, error: 'A change id is needed' });
  assert.deepEqual(await call('undo', 'nope'), { ok: false, error: 'That change is no longer in the log' });
});

test('past facts come with the latest replaced first; the background pass’s limits come from main, null before it runs', async () => {
  const { call, store, setNow } = setup();
  await store.save({ text: 'Lives in Berlin', source: src });
  await store.save({ text: 'Works at Acme', source: src });
  setNow(5_000);
  await store.applyPass([{ op: 'supersede', id: 'f1', text: 'Lives in Lisbon' }], { source: src, reason: 'chat idle' });
  setNow(6_000);
  await store.applyPass([{ op: 'supersede', id: 'f2', text: 'Works at Initech' }], { source: src, reason: 'chat idle' });
  const past = await call('past');
  assert.deepEqual(
    past.facts.map((f: any) => [f.text, f.invalidAt]),
    [
      ['Works at Acme', 6_000],
      ['Lives in Berlin', 5_000],
    ],
  );
  assert.deepEqual(await call('background'), { ok: true, limits: null });
  const handlers = new Map<string, Function>();
  const limits = {
    daily: { cap: 200000, today: 1000 },
    memory: { cap: 120000, today: 900 },
    aliases: { cap: 100000, today: 100 },
    maxTokensPerPass: 6000,
  };
  registerMemoryIpc(
    { handle: (ch: string, fn: Function) => handlers.set(ch, fn), removeHandler: () => {} },
    { store, allowed: () => true, background: () => limits },
  );
  assert.deepEqual(await handlers.get('momoMemory:background')!({}), { ok: true, limits });
});

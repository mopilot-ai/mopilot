// The Host's persisted epoch and dedupe ledger (host/src/epochs.mjs, ledger.mjs, guard.mjs): a stale owner is refused with the current epoch (A2), a corrupt file or line is reported and the rest kept (W3), and a request is never run twice, even across a restart (B7).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-ignore: plain ESM without declarations
import { createEpochStore, StaleEpochError, EpochStoreError } from '../host/src/epochs.mjs';
// @ts-ignore
import { createLedger, INDETERMINATE, KeyReusedError } from '../host/src/ledger.mjs';
// @ts-ignore
import { createGuard } from '../host/src/guard.mjs';

const quiet = { report: () => undefined };
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'host-proto-'));

test('epochs: a lower epoch is refused with the current one, an equal or higher one is let through and recorded', () => {
  const file = path.join(tmp(), 'sub', 'epochs.json');
  const store = createEpochStore(file, quiet);
  assert.equal(store.current('c'), 0);
  assert.equal(store.admit('c', 0), 0);
  assert.equal(fs.existsSync(file), false, 'nothing written for the epoch it already was');
  store.admit('c', 4);
  assert.equal(store.admit('c', 4), 4);
  assert.throws(
    () => store.admit('c', 3),
    (e: any) => e instanceof StaleEpochError && e.code === 'stale_epoch' && e.current === 4 && e.chatId === 'c',
  );
  // a new process reads the file, not memory
  assert.equal(createEpochStore(file, quiet).current('c'), 4);
  assert.throws(() => createEpochStore(file, quiet).admit('c', 1), StaleEpochError);
  assert.equal(store.admit('__proto__', 2), 2);
  assert.equal(store.current('other'), 0);
});

test('A2: a stale epoch that settles after a newer one changes nothing', async () => {
  const dir = tmp();
  const guard = createGuard({
    epochs: createEpochStore(path.join(dir, 'e.json'), quiet),
    ledger: createLedger(path.join(dir, 'l'), quiet),
  });
  const ran: string[] = [];
  const slow = guard(
    { chatId: 'c', epoch: 1, key: 'old-key-0001', method: 'chat.send' },
    async () => (await new Promise((r) => setTimeout(r, 5)), ran.push('old')),
  );
  // the owner moves on while the old request is still running
  const fresh = await guard({ chatId: 'c', epoch: 2, key: 'new-key-0001', method: 'chat.send' }, () => ran.push('new'));
  await slow;
  const late = await guard({ chatId: 'c', epoch: 1, key: 'late-key-001', method: 'chat.send' }, () => ran.push('late')).catch(
    (e: any) => e,
  );
  assert.ok(late instanceof StaleEpochError && late.current === 2);
  assert.deepEqual(ran.sort(), ['new', 'old']);
  assert.equal(fresh.replayed, false);
  assert.equal(createEpochStore(path.join(dir, 'e.json'), quiet).current('c'), 2);
  assert.equal(fs.readdirSync(path.join(dir, 'l')).length, 1);
  assert.equal(fs.readFileSync(path.join(dir, 'l', fs.readdirSync(path.join(dir, 'l'))[0]), 'utf8').includes('late-key'), false);
});

test('W3: a corrupt epoch file falls back to its copy and reports; with no copy nothing is let through', () => {
  const file = path.join(tmp(), 'e.json');
  const told: string[] = [];
  const store = createEpochStore(file, { report: (p: string) => told.push(p) });
  store.admit('c', 1);
  store.admit('c', 5); // the file now holds 5 and the copy 1
  fs.writeFileSync(file, '{not json');
  assert.equal(store.current('c'), 1);
  assert.equal(told.length, 1);
  for (const bad of ['[]', '{"c":-1}', '{"c":"2"}', 'null']) {
    fs.writeFileSync(file, bad);
    assert.equal(store.current('c'), 1);
  }
  fs.writeFileSync(`${file}.bak`, 'junk');
  assert.throws(
    () => store.admit('c', 9),
    (e: any) => e instanceof EpochStoreError && e.code === 'epoch_store_unreadable',
  );
  const lone = path.join(tmp(), 'e.json');
  fs.writeFileSync(lone, 'junk');
  assert.throws(() => createEpochStore(lone, quiet).current('c'), EpochStoreError);
  const dir = path.join(tmp(), 'is-a-dir');
  fs.mkdirSync(dir);
  assert.throws(() => createEpochStore(dir, quiet).current('c'), EpochStoreError);
});

const id = (key = 'key-0000001') => ({ chatId: 'claude:x', key, method: 'chat.send' });

test('ledger: a completed key returns its stored result and does not run again', async () => {
  const ledger = createLedger(path.join(tmp(), 'l'), quiet);
  let runs = 0;
  const first = await ledger.once(id(), () => ({ turn: ++runs }));
  assert.deepEqual(first, { replayed: false, result: { turn: 1 } });
  assert.deepEqual(await ledger.once(id(), () => ({ turn: ++runs })), { replayed: true, result: { turn: 1 } });
  assert.deepEqual((await ledger.once(id('key-0000002'), () => undefined)).result, null);
  assert.equal(runs, 1);
});

test('B7: the same request sent twice before the first settles runs once and both get its result', async () => {
  const ledger = createLedger(path.join(tmp(), 'l'), quiet);
  let release!: () => void;
  let runs = 0;
  const act = () => new Promise((r) => ((release = () => r({ chat: 'made' })), runs++));
  const a = ledger.once(id(), act);
  const b = ledger.once(id(), act);
  release();
  assert.deepEqual(await a, { replayed: false, result: { chat: 'made' } });
  assert.deepEqual(await b, { replayed: true, result: { chat: 'made' } });
  assert.equal(runs, 1);
});

test('a request that started and never settled before a restart is indeterminate, never run again', async () => {
  const dir = path.join(tmp(), 'l');
  let release!: () => void;
  const one = createLedger(dir, quiet);
  void one.once(id(), () => new Promise<void>((r) => (release = r))).catch(() => {});
  // the Host dies here: a new process opens the same files
  const two = createLedger(dir, quiet);
  let ran = false;
  assert.deepEqual(await two.once(id(), () => (ran = true)), { replayed: true, result: INDETERMINATE });
  assert.equal(ran, false);
  release();
});

test("a refusal made before any effect is not the key's answer: the same key runs again once the cause is gone, also after a restart", async () => {
  const dir = path.join(tmp(), 'l');
  const refuse = (code: string) => () => Promise.reject(Object.assign(new Error('Codex is not signed in.'), { code }));
  for (const code of ['harness_not_configured', 'directory_missing', 'unsupported']) {
    const key = `key-${code}`;
    const one = createLedger(dir, quiet);
    await assert.rejects(one.once(id(key), refuse(code)), (e: any) => e.code === code);
    // asked again (same life, then after a restart): the request runs, it is neither replayed nor indeterminate
    assert.deepEqual(await one.once(id(key), () => 'done'), { replayed: false, result: 'done' });
    assert.deepEqual(await createLedger(dir, quiet).once(id(key), () => 'never'), { replayed: true, result: 'done' });
    // a refusal stored by an earlier life is read back as refused, not as a request that never settled
    const other = `other-${code}`;
    await assert.rejects(createLedger(dir, quiet).once(id(other), refuse(code)), (e: any) => e.code === code);
    assert.deepEqual(await createLedger(dir, quiet).once(id(other), () => 'ran'), { replayed: false, result: 'ran' });
  }
});

test('a failed request replays its failure; a key reused for another method is refused', async () => {
  const dir = path.join(tmp(), 'l');
  const ledger = createLedger(dir, quiet);
  await assert.rejects(
    ledger.once(id(), () => Promise.reject(Object.assign(new Error('no room'), { code: 'full' }))),
    /no room/,
  );
  let runs = 0;
  for (const l of [ledger, createLedger(dir, quiet)])
    await assert.rejects(
      l.once(id(), () => ++runs),
      (e: any) => e.message === 'no room' && e.code === 'full',
    );
  assert.equal(runs, 0);
  await assert.rejects(
    ledger.once({ ...id(), method: 'chat.stop' }, () => 1),
    (e: any) => e instanceof KeyReusedError && e.code === 'key_reused',
  );
  await assert.rejects(
    ledger.once(id('key-0000009'), () => Promise.reject('plain')),
    /plain/,
  );
  assert.equal(
    await createLedger(dir, quiet)
      .once(id('key-0000009'), () => 1)
      .then(
        () => 'ran',
        (e: any) => e.message,
      ),
    'plain',
  );
  // a failure written without detail still replays as a failure
  const bare = createLedger(path.join(tmp(), 'b'), quiet);
  await assert.rejects(bare.once(id(), () => Promise.reject(new Error(''))));
});

test('W3: a corrupt ledger line is reported and the rest is kept', async () => {
  const dir = path.join(tmp(), 'l');
  const first = createLedger(dir, quiet);
  await first.once(id('key-0000001'), () => 'one');
  await first.once(id('key-0000002'), () => 'two');
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  const lines = fs.readFileSync(file, 'utf8').trimEnd().split('\n');
  // a torn write, a record of the wrong shape and a stray blank line between good ones
  fs.writeFileSync(file, [lines[0], lines[1], '{"key":"key-0000003","meta', '', '{"key":5}', ...lines.slice(2)].join('\n') + '\n');
  const told: string[] = [];
  const second = createLedger(dir, { report: (p: string) => told.push(p) });
  assert.deepEqual((await second.once(id('key-0000001'), () => 'again')).result, 'one');
  assert.deepEqual((await second.once(id('key-0000002'), () => 'again')).result, 'two');
  assert.equal(told.length, 2);
  assert.match(told[0], /Line 3 /);
  assert.match(told[1], /Line 5 /);
});

test('a ledger file that cannot be read for another reason fails loudly instead of reading as empty', async () => {
  const dir = path.join(tmp(), 'l');
  const ledger = createLedger(dir, quiet);
  await ledger.once(id(), () => 1);
  const file = path.join(dir, fs.readdirSync(dir)[0]);
  fs.rmSync(file);
  fs.mkdirSync(file);
  await assert.rejects(
    createLedger(dir, quiet).once(id(), () => 1),
    /EISDIR/,
  );
});

test('chats do not share a ledger: the same key on two chats runs twice', async () => {
  const ledger = createLedger(path.join(tmp(), 'l'), quiet);
  let runs = 0;
  await ledger.once({ ...id(), chatId: 'a:1' }, () => ++runs);
  await ledger.once({ ...id(), chatId: 'a:2' }, () => ++runs);
  assert.equal(runs, 2);
});

test('a settled line with no detail still replays: a completed one as null, a failed one as a failure', async () => {
  const dir = path.join(tmp(), 'l');
  fs.mkdirSync(dir);
  const file = path.join(dir, `${createHash('sha256').update('claude:x').digest('hex').slice(0, 32)}.jsonl`);
  const line = (key: string, state: string) => `${JSON.stringify({ key, method: 'chat.send', state })}\n`;
  fs.writeFileSync(file, line('key-0000001', 'completed') + line('key-0000002', 'failed'));
  const ledger = createLedger(dir, quiet);
  assert.deepEqual(await ledger.once(id('key-0000001'), () => 1), { replayed: true, result: null });
  await assert.rejects(
    ledger.once(id('key-0000002'), () => 1),
    /The request failed/,
  );
});

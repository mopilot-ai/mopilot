// The Host outbox's growth for remote sends (electron/host/outbox.cjs): a message added mid-drain is sent by it (A1), the last ack releases the file, and a restart lists the chats that still hold messages.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { useFakeClock as installFakeClock } from './support/ports/clock.ts';
const require = createRequire(import.meta.url);
const { createOutbox } = require('../electron/host/outbox.cjs');

const world = (t: any) => {
  const clock = installFakeClock(t, 1_000_000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outbox-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reports: Error[] = [];
  const make = () => createOutbox({ dir, report: (e: Error) => reports.push(e) });
  return { clock, dir, reports, make, outbox: make() };
};
const item = (key: string, epoch = 1) => ({ key, epoch, options: { text: key } });
const keys = (o: any, chat = 'c1') => o.pending(chat).map((e: any) => e.key);

test('a message added while an earlier one is in flight is sent by the same drain (A1)', async (t) => {
  const { outbox } = world(t);
  outbox.add('c1', item('a'));
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const got: string[] = [];
  const done = outbox.drain('c1', {
    online: () => true,
    send: async (e: any) => {
      got.push(e.key);
      if (e.key === 'a') await gate;
    },
  });
  outbox.add('c1', item('b'));
  release();
  assert.deepEqual(await done, { sent: 2, stopped: null });
  assert.deepEqual(got, ['a', 'b']);
});

test('the last ack releases the chat’s file and its cached messages', (t) => {
  const { outbox, dir, make } = world(t);
  outbox.add('c1', item('a'));
  assert.equal(fs.readdirSync(dir).length, 1);
  outbox.ack('c1', ['a']);
  assert.deepEqual(fs.readdirSync(dir), []);
  // a damaged file after that serves nothing stale from the cache
  outbox.add('c1', item('b'));
  fs.writeFileSync(path.join(dir, fs.readdirSync(dir)[0]), '{');
  assert.deepEqual(keys(outbox), ['b'], 'what was known before the damage is served');
  const fresh = make();
  assert.throws(() => fresh.pending('c1'), /could not be read/);
  // a failed delete leaves everything as it was
  const other = world(t);
  other.outbox.add('c1', item('a'));
  const rm = t.mock.method(fs, 'rmSync', () => {
    throw new Error('busy');
  });
  assert.throws(() => other.outbox.ack('c1', ['a']), /busy/);
  rm.mock.restore();
  assert.deepEqual(keys(other.outbox), ['a']);
});

test('chats lists the chats that still hold a message, from disk, and reports a file it cannot read', (t) => {
  const { outbox, dir, make, reports } = world(t);
  assert.deepEqual(make().chats(), [], 'no messages yet');
  fs.rmSync(dir, { recursive: true, force: true });
  assert.deepEqual(make().chats(), [], 'no folder yet');
  outbox.add('c1', item('a'));
  outbox.add('weird/../id', item('b'));
  outbox.add('c3', item('c'));
  outbox.ack('c3', ['c']);
  fs.writeFileSync(path.join(dir, `${'f'.repeat(64)}.json`), '{');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'not an outbox file');
  fs.writeFileSync(path.join(dir, `${'e'.repeat(64)}.json`), JSON.stringify({ version: 1, chatId: 'liar', entries: [{}] }));
  assert.deepEqual(make().chats().sort(), ['c1', 'weird/../id']);
  assert.ok(reports.length >= 1, 'the damaged file is reported');
  // a folder that cannot be listed is the caller's problem, not an empty outbox
  const plain = path.join(dir, 'plain');
  fs.writeFileSync(plain, 'x');
  assert.throws(() => createOutbox({ dir: plain }).chats(), /ENOTDIR/);
});

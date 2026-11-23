// The request ledger's summary as Settings shows it (electron/ledger/store.cjs summary): a ledger folder that cannot be listed is an
// error, never no usage, and a rolled-up history that could not be read is said only for a range that reaches back into it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { RequestLedger, dayOf } = require('../electron/ledger/store.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-summary-'));
const T0 = new Date(2026, 10, 22, 10, 0, 0).getTime();
const DAY = 86_400_000;
const line = (o: any) =>
  JSON.stringify({ v: 1, t: '2026-11-22T10:00:00.000Z', harness: 'codex', outcome: 'ok', served: 'gpt-5.5', in: 1_000_000, ...o });
const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const d = console.debug;
  console.debug = () => {};
  try {
    return await fn();
  } finally {
    console.debug = d;
  }
};

test('a ledger folder that cannot be listed rejects the summary; one not made yet is no usage', async () => {
  const dir = tmp();
  const denied = { ...fs.promises, readdir: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) };
  await assert.rejects(new RequestLedger({ dir, now: () => T0, fsp: denied }).summary(), /denied/);
  const none = await new RequestLedger({ dir: path.join(dir, 'not-yet'), now: () => T0 }).summary();
  assert.deepEqual(none, { rows: [], rollup: 'ok', unread: [], imported: 'ok' });
});

test('a set-aside rollup marks only the ranges that reach before the oldest raw day', async () => {
  const dir = tmp();
  const today = dayOf(T0);
  const old = dayOf(T0 - 20 * DAY);
  fs.writeFileSync(path.join(dir, `${today}.jsonl`), `${line({})}\n`);
  fs.writeFileSync(path.join(dir, `${old}.jsonl`), `${line({})}\n`);
  fs.writeFileSync(path.join(dir, 'days.unreadable-2026-11-01T00-00-00.000Z-abcd1234.json'), '{broken');
  const l = new RequestLedger({ dir, now: () => T0 });
  const week = await l.summary({ from: dayOf(T0 - 6 * DAY), to: today });
  assert.equal(week.rollup, 'ok', 'a week read wholly from raw files needs no rollup');
  assert.equal(week.rows.length, 1);
  assert.equal(((await quiet(() => l.summary({ to: today }))) as any).rollup, 'unreadable', 'all recorded reaches into it');
  assert.equal(((await quiet(() => l.summary({ from: dayOf(T0 - 25 * DAY), to: today }))) as any).rollup, 'unreadable');
  // a raw day deleted between the listing and the read is looked for in the rollup, whatever the range
  const gone = {
    ...fs.promises,
    stat: async (p: string) =>
      p.endsWith(`${today}.jsonl`) ? fs.promises.stat(p) : Promise.reject(Object.assign(new Error('gone'), { code: 'ENOENT' })),
  };
  const raced: any = await quiet(() => new RequestLedger({ dir, now: () => T0, fsp: gone }).summary({ from: old, to: today }));
  assert.equal(raced.rollup, 'unreadable');
});

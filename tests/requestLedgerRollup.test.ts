// The request ledger's rollup file at its edges (electron/ledger/rollup.cjs): a read that fails without an error code is unreadable,
// not empty, the set-aside check answers no for a folder not made yet and fails for one that cannot be listed, and the days folded
// before live sessions were kept stay known as such until they are folded again or pass the retention.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { LedgerRollup, RollupUnreadable } = require('../electron/ledger/rollup.cjs');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-rollup-'));
const rollupIn = (dir: string, fsp?: any) => new LedgerRollup({ dir: () => dir, oldest: () => '0000-00-00', ...(fsp ? { fsp } : {}) });

test('a read that fails with no error code is unreadable, and says what failed', async () => {
  const fsp = { ...fs.promises, readFile: async () => Promise.reject('the disk went away') };
  await assert.rejects(
    rollupIn(tmp(), fsp).read(),
    (e: any) => e instanceof RollupUnreadable && !e.content && /the disk went away/.test(e.message),
  );
});

test('no folder yet has nothing set aside; a folder that cannot be listed fails the check', async () => {
  assert.equal(await rollupIn(path.join(tmp(), 'not-yet')).setAside(), false);
  const fsp = { ...fs.promises, readdir: async () => Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })) };
  await assert.rejects(rollupIn(tmp(), fsp).setAside(), /denied/);
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'days.unreadable-2026-11-01T00-00-00.000Z-abcd1234.json'), '{');
  assert.equal(await rollupIn(dir).setAside(), true);
});

test('a day is spanless unless it is listed as folded with its live sessions: a writer that drops the list undercounts', async () => {
  const dir = tmp();
  const row = { day: '2026-10-22', harness: 'codex', model: null, pay: 'unknown', requests: 1, in: 1, out: 0, cacheRead: 0, cacheWrite: 0 };
  const rows = (day: string) => [{ ...row, day }];
  const write = (v: any) => fs.writeFileSync(path.join(dir, 'days.json'), JSON.stringify(v));
  write({ v: 1, days: { '2026-10-21': rows('2026-10-21'), '2026-10-22': rows('2026-10-22') } });
  let oldest = '0000-00-00';
  const rollup = new LedgerRollup({ dir: () => dir, oldest: () => oldest });
  assert.deepEqual((await rollup.load()).spanless, ['2026-10-21', '2026-10-22'], 'an older version wrote no live sessions');
  const span = { first: '2026-10-23T09:00:00.000Z', last: '2026-10-23T10:00:00.000Z' };
  await rollup.fold({ '2026-10-23': rows('2026-10-23') }, { k: span });
  assert.deepEqual((await rollup.load()).spanless, ['2026-10-21', '2026-10-22'], 'kept across a fold that has live sessions');
  await rollup.fold({ '2026-10-22': rows('2026-10-22') }, {});
  assert.deepEqual((await rollup.load()).spanless, ['2026-10-21'], 'a day folded again comes with its live sessions');
  oldest = '2026-10-22';
  await rollup.fold({}, {});
  const left = JSON.parse(fs.readFileSync(path.join(dir, 'days.json'), 'utf8'));
  assert.deepEqual(
    [Object.keys(left.days), left.spanned],
    [
      ['2026-10-22', '2026-10-23'],
      ['2026-10-22', '2026-10-23'],
    ],
    'past the retention, none',
  );
  // a version that kept live sessions but not this list: its days are spanless; a listed day the rollup lacks is nothing
  write({ v: 1, days: { '2026-10-23': rows('2026-10-23') }, live: { k: span } });
  assert.deepEqual((await rollup.load()).spanless, ['2026-10-23']);
  write({ v: 1, days: { '2026-10-23': rows('2026-10-23') }, live: {}, spanned: ['2026-10-23', '2026-10-01'] });
  assert.deepEqual((await rollup.load()).spanless, []);
  for (const spanned of [{}, ['yesterday'], [3]]) {
    write({ v: 1, days: {}, live: {}, spanned });
    await assert.rejects(rollup.load(), RollupUnreadable, JSON.stringify(spanned));
  }
  assert.deepEqual((await rollupIn(tmp()).load()).spanless, [], 'no rollup yet');
});

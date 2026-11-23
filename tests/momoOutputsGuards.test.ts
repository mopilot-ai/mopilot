// What MoMo's Outputs refuses to lose or to do (#2139, outputs.cjs, outputsTools.cjs, sentinelRules.cjs), found in review: the startup sweep never deletes a file the user put in the folder (a damaged index reads as empty), a save whose index cannot be written takes its file back, names cannot carry text-direction characters, sizes and ages read right, the flag is read again inside the gate after a wait, and only the outputs source can be a sandbox change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { store, rig } from './support/momo-outputs-rig.ts';

const require = createRequire(import.meta.url);
const { nameOf } = require('../electron/momo/outputs.cjs');
const { SOURCE } = require('../electron/momo/outputsTools.cjs');

test('sweep removes only the temporary files an interrupted save left; a file put there by hand and a damaged index never cost a file', async () => {
  const { dir, safe, s } = store();
  await s.save({ name: 'a.md', content: 'x', chatId: 'c' });
  const folder = path.join(dir, 'outputs');
  const tmp = '.a.md-123-0b0e7d7a-1111-4222-8333-944455556666.tmp';
  fs.writeFileSync(path.join(folder, tmp), 'half');
  fs.writeFileSync(path.join(folder, 'mine.pdf'), 'the user kept this here');
  fs.writeFileSync(path.join(folder, '.hidden-note'), 'x');
  fs.mkdirSync(path.join(folder, 'dir'));
  await s.sweep();
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.hidden-note', 'a.md', 'dir', 'mine.pdf']);
  // a damaged index reads as empty (and is set aside): the sweep must not take that for "nothing is wanted"
  fs.writeFileSync(path.join(dir, 'outputs.json'), 'not sealed at all');
  assert.deepEqual(s.list(), []);
  await s.sweep();
  assert.deepEqual(fs.readdirSync(folder).sort(), ['.hidden-note', 'a.md', 'dir', 'mine.pdf']);
  void safe;
});

test('a save whose index cannot be written leaves no file behind', async () => {
  const { dir, safe, s } = store();
  await s.save({ name: 'first.md', content: 'x', chatId: 'c' });
  const orig = safe.encryptString;
  safe.encryptString = () => {
    throw new Error('keychain locked');
  };
  await assert.rejects(s.save({ name: 'second.md', content: 'x', chatId: 'c' }), /wasn’t saved/);
  safe.encryptString = orig;
  assert.deepEqual(fs.readdirSync(path.join(dir, 'outputs')), ['first.md']);
  assert.deepEqual(
    s.list().map((o: any) => o.name),
    ['first.md'],
  );
});

test('names with text-direction characters are refused (a file name can not be made to read backwards)', () => {
  for (const name of ['evil\u202egnp.md', 'a\u2066b.md', 'a\u200fb.md', 'a\u061cb.md'])
    assert.equal(nameOf(name), null, JSON.stringify(name));
});

test('sizes: 999,999 B is 1 MB, not 1000 KB; the list says ages with the injected clock', async () => {
  const r = rig({ now: () => 1000 + 5 * 60_000 });
  const made = await r.s.save({ name: 'big.txt', content: 'x'.repeat(999_999), chatId: 'c' });
  assert.equal(made.size, 999_999);
  assert.match(await r.run('momo_save_file', { name: 'near.txt', content: 'x'.repeat(999_999) }), /\(1 MB\)/);
  assert.match(await r.run('momo_save_file', { name: 'mid.txt', content: 'x'.repeat(999_500) }), /\(999\.5 KB\)/);
  assert.match(String(await r.run('momo_outputs_list', {})), /big\.txt · 1 MB · 5 min ago/);
});

test('the flag going off while a save waits (for the lock or a card) refuses it inside the gate: nothing is written', async () => {
  const flag = { on: true };
  const r = rig({ flag, before: () => void (flag.on = false) });
  await assert.rejects(
    r.run('momo_save_file', { name: 'late.md', content: 'x' }),
    (e: any) => e.code === 'off' && /turned off, so nothing was saved/.test(e.message),
  );
  assert.equal(fs.existsSync(path.join(r.dir, 'outputs')), false);
  assert.deepEqual(
    r.entries().map((e: any) => [e.kind, e.kind === 'intent' ? e.decision : e.result]),
    [
      ['intent', 'sandbox'],
      ['outcome', 'not sent'],
    ],
  );
});

test('only a call from the outputs source can be a sandbox change: another tool setting the flag still asks', async () => {
  const r = rig();
  const call = { chatId: 'momo-main', tool: 't', source: 'calendar', kind: 'change' as const, sandbox: true, repeatable: true };
  r.sentinel.setSource('calendar', { level: 'ask', private: true, name: 'Calendar' });
  assert.equal((await r.sentinel.decide(call)).via, 'asked');
  assert.equal((await r.sentinel.decide({ ...call, source: SOURCE })).via, 'sandbox');
});

test('a failed clean-up of an unlisted file is only noted: the save still reports why it failed', async () => {
  const { dir, safe, s } = store();
  await s.save({ name: 'first.md', content: 'x', chatId: 'c' });
  const folder = path.join(dir, 'outputs');
  const orig = safe.encryptString;
  safe.encryptString = () => {
    fs.chmodSync(folder, 0o500);
    throw new Error('keychain locked');
  };
  try {
    await assert.rejects(s.save({ name: 'second.md', content: 'x', chatId: 'c' }), /wasn’t saved/);
  } finally {
    safe.encryptString = orig;
    fs.chmodSync(folder, 0o700);
  }
  assert.deepEqual(
    fs.readdirSync(folder).sort(),
    ['first.md', 'second.md'],
    'the file stays; nothing lists it, and a later sweep leaves it alone',
  );
});

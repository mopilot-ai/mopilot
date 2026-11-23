// electron/session/contract/reconcile.cjs: reading a transcript's tail, a file's write time, and ExternalWrites'
// defaults (real clock and mtime), a missing chat id and a file-less check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { ExternalWrites, tailLines, SILENT_MS } = require('../electron/session/contract/reconcile.cjs');

function fakeState(known: string[] = []) {
  const patches: any[] = [];
  return {
    patches,
    has: (id: string) => known.includes(id),
    get: () => ({ turn: 'idle' }),
    patch: (id: string, p: any) => patches.push([id, p]),
  };
}

test('tailLines reads the last bytes as non-empty lines; a missing file is []', (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 't.jsonl');
  fs.writeFileSync(f, 'first line\nsecond\n\nthird\n');
  assert.deepEqual(tailLines(f), ['first line', 'second', 'third']);
  assert.deepEqual(tailLines(f, 14), ['second', 'third']);
  assert.deepEqual(tailLines(path.join(d, 'missing')), []);
  // a window that starts inside a line leaves that piece out
  assert.deepEqual(tailLines(f, 10), ['third']);
  // a last record bigger than the window (a screenshot in a tool result): the window grows until it holds it
  const big = `{"type":"user","message":{"content":"${'x'.repeat(5000)}"}}`;
  fs.writeFileSync(f, `{"type":"assistant"}\n${big}\n`);
  assert.equal(tailLines(f, 1024).at(-1), big);
  // ...up to its limit: past that, nothing whole is read
  assert.deepEqual(tailLines(f, 1024, 2048), []);
});

test('defaults: a freshly written file counts as live; a missing one is long quiet', async (t) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'reconcile-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  const f = path.join(d, 'rollout.jsonl');
  fs.writeFileSync(f, '{}\n');
  const state = fakeState(['c']);
  const w = new ExternalWrites({ state });
  assert.equal(w.silentMs, SILENT_MS);
  assert.equal(await w.reconcile('c', f, async () => true), true);
  assert.deepEqual(state.patches, [['c', { runningElsewhere: true }]]);
  let asked = false;
  assert.equal(await w.reconcile('c', path.join(d, 'missing'), async () => (asked = true)), false);
  assert.equal(asked, false, 'a quiet file is not asked about');
  w.forget('c');
});

test('no chat id does nothing; without a file the check runs now', async () => {
  const state = fakeState();
  const w = new ExternalWrites({ state, silentMs: 1000 });
  assert.equal(await w.reconcile('', null, async () => true), false);
  assert.equal(await w.reconcile('x', null, async () => false), false);
  assert.deepEqual(state.patches, [], 'an unknown chat that is not running is not patched');
});

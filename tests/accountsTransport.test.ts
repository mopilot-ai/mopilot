// Account transport failure retires its owner and permits a healthy replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, codex, NEVER } from './support/electron-accounts.ts';

test('a sidecar transport failure rejects pending requests, retires the process and permits replacement', async (t) => {
  const { a } = setup(t);
  const sc = a.sidecar(a.active());
  await sc.ready;
  codex.handle = (method) => (method === 'waiting' ? NEVER : {});
  const rejected = assert.rejects(sc.request('waiting'), /Codex exited/);
  const proc = codex.procs.at(-1)!;
  sc.reader.fail(new Error('synthetic worker failure'));
  await rejected;
  assert.equal(proc.killed, true);
  assert.equal(sc.proc, null);
  const replacement = a.sidecar(a.active());
  await replacement.ready;
  assert.notEqual(replacement, sc);
  assert.deepEqual(await replacement.call('healthy'), {});
});

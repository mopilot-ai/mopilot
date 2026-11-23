// runGit's output bound, whatever the pipe delivers: a chunk that arrives after the cut (Linux pipes deliver large
// chunks, and data already in the pipe still arrives after the kill) never grows the answer past maxBytes. git is a fake.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const spawned: any[] = [];
mock.module('node:child_process', {
  namedExports: {
    spawn: () => {
      const child: any = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stdout.setEncoding = () => child.stdout;
      child.stderr = new EventEmitter();
      child.stderr.setEncoding = () => child.stderr;
      child.stdin = Object.assign(new EventEmitter(), { end: () => undefined });
      child.kill = () => (child.killed = true);
      spawned.push(child);
      return child;
    },
  },
});
const { runGit } = await import('../host/src/hostGit.mjs');

test('a chunk that arrives after the cut is dropped: the answer stays at maxBytes, cut, with no signal', async () => {
  const run = runGit(['ls-files'], { maxBytes: 10 });
  const child = spawned.at(-1);
  child.stdout.emit('data', 'a'.repeat(8));
  child.stdout.emit('data', 'b'.repeat(8));
  assert.equal(child.killed, true, 'stopped once past the bound');
  // already in the pipe when the kill landed
  child.stdout.emit('data', 'c'.repeat(3780));
  child.emit('close', null, 'SIGTERM');
  const r: any = await run;
  assert.equal(r.stdout, `${'a'.repeat(8)}bb`);
  assert.equal(r.cut, true);
  assert.equal(r.ok, false);
  assert.equal(r.signal, null);
});

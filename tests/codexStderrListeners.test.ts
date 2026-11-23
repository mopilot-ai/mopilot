// The Codex app-server hands each piece of its stderr to whoever listens (the Remote Control link reads its warnings),
// ignoring a process a newer start already replaced (electron/harness/codexProcess.cjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AppServer } from './support/codex-harness/fixture';

function fakeProc() {
  const p: any = new EventEmitter();
  p.pid = 42;
  p.kill = () => {};
  p.stdin = Object.assign(new EventEmitter(), { write: () => {} });
  p.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  p.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
  return p;
}

test('stderr reaches its listeners and the crash tail; a replaced process is ignored', () => {
  const procs: any[] = [];
  const server = new AppServer({ findBin: () => 'codex', env: () => ({}), spawn: () => procs[procs.push(fakeProc()) - 1] });
  const heard: string[] = [];
  server.stderrListeners.add((t: string) => heard.push(t));
  server.start();
  procs[0].stderr.emit('data', 'one\n');
  assert.deepEqual(heard, ['one\n']);
  assert.match(server.stderrTail.text, /one/);
  // a newer process took over: the old one's output is not news
  server.proc = procs[1] = fakeProc();
  procs[0].stderr.emit('data', 'stale\n');
  assert.deepEqual(heard, ['one\n']);
});

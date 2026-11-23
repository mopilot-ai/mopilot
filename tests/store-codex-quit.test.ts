// Codex status events about a copy that quit as it started (src/store/connection.ts onCodexStatus): the copy is named
// until one connects, and main's move to the next installed copy is said and becomes the copy in use.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { loadStore, flush, listeners, bootImpls } from './support/store-harness.ts';

mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
const { store: S } = await loadStore();
const st = () => S.useStore.getState();

test('a copy that quit as it started is named until one connects; a switch is said and names the copy in use', async () => {
  bootImpls();
  await S.boot();
  await flush();
  const on = listeners['codex.onStatus'];
  const alpha = { path: '/Applications/ChatGPT.app/codex', version: '0.163.0-alpha.10.2', via: 'app-bundle', from: 'ChatGPT.app' };
  const stable = { path: '/opt/homebrew/bin/codex', version: '0.162.0', via: 'brew', from: 'Homebrew' };
  // a crash after it had answered names no copy
  on({ kind: 'exit', code: 1, signal: null, stderr: 'boom', restarting: true });
  assert.equal(st().codexQuit, null);
  on({ kind: 'exit', code: 1, signal: null, stderr: 'panic', copy: alpha, restarting: true });
  assert.deepEqual(st().codexQuit, { copy: alpha, pinned: false });
  on({ kind: 'error', error: 'spawn EACCES', copy: stable, pinned: true });
  assert.deepEqual([st().conn, st().codexQuit], ['error', { copy: stable, pinned: true }]);
  on({ kind: 'gaveUp', copy: alpha, pinned: true });
  assert.deepEqual([st().codexRestart, st().codexQuit], ['gaveUp', { copy: alpha, pinned: true }]);
  // an older main's gave-up names nothing: the copy last named stays
  on({ kind: 'gaveUp' });
  assert.deepEqual(st().codexQuit, { copy: alpha, pinned: true });
  // main moved to the next copy: the window says so, and names that copy as the one in use
  on({ kind: 'switched', from: alpha, to: stable });
  assert.deepEqual([st().codexBinInUse, st().codexQuit], [stable.path, null]);
  assert.equal(
    st().toasts.at(-1)?.text,
    'Codex 0.163.0-alpha.10.2 from ChatGPT.app kept quitting, so MoPilot is using Codex 0.162.0 from Homebrew instead.',
  );
  on({ kind: 'exit', code: 1, signal: null, stderr: 'panic', copy: alpha, restarting: true });
  // it came back: nothing is named
  on({ kind: 'ready' });
  await flush();
  assert.deepEqual([st().conn, st().codexQuit], ['ready', null]);
});

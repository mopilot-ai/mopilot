// src/store/codexTasks.ts's poller release: the last holder stops it after one more read, so a command a Codex turn
// left running as it ended, before the next tick, is listed as a running task (and keeps the chat polled).
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubStore } from './support/stubs.ts';

const state: any = { runtime: {}, threads: {}, paneTabs: [], route: { name: 'home' }, split: null };
let terminals: any = { data: [] };
stubStore(
  {
    getState: () => state,
    nativeOf: (id: string) => id,
    blockedReason: () => null,
    patchTurn: () => {},
    terminateBackgroundTerminal: async () => true,
    toast: () => {},
  },
  {
    'src/store/chats.ts': { chatFamily: () => 'codex', nativeOf: (id: string) => id },
  },
);
mock.module('../src/harness/adapters/codexApi.ts', {
  namedExports: { codexApi: { backgroundTerminals: async () => terminals } },
});
const P = await import('../src/store/codexTasks.ts');

const term = (pid: string) => ({ itemId: `item-${pid}`, processId: pid, command: `cmd ${pid}`, cwd: '/', osPid: null });
const settle = () => new Promise((r) => setImmediate(r));

test('the last holder stops the poller after one more read, which lists a command the ended turn left running', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  P.startCodexTaskPoller('c');
  await settle();
  assert.deepEqual(P.codexTasks('c'), [], 'the turn has left nothing yet');
  // the turn ends, leaving a command running, before the next tick: its holder lets go
  terminals = { data: [term('late')] };
  P.stopCodexTaskPoller('c');
  await settle();
  assert.deepEqual(
    P.codexTasks('c').map((x) => [x.description, x.status]),
    [['cmd late', 'running']],
  );
  // stopped for good: no timer reads again, and a release with no holder reads nothing
  terminals = { data: [] };
  t.mock.timers.tick(P.POLL_MS);
  P.stopCodexTaskPoller('c');
  await settle();
  assert.equal(P.codexTasks('c')[0].status, 'running');
});

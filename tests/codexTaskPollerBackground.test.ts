// src/store/codexTasks.ts: a chat no pane shows is read every BACKGROUND_POLL_MS, not every tick; the chat a pane shows keeps the 3 s read.
// A chat whose first read never happened still ticks safely.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import { stubStore } from './support/stubs.ts';

const state: any = { runtime: {}, threads: {}, paneTabs: [], route: { name: 'home' }, split: null };
let terminals: any = { data: [] };
let harness = 'codex';
let terminalCalls = 0;
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
    'src/store/chats.ts': { chatFamily: () => harness, nativeOf: (id: string) => id },
  },
);
mock.module('../src/harness/adapters/codexApi.ts', {
  namedExports: { codexApi: { backgroundTerminals: async () => (terminalCalls++, terminals) } },
});
const P = await import('../src/store/codexTasks.ts');

test('a chat no pane shows is read once per BACKGROUND_POLL_MS; one a side pane shows is read every tick', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  terminals = { data: [] };
  for (const chat of ['bg-off', 'bg-on']) state.runtime[chat] = { loaded: true, turns: [{ id: 't1', items: [] }] };
  state.paneTabs = [{ threadId: 'bg-on' }];
  P.startCodexTaskPoller('bg-off');
  P.startCodexTaskPoller('bg-on');
  await new Promise((r) => setImmediate(r));
  const before = terminalCalls;
  t.mock.timers.tick(P.POLL_MS);
  await new Promise((r) => setImmediate(r));
  assert.equal(terminalCalls - before, 1, 'only the shown chat is read on the next tick');
  t.mock.timers.tick(P.BACKGROUND_POLL_MS);
  await new Promise((r) => setImmediate(r));
  assert.ok(terminalCalls - before >= 3, 'after BACKGROUND_POLL_MS the hidden chat is read too');
  P.stopCodexTaskPoller('bg-off');
  P.stopCodexTaskPoller('bg-on');
  state.paneTabs = [];
});

test('a chat that has never been read (nothing to poll at start) is read on its first background tick without a crash', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  harness = 'claude';
  state.runtime['bg-cold'] = { loaded: true, turns: [] };
  P.startCodexTaskPoller('bg-cold');
  await new Promise((r) => setImmediate(r));
  t.mock.timers.tick(P.POLL_MS);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(P.codexTasks('bg-cold'), []);
  P.stopCodexTaskPoller('bg-cold');
  harness = 'codex';
});

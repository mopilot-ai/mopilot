// Wiring the agent page and tasks pane to each harness (src/store/agentWiring.ts): the chat's current harness picks the
// transcript loader, the task stopper and the output reader, and Codex tasks are polled only while they matter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { mockSource, stubStore, stubSlice } from './support/stubs.ts';
import { installFakeRuntime } from './support/ports/runtime.ts';
import { createElement, act, useLayoutEffect } from 'react';

const calls: string[] = [];
const fixture = {
  acp: false,
  historical: false,
  harness: 'codex' as 'codex' | 'claude',
  state: { runtime: {} as Record<string, any>, segments: {} as Record<string, any> },
};
const loadedSources: any[] = [];
const tag = (n: string) =>
  Object.assign(async (_chat: string, run: any) => (calls.push(n), loadedSources.push(run.source), [] as any[]), { n });
// the Claude Code and ACP sides through the runtime main installs; Codex's loader is still imported
installFakeRuntime({
  loadClaudeAgentThread: tag('loadClaude'),
  readClaudeTaskOutput: async (t: any) => `claude:${t.id}`,
  loadAcpAgentThread: tag('loadAcp'),
  stopClaudeTask: async () => (calls.push('stopClaude'), true),
  claudeMoveToBackground: async (c: string) => (calls.push(`bg:${c}`), true),
});
mockSource('src/store/codexAgents.ts', { loadCodexAgentThread: tag('loadCodex') });
stubStore({
  toast: (t: string) => calls.push(`toast:${t}`),
  useStore: (select: any) => select(fixture.state),
  getState: () => fixture.state,
});
mockSource('src/store/codexTasks.ts', {
  shouldPollTasks: () => fixture.acp || fixture.harness === 'codex' || fixture.historical,
  stopCodexTask: async () => (calls.push('stopCodex'), true),
  codexTaskOutput: (chat: string, t: any) => `codex:${chat}:${t.id}`,
  startCodexTaskPoller: (c: string) => calls.push(`start:${c}`),
  stopCodexTaskPoller: (c: string) => calls.push(`stop:${c}`),
});
stubSlice('src/store/chats.ts', {
  chatFamily: () => (fixture.acp ? 'acp' : fixture.harness),
  nativeOf: (c: string) => (fixture.acp ? `acp:kimi:${c}` : c),
});

const W = await import('../src/store/agentWiring.ts');
const threads = await import('../src/store/agentThreads.ts');
const bg = await import('../src/store/backgroundTasks.ts');
const { createRoot } = await import('react-dom/client');

const run = { key: 'k', description: 'd', transcript: 'full', status: 'completed' } as any;
const task = { id: 't1', status: 'running' } as any;

test('each chat family gets its own loader, stopper and output reader', async () => {
  W.wireAgentSurfaces();
  for (const [acp, harness, loader, stopper, out] of [
    [false, 'claude', 'loadClaude', 'stopClaude', 'claude:t1'],
    [false, 'codex', 'loadCodex', 'stopCodex', 'codex:c:t1'],
    [true, 'codex', 'loadAcp', null, null],
  ] as const) {
    fixture.acp = acp;
    fixture.harness = harness;
    calls.length = 0;
    await threads.loadAgentThread(`c${loader}`, run);
    assert.deepEqual(calls, [loader]);
    calls.length = 0;
    const ok = await bg.stopBackgroundTask('c', task);
    assert.equal(ok, stopper !== null);
    assert.deepEqual(calls, stopper ? [stopper] : []);
    const reader = bg.taskOutputReader('c');
    assert.equal(reader ? await reader(task) : null, out);
  }
});

test('useTaskPolling polls Codex chats only while wanted', async () => {
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const Probe = ({ wanted }: { wanted: boolean }) => (W.useTaskPolling('p', wanted), null);
  calls.length = 0;
  fixture.harness = 'codex';
  await act(() => root.render(createElement(Probe, { wanted: false })));
  assert.deepEqual(calls, []);
  await act(() => root.render(createElement(Probe, { wanted: true })));
  assert.deepEqual(calls, ['start:p']);
  await act(() => root.render(createElement(Probe, { wanted: false })));
  assert.deepEqual(calls, ['start:p', 'stop:p']);
  // an ACP chat's sub-agents are read from its turns on the same poller; a Claude chat's tasks come from main
  fixture.acp = true;
  calls.length = 0;
  await act(() => root.render(createElement(Probe, { wanted: true })));
  assert.deepEqual(calls, ['start:p']);
  await act(() => root.render(createElement(Probe, { wanted: false })));
  fixture.acp = false;
  fixture.harness = 'claude';
  calls.length = 0;
  await act(() => root.render(createElement(Probe, { wanted: true })));
  assert.deepEqual(calls, []);
  fixture.harness = 'codex';
  // a Claude chat is never polled: its tasks come from main
  fixture.harness = 'claude';
  calls.length = 0;
  await act(() => root.render(createElement(Probe, { wanted: true })));
  assert.deepEqual(calls, []);
  await act(() => root.unmount());
});

test('moving work to the background goes to Claude Code, and says plainly that Codex and ACP cannot', async () => {
  fixture.acp = false;
  fixture.harness = 'claude';
  calls.length = 0;
  assert.equal(await W.moveToBackground('c'), true);
  assert.deepEqual(calls, ['bg:c']);
  for (const [acp, harness] of [
    [false, 'codex'],
    [true, 'codex'],
  ] as const) {
    fixture.acp = acp;
    fixture.harness = harness;
    calls.length = 0;
    assert.equal(await W.moveToBackground('c'), false);
    assert.deepEqual(calls, ["toast:This chat's harness can't move running work to the background"]);
  }
});

test('a switch with the same chat and wanted state restarts polling for the selected source', async () => {
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const Probe = () => (W.useTaskPolling('same-chat', true), null);
  fixture.acp = false;
  fixture.harness = 'codex';
  calls.length = 0;
  await act(() => root.render(createElement(Probe)));
  fixture.harness = 'claude';
  await act(() => root.render(createElement(Probe)));
  assert.deepEqual(calls, ['start:same-chat', 'stop:same-chat']);
  fixture.acp = true;
  await act(() => root.render(createElement(Probe)));
  assert.deepEqual(calls, ['start:same-chat', 'stop:same-chat', 'start:same-chat']);
  await act(() => root.unmount());
  fixture.acp = false;
  fixture.harness = 'codex';
});

test('an effect for an obsolete render cannot start polling the replacement source', async () => {
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const Probe = () => {
    W.useTaskPolling('commit-switch', true);
    useLayoutEffect(() => {
      fixture.harness = 'claude';
    }, []);
    return null;
  };
  fixture.harness = 'codex';
  calls.length = 0;
  await act(() => root.render(createElement(Probe)));
  assert.deepEqual(calls, []);
  await act(() => root.unmount());
  fixture.harness = 'codex';
});

test('retained Claude jobs use their owning adapter for stops and output after mixed switches', async () => {
  W.wireAgentSurfaces();
  const old = { ...task, source: { kind: 'claude', key: 'claude:old' } } as any;
  for (const acp of [false, true]) {
    fixture.acp = acp;
    fixture.harness = 'codex';
    calls.length = 0;
    assert.equal(await bg.stopBackgroundTask('stable', old), true);
    assert.deepEqual(calls, ['stopClaude']);
    assert.equal(await bg.taskOutputReader('stable', old.source)!(old), 'claude:t1');
  }
  fixture.acp = false;
  fixture.harness = 'codex';
});

test('historical and nested agent pages load through the parent segment owner', async () => {
  W.wireAgentSurfaces();
  const chat = 'historical-agent-page';
  const parent = { ...run, key: 'old-parent-agent' };
  fixture.state.runtime[chat] = { turns: [{ items: [{ type: 'dynamicToolCall', id: 'parent', agent: parent }] }, { items: [] }] };
  fixture.state.segments[chat] = [
    { start: 0, nativeId: 'old-codex-parent', harness: 'codex' },
    { start: 1, nativeId: 'acp:kimi:new', harness: 'codex' },
  ];
  fixture.acp = true;
  fixture.harness = 'codex';
  calls.length = 0;
  await threads.loadAgentThread(chat, parent);
  assert.deepEqual(calls, ['loadCodex']);
  assert.deepEqual(loadedSources.at(-1), { kind: 'codex', key: 'old-codex-parent' });
  const nested = { ...run, key: 'nested-old-agent' };
  threads.putAgentItems(chat, parent.key, [{ type: 'dynamicToolCall', id: 'nested', agent: nested }]);
  calls.length = 0;
  await threads.loadAgentThread(chat, nested);
  assert.deepEqual(calls, ['loadCodex']);
  assert.deepEqual(loadedSources.at(-1), { kind: 'codex', key: 'old-codex-parent' });
  fixture.acp = false;
});

test('partial historical segment ranges fall back to the first recorded native owner', async () => {
  const { taskSourceAt } = await import('../src/store/chatFamily.ts');
  fixture.acp = false;
  fixture.harness = 'codex';
  assert.deepEqual(taskSourceAt('partial', 0, [{ start: 5, harness: 'claude', nativeId: 'claude:first' }] as any), {
    kind: 'claude',
    key: 'claude:first',
  });
  assert.deepEqual(taskSourceAt('partial', 0, []), { kind: 'codex', key: 'partial' });
});

test('a Claude chat with historical polled work starts the adapter poller', async () => {
  const chat = 'claude-with-old-code-work';
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const Probe = () => (W.useTaskPolling(chat, true), null);
  fixture.harness = 'claude';
  fixture.acp = false;
  fixture.historical = false;
  calls.length = 0;
  await act(() => root.render(createElement(Probe)));
  assert.deepEqual(calls, []);
  fixture.historical = true;
  fixture.state.runtime[chat] = { turns: [{ items: [] }] };
  await act(() => root.render(createElement(Probe)));
  assert.deepEqual(calls, [`start:${chat}`]);
  await act(() => root.unmount());
  fixture.historical = false;
  fixture.harness = 'codex';
});

test('an agent page keeps its captured owner when parent history is temporarily absent', async () => {
  W.wireAgentSurfaces();
  fixture.harness = 'claude';
  fixture.acp = false;
  calls.length = 0;
  await threads.loadAgentThread('history-reload', {
    ...run,
    key: 'captured-code-agent',
    source: { kind: 'codex', key: 'original-parent' },
  });
  assert.deepEqual(calls, ['loadCodex']);
  assert.deepEqual(loadedSources.at(-1), { kind: 'codex', key: 'original-parent' });
  fixture.harness = 'codex';
});

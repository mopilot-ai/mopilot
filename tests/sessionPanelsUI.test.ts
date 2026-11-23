// Outputs expose surviving files, published pages and older history; Usage puts every login's plan limits first, then refuses stale or unavailable reports.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { mockStore, autoMock, render, resetStore, setStore, useStore, callsTo, impl, settle } from './support/thread-kit.ts';
import { contextUsageKey } from '../src/store/contextUsage.ts';
import { deferred } from './support/async-scenarios.ts';
mockStore();
autoMock('src/store/outputs/pane.ts', 'outputs');
let context: any = { reading: null, state: 'none' };
autoMock('src/session/useChatContext.ts', 'context', { useChatContextState: () => context });
let machine: { id: string; name: string; away: boolean } | null = null;
autoMock('src/lib/chatMachine.ts', 'machine', { useChatMachine: () => ({ machine, pending: false }) });
// the plan limits have their own test (planUsageUI.test.ts): here only where they go
autoMock('src/components/panels/PlanUsage.tsx', 'plan', { PlanUsage: () => h('section', { className: 'stub-plan-usage' }) });
const { OutputsPanel } = await import('../src/components/panels/OutputsPanel.tsx');
const { UsagePanel } = await import('../src/components/panels/UsagePanel.tsx');
const file = (path: string, type = 'add') => ({
  type: 'fileChange',
  id: path,
  status: 'completed',
  changes: [{ path, kind: { type }, diff: '' }],
});
const turns = (items: any[]) => [{ id: 't', status: 'completed', items }];
const click = (host: HTMLElement, text: string) =>
  settle(() => [...host.querySelectorAll('button')].find((b) => b.textContent === text)!.click());
beforeEach(() => {
  resetStore({ threads: { a: { cwd: '/repo' } }, runtime: {}, segments: {} });
  context = { reading: null, state: 'none' };
  machine = null;
});

test('an empty or loading Outputs pane describes only loaded history; files open through their origin', async () => {
  const v = await render(h(OutputsPanel, { threadId: 'a' }));
  assert.match(v.host.textContent!, /No outputs in the loaded part/);
  await settle(() => setStore({ runtime: { a: { loading: true, turns: [] } } }));
  assert.match(v.host.textContent!, /Loading conversation/);
  await settle(() =>
    setStore({
      runtime: { a: { turns: turns([file('report.pdf'), file('gone.png', 'delete')]), errorFromRead: true, error: 'history unavailable' } },
    }),
  );
  assert.match(v.host.textContent!, /history unavailable/);
  assert.match(v.host.textContent!, /1 output/);
  await click(v.host, 'report.pdf');
  assert.deepEqual(callsTo('outputs:openOutputFile').at(-1), ['a', '/repo/report.pdf']);
  await v.rerender(h(OutputsPanel, { threadId: 'b' }));
  assert.match(v.host.textContent!, /No outputs in the loaded part/);
});

test('published artifact versions combine by page identity, retain a title and open the existing shared browser route', async () => {
  const url = 'https://claude.ai/code/artifact/0a21f3e3-1b2c-4d5e-8f90-123456789abc';
  const publish = (version: number, title?: string) => ({
    type: 'mcpToolCall',
    id: String(version),
    server: '',
    tool: 'Artifact',
    arguments: { title },
    status: 'completed',
    result: { content: [{ type: 'text', text: `Created a new Artifact at ${url} (version ${version})` }] },
  });
  setStore({ runtime: { a: { turns: turns([publish(1, 'Report'), publish(2)]) } } });
  const v = await render(h(OutputsPanel, { threadId: 'a' }));
  await click(v.host, 'Report · v2');
  assert.deepEqual(callsTo('store:openPaneTab').at(-1), ['browser', { url, ownerChat: 'a', title: 'Report' }]);
  assert.equal(v.$$('.session-output').length, 1);
  await settle(() => setStore({ runtime: { a: { turns: turns([publish(3)]) } } }));
  await click(v.host, 'Artifact · v3');
  assert.equal(callsTo('store:openPaneTab').at(-1)?.[1].title, 'Artifact');
});

test('loading earlier outputs prevents overlapping requests, reports a rejection and permits retry', async () => {
  setStore({ runtime: { a: { turns: [], olderCursor: 'older' } } });
  const wait = deferred<void>();
  impl['store:loadOlderTurns'] = () => wait.promise;
  const v = await render(h(OutputsPanel, { threadId: 'a' }));
  await click(v.host, 'Load earlier outputs');
  assert.equal((v.$('button') as HTMLButtonElement).disabled, true);
  await settle(() => wait.reject(Error('History read failed')));
  assert.match(v.host.textContent!, /History read failed/);
  impl['store:loadOlderTurns'] = async () => {
    throw '';
  };
  await click(v.host, 'Load earlier outputs');
  assert.match(v.host.textContent!, /Could not load earlier outputs/);
  impl['store:loadOlderTurns'] = async () => setStore({ runtime: { a: { turns: turns([file('older.md')]), olderCursor: null } } });
  await click(v.host, 'Load earlier outputs');
  assert.match(v.host.textContent!, /older.md/);
  assert.equal(v.host.textContent!.includes('Load earlier outputs'), false);
});

test('Usage distinguishes context, reported session totals and unavailable cost, and invalidates a replaced native owner', async () => {
  const v = await render(h(UsagePanel, { threadId: 'a' }));
  // the plan limits come before this chat's own use
  assert.deepEqual(
    v.$$('.stub-plan-usage, h3').map((e) => e.className || e.textContent),
    ['stub-plan-usage', 'This chat'],
  );
  assert.deepEqual(
    v.$$('dd').map((d) => d.textContent),
    ['Not reported', 'Not reported', 'Not reported', 'Not reported'],
  );
  context = { reading: null, state: 'reading' };
  await v.rerender(h(UsagePanel, { threadId: 'a' }));
  assert.equal(v.$('dd')!.textContent, 'Reading…');
  context = { reading: { used: 4000, window: 200000 }, state: 'ready' };
  const owner = contextUsageKey(undefined, 'a');
  await settle(() => setStore({ runtime: { a: { tokenUsageOwner: owner, tokenUsage: { total: { totalTokens: 8000 } } } } }));
  assert.deepEqual(
    v.$$('dd').map((d) => d.textContent),
    ['4k', '200k', '8k', 'Not reported'],
  );
  context = { reading: null, state: 'none' };
  await settle(() => setStore({ segments: { a: [{ harness: 'claude', nativeId: 'changed' }] } }));
  assert.equal(v.$$('dd')[2].textContent, 'Not reported');
  const current = contextUsageKey(useStore.getState().segments.a, 'a');
  for (const total of [0, NaN, Infinity, -1]) {
    await settle(() => setStore({ runtime: { a: { tokenUsageOwner: current, tokenUsage: { total: { totalTokens: total } } } } }));
    assert.equal(v.$$('dd')[2].textContent, 'Not reported');
  }
});

test('a published page without a version remains available without inventing a version label', async () => {
  const url = 'https://claude.ai/code/artifact/0a21f3e3-1b2c-4d5e-8f90-123456789abc';
  setStore({
    runtime: {
      a: {
        turns: turns([
          {
            type: 'mcpToolCall',
            id: 'page',
            server: '',
            tool: 'Artifact',
            arguments: { title: 'Unversioned' },
            status: 'completed',
            result: { content: [{ type: 'text', text: `Created a new Artifact at ${url}` }] },
          },
        ]),
      },
    },
  });
  const v = await render(h(OutputsPanel, { threadId: 'a' }));
  assert.equal(v.$$('.session-output').length, 1);
  await click(v.host, 'Unversioned');
  assert.deepEqual(callsTo('store:openPaneTab').at(-1), ['browser', { url, ownerChat: 'a', title: 'Unversioned' }]);
});

test('the Outputs pane of a chat on a machine lists its files, and says so while the machine is away', async () => {
  resetStore({
    threads: { a: { cwd: '/srv/app' } },
    runtime: { a: { turns: turns([file('/srv/app/report.pdf')]) } },
    segments: {},
  });
  machine = { id: 'm', name: 'box', away: false };
  let v = await render(h(OutputsPanel, { threadId: 'a' }));
  assert.equal(v.$$('.session-output').length, 1);
  assert.match(v.host.textContent!, /report\.pdf/);
  assert.doesNotMatch(v.host.textContent!, /aren't/);
  await v.unmount();
  machine = { id: 'm', name: 'box', away: true };
  v = await render(h(OutputsPanel, { threadId: 'a' }));
  assert.match(v.host.textContent!, /Files aren't available while box is offline\./);
  assert.equal(v.$$('.session-output').length, 0);
  assert.doesNotMatch(v.host.textContent!, /No outputs in the loaded part/);
  await v.unmount();
});

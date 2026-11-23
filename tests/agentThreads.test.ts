// The agent page's transcript store (src/store/agentThreads.ts): live items from a running session win over a
// stored load, a load runs once per agent, a summary-only run (a harness that shares no steps) never loads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { window } from './support/dom.ts';
import { createElement, act } from 'react';

const { createRoot } = await import('react-dom/client');
const T = await import('../src/store/agentThreads.ts');

const run = (key: string, extra: any = {}) => ({ key, description: key, transcript: 'full', status: 'completed', ...extra }) as any;
const item = (id: string) => ({ type: 'agentMessage', id, text: id });

test('loads a stored transcript once through the chat loader, and records failures', async () => {
  // no loader wired yet (the default), then none for this chat
  await T.loadAgentThread('c0', run('none'));
  T.setAgentThreadLoaderResolver(() => null);
  await T.loadAgentThread('c0', run('none'));
  assert.equal(T.agentThread('c0', 'none').loading, false);

  let calls = 0;
  let release!: (v: any) => void;
  T.setAgentThreadLoaderResolver((chat) =>
    chat === 'bad'
      ? async () => {
          throw new Error('gone');
        }
      : chat === 'odd'
        ? async () => {
            throw 'plain';
          }
        : () => (calls++, new Promise((r) => (release = r))),
  );
  const p = T.loadAgentThread('c1', run('a'));
  assert.equal(T.agentThread('c1', 'a').loading, true);
  // a second load while loading is a no-op
  await T.loadAgentThread('c1', run('a'));
  release([item('1')]);
  await p;
  assert.deepEqual(T.agentThread('c1', 'a').items, [item('1')]);
  assert.equal(calls, 1);
  // already loaded: no new call
  await T.loadAgentThread('c1', run('a'));
  assert.equal(calls, 1);
  // summary-only runs never load
  await T.loadAgentThread('c1', run('s', { transcript: 'summary' }));
  assert.equal(calls, 1);

  await T.loadAgentThread('bad', run('x'));
  assert.equal(T.agentThread('bad', 'x').error, 'gone');
  await T.loadAgentThread('odd', run('x'));
  assert.equal(T.agentThread('odd', 'x').error, 'plain');
});

test("live items win over a load that finishes later, and stay their own chat's", async () => {
  let release!: (v: any) => void;
  T.setAgentThreadLoaderResolver(() => () => new Promise((r) => (release = r)));
  const p = T.loadAgentThread('c2', run('b'));
  T.putAgentItems('c2', 'b', [item('live')]);
  release([item('stored')]);
  await p;
  assert.deepEqual(T.agentThread('c2', 'b').items, [item('live')]);
  assert.equal(T.agentThread('c2', 'b').live, true);
  // live: no load
  await T.loadAgentThread('c2', run('b'));
  T.putAgentItems('c3', 'b', [item('x')]);
  assert.deepEqual(T.agentThread('c2', 'b').items, [item('live')]);
  assert.deepEqual(T.agentThread('c3', 'b').items, [item('x')]);
});

test('useAgentThread renders the transcript and loads it on mount', async () => {
  T.setAgentThreadLoaderResolver(() => async () => [item('m')]);
  const host = window.document.createElement('div');
  const root = createRoot(host as any);
  const Probe = ({ r }: { r: any }) => {
    const t = T.useAgentThread('c4', r);
    return createElement('i', null, t.items.map((i) => i.id).join(',') || (t.loading ? 'loading' : 'empty'));
  };
  await act(() => root.render(createElement(Probe, { r: null })));
  assert.equal(host.textContent, 'empty');
  await act(async () => root.render(createElement(Probe, { r: run('k') })));
  await act(async () => {});
  assert.equal(host.textContent, 'm');
  await act(() => root.unmount());
});

test('live steps also win over a stored read that fails late', async () => {
  let reject!: (error: Error) => void;
  T.setAgentThreadLoaderResolver(
    () => () =>
      new Promise((_resolve, fail) => {
        reject = fail;
      }),
  );
  const pending = T.loadAgentThread('late-live', run('a'));
  T.putAgentItems('late-live', 'a', [item('live')]);
  const live = T.agentThread('late-live', 'a');
  reject(new Error('old transcript gone'));
  await pending;
  assert.equal(T.agentThread('late-live', 'a'), live);
  assert.equal(live.error, null);
  assert.equal(live.loading, false);
});

test('opaque chat and agent keys keep transcripts and pending loads owned separately', async () => {
  const a = 'tuple-chat';
  const b = 'tuple-chat\0part';
  T.putAgentItems(a, 'part\0run', [item('first')]);
  T.putAgentItems(b, 'run', [item('second')]);
  assert.deepEqual(T.agentThread(a, 'part\0run').items, [item('first')]);
  const waiting: ((items: any[]) => void)[] = [];
  T.setAgentThreadLoaderResolver(() => () => new Promise((resolve) => waiting.push(resolve)));
  const first = T.loadAgentThread(a, run('pending'));
  const second = T.loadAgentThread(b, run('pending'));
  // one chat's live stream retires only its own load
  T.putAgentItems(a, 'pending', [item('live')]);
  assert.deepEqual(T.agentThread(b, 'run').items, [item('second')]);
  waiting[0]([item('retired')]);
  waiting[1]([item('loaded')]);
  await Promise.all([first, second]);
  assert.deepEqual(T.agentThread(a, 'pending').items, [item('live')]);
  assert.deepEqual(T.agentThread(b, 'pending').items, [item('loaded')]);
});

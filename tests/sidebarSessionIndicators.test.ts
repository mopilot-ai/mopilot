// Real sidebar session hooks load background state on mount and retire stale native status after retry or chat switches.
import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { createElement, act, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { deferred } from './support/async-scenarios.ts';
import type { Thread } from '../src/store/types.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const snapshots = new Map<string, unknown>();
const calls: string[] = [];
let onPatch: (p: unknown) => void;
installNativeStub({
  session: {
    snapshot: async (id: string) => {
      calls.push(id);
      return snapshots.get(id);
    },
    onPatch: (cb: typeof onPatch) => {
      // the session store commits a frame's patches together; the test wants each one shown
      onPatch = (patch) => {
        cb(patch);
        flushSessionPatches();
      };
    },
  },
});
stubStore({
  useStore: (select: any) => select({ runtime: {}, pending: [], elsewhere: {}, unread: {}, agentTabs: {} }),
  ELSEWHERE_LABEL: {},
});
mock.module('../src/session/voice.ts', { namedExports: { useVoice: (select: any) => select({ threadId: null, phase: 'idle' }) } });
const { ThreadActivityIndicator } = await import('../src/components/sidebar/ThreadIndicators.tsx');
const { useSessions, startSessions, flushSessionPatches } = await import('../src/store/session/useSession.ts');
const { EMPTY_SESSION } = await import('../src/store/session/sessionState.ts');
startSessions();
const chat = (id: string, status: any = { type: 'idle' }) => ({ id, cwd: '/repo', status }) as Thread;
const snap = (rev: number, turn: string, approvals: any[] = []) => ({ ...EMPTY_SESSION, rev, turn, approvals });

test('sidebar mount reads background main sessions on every harness, without opening a chat', async () => {
  for (const id of ['codex-background', 'claude-background', 'acp:gemini:background']) {
    useSessions.setState({ sessions: {} });
    calls.length = 0;
    snapshots.set(id, snap(1, 'running'));
    const host = document.createElement('div');
    const root = createRoot(host as any);
    try {
      await act(async () => root.render(createElement(StrictMode, null, createElement(ThreadActivityIndicator, { thread: chat(id) }))));
      assert.deepEqual(calls, [id], 'Strict Mode coalesces the snapshot');
      assert.equal(host.querySelector('[aria-label="Working"]') !== null, true);
      await act(async () => onPatch({ chatId: id, rev: 2, patch: { turn: 'crashed' } }));
      assert.equal(host.querySelector('[aria-label="Chat failed"]') !== null, true);
      await act(async () => root.render(createElement(ThreadActivityIndicator, { thread: chat(id, { type: 'systemError' }) })));
      await act(async () => onPatch({ chatId: id, rev: 3, patch: { turn: 'running' } }));
      assert.equal(host.querySelector('[aria-label="Working"]') !== null, true, 'a retry supersedes stale native error state');
      await act(async () =>
        root.render(createElement(ThreadActivityIndicator, { thread: chat(id, { type: 'active', activeFlags: ['waitingOnApproval'] }) })),
      );
      assert.equal(host.querySelector('[aria-label="Awaiting approval"]'), null, 'native list flags cannot resurrect an old approval');
      await act(async () => onPatch({ chatId: id, rev: 4, patch: { turn: 'idle' } }));
      assert.equal(host.querySelector('[aria-label="Working"]'), null, 'main completion supersedes stale native activity');
      await act(async () => root.render(createElement(ThreadActivityIndicator, { thread: chat(id, { type: 'systemError' }) })));
      assert.equal(host.querySelector('[aria-label="Chat failed"]'), null, 'completion cannot resurrect the pre-retry error');
      for (const [method, params, label] of [
        ['claude/permission', { toolName: 'AskUserQuestion' }, 'Needs input'],
        ['claude/permission', { toolName: 'Bash' }, 'Awaiting approval'],
        ['item/tool/requestUserInput', {}, 'Needs input'],
        ['mcpServer/elicitation/request', {}, 'Needs input'],
        ['acp/permission', {}, 'Awaiting approval'],
        ['sage/browser', {}, 'Awaiting approval'],
      ] as const) {
        const current = useSessions.getState().sessions[id];
        await act(async () =>
          onPatch({ chatId: id, rev: current.rev + 1, patch: { turn: 'awaitingUser', approvals: [{ id: 'request', method, params }] } }),
        );
        assert.equal(host.querySelector(`[aria-label="${label}"]`) !== null, true, method);
      }
      const current = useSessions.getState().sessions[id];
      await act(async () => onPatch({ chatId: id, rev: current.rev + 1, patch: { turn: 'running', approvals: [], chromeApproval: true } }));
      assert.equal(host.querySelector('[aria-label="Awaiting approval"]') !== null, true);
      const latest = useSessions.getState().sessions[id];
      await act(async () =>
        onPatch({ chatId: id, rev: latest.rev + 1, patch: { turn: 'idle', chromeApproval: false, runningElsewhere: true } }),
      );
      assert.equal(host.querySelector('[aria-label="Running in another app"]') !== null, true);
      await act(async () => onPatch({ chatId: id, rev: latest.rev + 2, patch: { runningElsewhere: false } }));
      assert.equal(host.querySelector('[aria-label="Running in another app"]'), null);
    } finally {
      await act(async () => root.unmount());
    }
  }
});

test('a retired snapshot success or failure never changes a replacement row, and remount can retry', async () => {
  for (const reject of [false, true]) {
    useSessions.setState({ sessions: {} });
    const old = deferred();
    snapshots.set('old', old.promise);
    snapshots.set('new', snap(1, 'running'));
    const host = document.createElement('div');
    const root = createRoot(host as any);
    try {
      await act(async () => root.render(createElement(ThreadActivityIndicator, { thread: chat('old') })));
      await act(async () => root.render(createElement(ThreadActivityIndicator, { thread: chat('new') })));
      await act(async () => {
        if (reject) old.reject(new Error('old snapshot failed'));
        else old.resolve(snap(1, 'crashed'));
      });
      assert.equal(host.querySelector('[aria-label="Working"]') !== null, true);
      assert.equal(host.querySelector('[aria-label="Chat failed"]'), null);
      snapshots.set('old', snap(2, 'running'));
      // A completed old snapshot intentionally seeds the shared chat cache; failure leaves it retryable.
      if (reject) {
        await act(async () => root.render(createElement(ThreadActivityIndicator, { thread: chat('old') })));
        assert.equal(host.querySelector('[aria-label="Working"]') !== null, true);
      }
    } finally {
      await act(async () => root.unmount());
    }
  }
});

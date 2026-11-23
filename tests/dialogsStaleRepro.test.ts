// Status reads each chat's context for its own owner only, using the real Dialogs component: an answer for one chat, harness or native session never shows for another, and a failed ask is noted and asked again.
import { test, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { contextUsageKey } from '../src/store/contextUsage.ts';
import { createElement as h, act, useSyncExternalStore, StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { deferred } from './support/async-scenarios.ts';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';
const reads = new Map<string, ReturnType<typeof deferred>>();
const toasts: any[] = [];
const ignored: any[][] = [];
let family = 'claude',
  nativeIdSuffix = '',
  usage: any = null;
const listeners = new Set<() => void>();
let revision = 0;
const notify = () => {
  revision++;
  listeners.forEach((fn) => fn());
};
stubStore({
  useStore: (fn: any) => {
    useSyncExternalStore(
      (cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
      () => revision,
    );
    const segments = { A: [{ harness: family, nativeId: 'A' + nativeIdSuffix }] };
    return fn({ runtime: { A: { tokenUsage: usage, tokenUsageOwner: contextUsageKey(segments.A as any, 'A') } }, segments });
  },
  toast: (...a: any[]) => toasts.push(a),
  chatHarnessLabel: () => 'Claude',
  chatFamily: () => family,
  newChatFamily: () => family,
  newChatBasic: () => null,
  nativeOf: (id: string) => id + nativeIdSuffix,
});
// main's context bridge: each ask waits on a read keyed by the native session it is for
let clock = 0;
const ask = (owner: string) => {
  const d = deferred();
  reads.set(JSON.parse(owner)[2], d);
  return d.promise.then((r: any) => r && { owner, at: ++clock, used: r.totalTokens, window: r.maxTokens });
};
installNativeStub({ context: { get: ask, refresh: ask, onSnapshot: () => () => {} } });
mock.module('../src/lib/ignored.ts', {
  namedExports: { errorText: String, noteIgnored: (...args: any[]) => ignored.push(args), ignoring: () => () => {} },
});
// the context card's memory files open through the shared opener
mock.module('../src/session/open.ts', { namedExports: { openFile: () => {} } });
mock.module('../src/session/clipboard.ts', { namedExports: { copyText: () => {} } });
mock.module('../src/components/ui/Modal.tsx', {
  namedExports: {
    Modal: ({ children, title, onClose }: any) =>
      h('section', { 'aria-label': title }, h('button', { onClick: onClose }, 'Close modal'), children),
  },
});
mock.module('../src/components/dialogs/ChromeAllowDialog.tsx', { namedExports: { ChromeAllowDialog: () => null } });
mock.module('../src/components/dialogs/DesignLoginDialog.tsx', {
  namedExports: { DesignLoginDialog: () => null, OPEN_DESIGN_LOGIN: 'open-design-login' },
});
mock.module('../src/harness/types.ts', { namedExports: { HARNESS_LABEL: { claude: 'Claude', codex: 'Codex' } } });
mock.module('../src/harness/family.ts', {
  namedExports: {
    HARNESS_TRAITS: { claude: { contextBreakdown: 'full' }, codex: { contextBreakdown: 'tokens' }, acp: { contextBreakdown: 'tokens' } },
    firstTierOf: (h: any) => (h === 'basic' ? null : h),
    // the shared context reading (useChatContext) names the family the way the store does
    currentFamily: () => (family === 'basic' ? 'acp' : family),
  },
});
mock.module('../src/session/harness/acp.ts', { namedExports: { acpModelName: () => '', basicLabel: () => '' } });
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: () => ({}),
    useSessionField: (id: any, pick: any) => pick(((() => ({})) as (id: any) => any)(id)),
  },
});
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    chatAccountLabel: () => '',
    pinnedElsewhere: () => false,
    useChatAccount: () => null,
    useEffectiveSelection: () => ({}),
    useHarnessAccounts: () => ({ active: null, accounts: [] }),
    useHarnessStatus: () => ({}),
  },
});
mock.module('../src/harness/accounts.ts', { namedExports: { rowAccountInfo: () => ({}), accountName: () => 'account' } });
mock.module('../src/harness/usageWindows.ts', { namedExports: { usedNow: () => 0, resetWhen: () => null } });
// the context card's Compact now (its store action and the chat's capabilities) is the context panel tests' subject
mock.module('../src/components/context/useCompact.ts', {
  namedExports: { useCompact: () => ({ why: null, queued: false, compacting: false, label: 'Compact now', compact: () => {} }) },
});
mock.module('../src/session/voice.ts', { namedExports: { CONFIRM_VOICE_EVENT: 'voice' } });
mock.module('../src/harness/entries.ts', {
  namedExports: {
    statusRows: (x: any) => [
      ['Chat', x.chatId],
      ['Context', JSON.stringify(x.context)],
    ],
    voiceConfirmText: () => ({}),
  },
});
// the bug report's own stale-send cases are in tests/bugReportDialog.test.ts and tests/settings-dialogs.test.ts
mock.module('../src/components/dialogs/BugReportDialog.tsx', { namedExports: { BugReportDialog: () => null } });
const { Dialogs } = await import('../src/components/dialogs/Dialogs.tsx');
const { resetContextSnapshots } = await import('../src/session/useContextSnapshot.ts');
let root: any, host: HTMLElement;
async function mount(strict = false) {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(() => root.render(strict ? h(StrictMode, null, h(Dialogs)) : h(Dialogs)));
}
async function open(name: string, id: string | null) {
  await act(() => window.dispatchEvent(new window.CustomEvent(name, { detail: id })));
}
async function click(label: string) {
  const b = [...host.querySelectorAll('button')].find((x) => x.textContent === label);
  assert.ok(b);
  await act(() => b.click());
}
afterEach(async () => {
  if (root) await act(() => root.unmount());
  host?.remove();
  reads.clear();
  toasts.length = 0;
  ignored.length = 0;
  family = 'claude';
  nativeIdSuffix = '';
  usage = null;
  resetContextSnapshots();
});
test("an answer for one chat never overwrites another's, nor shows for a new one while it waits", async () => {
  await mount();
  await open('open-status', 'A');
  await open('open-status', 'B');
  await act(async () => reads.get('B')!.resolve({ totalTokens: 200, maxTokens: 1000 }));
  assert.match(host.textContent!, /"used":200/);
  await act(async () => reads.get('A')!.resolve({ totalTokens: 100, maxTokens: 1000 }));
  assert.match(host.textContent!, /"used":200/, 'B context must survive A response');
  // A's answer is A's: reopening A shows it without asking again
  const asked = reads.size;
  await open('open-status', 'A');
  assert.match(host.textContent!, /"used":100/);
  assert.equal(reads.size, asked);
  await open('open-status', 'C');
  assert.doesNotMatch(host.textContent!, /"used":/, 'C must not display another chat while its ask is pending');
});

test('a late answer after Status closed is kept for its chat; a failed ask is noted and the next open asks again', async () => {
  await mount();
  await open('open-status', 'A');
  const first = reads.get('A')!;
  await act(async () => first.reject(new Error('current')));
  assert.equal(ignored.length, 1);
  assert.equal(ignored[0][1].message, 'current');
  assert.match(host.textContent!, /ChatA/);
  await click('Close modal');
  await open('open-status', 'A');
  const second = reads.get('A')!;
  assert.notEqual(second, first);
  await click('Close modal');
  await act(async () => second.resolve({ totalTokens: 400, maxTokens: 1000 }));
  assert.equal(host.textContent, '');
  await open('open-status', 'A');
  assert.match(host.textContent!, /"used":400/);
});

test('a harness or native-session change shows only the new owner; a report stands in until its snapshot comes', async () => {
  await mount();
  await open('open-status', null);
  assert.equal(reads.size, 0);
  await open('open-status', 'A');
  const old = reads.get('A')!;
  await act(() => {
    family = 'codex';
    notify();
  });
  await act(async () => old.resolve({ totalTokens: 77, maxTokens: 100 }));
  assert.doesNotMatch(host.textContent!, /"used":77/);
  await act(() => {
    family = 'basic';
    notify();
  });
  assert.match(host.textContent!, /ChatA/);
  await act(() => {
    family = 'claude';
    nativeIdSuffix = '-new';
    usage = { modelContextWindow: 100, last: { totalTokens: 30 }, total: { totalTokens: 30 } };
    notify();
  });
  assert.match(host.textContent!, /"used":30/);
  await act(async () => reads.get('A-new')!.resolve({ totalTokens: 88, maxTokens: 100 }));
  assert.match(host.textContent!, /"used":88/);
});

test('Strict Mode asks once per owner', async () => {
  await mount(true);
  await open('open-status', 'A');
  const asked = reads.size;
  await act(async () => reads.get('A')!.resolve({ totalTokens: 9, maxTokens: 100 }));
  assert.match(host.textContent!, /"used":9/);
  assert.equal(reads.size, asked);
});

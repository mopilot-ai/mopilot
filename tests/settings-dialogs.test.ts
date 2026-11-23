import { test, mock } from 'node:test';
import assert from 'node:assert/strict';
import './support/dom.ts';
import { contextUsageKey } from '../src/store/contextUsage.ts';
import { emptySnapshot, withClaudeBreakdown } from '../shared/contextSnapshot.mjs';
import { createElement as h } from 'react';
import { installNativeStub } from './support/ports/native.ts';
import { stubStore } from './support/stubs.ts';

const calls: any[] = [];
let state: any = { runtime: {} };
const harness: Record<string, string> = {};
let newHarness = 'codex';
let control: any = async () => null;
let clock = 0;
const contextAsk = async (kind: string, owner: string, ...rest: unknown[]) => {
  calls.push(['context', kind, owner, ...rest]);
  const r = await control();
  if (!r) return r;
  // a reply with its categories is Claude Code's breakdown, as main reads it (shared/contextSnapshot.mjs)
  const base = { ...emptySnapshot(owner, ++clock), session: r.session ?? null };
  return withClaudeBreakdown(base, r, clock) ?? { ...base, used: r.totalTokens ?? null, window: r.maxTokens ?? null };
};
let copyError: unknown = null;
let status: any = {};
/** the harness's accounts (the active one new chats use) and the account each chat runs on */
const acct = (id: string, email: string | null, used: number) =>
  ({ id, email, plan: 'Max', usage: { windows: [{ label: '5h limit', usedPercent: used }], at: 1 } }) as any;
let pool: any = { active: null, accounts: [] };
let chatAccounts: Record<string, { id: string; pinned: boolean; serving: string }> = {};
let selection: any = { modelId: 'gpt-5', effort: 'high', model: { label: 'GPT-5' } };
stubStore({
  // a Claude chat's current segment, which the shared context reading (useChatContext) reads its harness and session from
  useStore: (f: any) =>
    f({
      segments: Object.fromEntries(
        Object.entries(harness)
          .filter(([, h]) => h === 'claude')
          .map(([id]) => [id, [{ harness: 'claude', nativeId: `native:${id}` }]]),
      ),
      ...state,
    }),
  toast: (...a: any[]) => calls.push(['toast', ...a]),
  toastFailure: (what: string) => (e: any) => calls.push(['toast', `${what}: ${e?.message ?? e}`, 'error']),
  chatFamily: (id: string) => harness[id] ?? 'codex',
  newChatHarness: () => newHarness,
  newChatFamily: () => newHarness,
  newChatBasic: () => (newHarness === 'acp' ? 'kimi' : null),
  chatHarnessLabel: (id: string) => (harness[id] === 'acp' ? 'Kimi Code' : harness[id] === 'claude' ? 'Claude Code' : 'Codex'),
  nativeOf: (id: string) => `native:${id}`,
});
installNativeStub({
  // main's context snapshots: an ask answers what `control` replies, as a snapshot for its owner
  context: {
    get: (owner: string) => contextAsk('get', owner),
    refresh: (owner: string, detail: string) => contextAsk('refresh', owner, detail),
    onSnapshot: () => () => {},
  },
  clipboard: {
    write: async (t: string) => {
      calls.push(['copy', t]);
      if (copyError) throw copyError;
    },
  },
});
const { chatAccountLabel, pinnedElsewhere } = await import('../src/harness/chatAccountLabel.ts');
mock.module('../src/session/harness/select.ts', {
  namedExports: {
    chatAccountLabel,
    pinnedElsewhere,
    useEffectiveSelection: () => selection,
    useHarnessStatus: () => status,
    useHarnessAccounts: () => pool,
    useChatAccount: (_h: string, id: string | null) => (id ? (chatAccounts[id] ?? null) : null),
  },
});
/** a basic chat's session: its config options name the model it runs on */
const sessions: Record<string, any> = {};
// the context card's memory files open through the shared opener
mock.module('../src/session/open.ts', { namedExports: { openFile: () => {} } });
mock.module('../src/store/session/useSession.ts', {
  namedExports: {
    flushSessionPatches: () => {},
    useSession: (id: string | null) => (id ? (sessions[id] ?? {}) : {}),
    useSessionField: (id: any, pick: any) => pick((((id: string | null) => (id ? (sessions[id] ?? {}) : {})) as (id: any) => any)(id)),
  },
});
mock.module('../src/session/harness/acp.ts', {
  namedExports: {
    acpModelName: (config: any) => config?.find((o: any) => o.category === 'model')?.currentValue ?? null,
    basicLabel: (id: string) => `${id[0].toUpperCase()}${id.slice(1)} Code`,
  },
});
// the context card's Compact now (its store action and the chat's capabilities) is the context panel tests' subject
mock.module('../src/components/context/useCompact.ts', {
  namedExports: { useCompact: () => ({ why: null, queued: false, compacting: false, label: 'Compact now', compact: () => {} }) },
});
mock.module('../src/session/voice.ts', { namedExports: { CONFIRM_VOICE_EVENT: 'confirm-voice' } });
// the sign-in itself is tested in tests/designLoginDialog.test.ts; here only that /design-login opens and closes it
mock.module('../src/components/dialogs/DesignLoginDialog.tsx', {
  namedExports: {
    OPEN_DESIGN_LOGIN: 'open-design-login',
    DesignLoginDialog: ({ threadId, onClose }: any) =>
      h('button', { className: 'design-login', onClick: onClose }, `design login ${threadId}`),
  },
});
// the dialog itself is tested in tests/bugReportDialog.test.ts; here only how the events open, replace and close it
const bugCloses: (() => void)[] = [];
mock.module('../src/components/dialogs/BugReportDialog.tsx', {
  namedExports: {
    BugReportDialog: ({ request, onClose }: any) => {
      bugCloses.push(onClose);
      return h('button', { className: 'bug-report', onClick: onClose }, `bug report ${request.threadId} ${request.kind ?? '-'}`);
    },
  },
});
mock.module('../src/components/dialogs/ChromeAllowDialog.tsx', { namedExports: { ChromeAllowDialog: () => null } });
const { createElement, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { Dialogs } = await import('../src/components/dialogs/Dialogs.tsx');
const { resetContextSnapshots } = await import('../src/session/useContextSnapshot.ts');

async function mount() {
  resetContextSnapshots();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(() => root.render(createElement(Dialogs)));
  return { host, root, unmount: () => act(() => root.unmount()) };
}
const fire = (name: string, detail?: any) =>
  act(() => {
    window.dispatchEvent(new CustomEvent(name, { detail }) as any);
  });
const button = (host: HTMLElement, text: string) =>
  [...host.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as HTMLButtonElement;
const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

test('nothing renders until a dialog event arrives', async () => {
  const { host, unmount } = await mount();
  assert.equal(host.innerHTML, '');
  await unmount();
});

test('/design-login opens the Claude Design sign-in for the chat, which closes itself', async () => {
  const { host, unmount } = await mount();
  await fire('open-design-login', 'c1');
  assert.equal(host.querySelector('.design-login')!.textContent, 'design login c1');
  await act(() => (host.querySelector('.design-login') as HTMLButtonElement).click());
  assert.equal(host.querySelector('.design-login'), null);
  // a new chat has no id
  await fire('open-design-login');
  assert.equal(host.querySelector('.design-login')!.textContent, 'design login null');
  await unmount();
});

test('the bug report opens for a chat and the kind it starts on; a second open replaces the first', async () => {
  const { host, unmount } = await mount();
  await fire('open-bug-report', { threadId: 'c1', kind: 'bad_result' });
  const first = host.querySelector('.bug-report') as HTMLButtonElement;
  assert.equal(first.textContent, 'bug report c1 bad_result');
  await fire('open-bug-report', { threadId: null });
  const second = host.querySelector('.bug-report') as HTMLButtonElement;
  assert.equal(second.textContent, 'bug report null -');
  assert.equal(host.querySelectorAll('.bug-report').length, 1);
  // the replaced dialog's close (a send it started ending later) leaves the new one open
  await act(() => bugCloses[0]());
  assert.ok(host.querySelector('.bug-report'));
  await act(() => second.click());
  assert.equal(host.querySelector('.bug-report'), null);
  // an event without a request opens one about no chat
  await fire('open-bug-report');
  assert.equal(host.querySelector('.bug-report')!.textContent, 'bug report null -');
  await unmount();
});

test('modal closes on Escape, backdrop click and the close button, but not inner clicks', async () => {
  const { host, unmount } = await mount();
  await fire('open-status', 'c1');
  await act(() => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'a' }) as any);
  });
  assert.ok(host.querySelector('.dialog'));
  await act(() => {
    window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }) as any);
  });
  assert.equal(host.querySelector('.dialog'), null);
  await fire('open-status', 'c1');
  await act(() => {
    host.querySelector('.dialog')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any);
  });
  assert.ok(host.querySelector('.dialog'));
  await act(() => {
    host.querySelector('.sketch-backdrop')!.dispatchEvent(new window.MouseEvent('mousedown', { bubbles: true }) as any);
  });
  assert.equal(host.querySelector('.dialog'), null);
  await fire('open-status', 'c1');
  await act(() => (host.querySelector('[aria-label=Close]') as HTMLElement).click());
  assert.equal(host.querySelector('.dialog'), null);
  await unmount();
});

const rows = (host: HTMLElement) =>
  Object.fromEntries([...host.querySelectorAll('.status-row')].map((r) => [r.children[0].textContent, r.children[1].textContent]));

test('status asks Claude for context use and lists account, limits and copies the chat ID', async () => {
  calls.length = 0;
  harness.c2 = 'claude';
  status = { email: 'me@x.com', usage: { windows: [{ label: '5h limit', usedPercent: 30 }] } };
  control = async () => ({ totalTokens: 500, maxTokens: 1000 });
  const { host, unmount } = await mount();
  await fire('open-status', 'c2');
  await flush();
  const r = rows(host);
  assert.equal(r['Chat ID'], 'c2');
  assert.equal(r.Model, 'GPT-5 · high');
  assert.equal(r.Account, 'me@x.com');
  assert.match(r.Context, /^50% used/);
  assert.equal(r['5h limit'], '70% left');
  assert.ok(host.querySelector('.status-row .mono'));
  assert.deepEqual(calls[0], ['context', 'refresh', JSON.stringify(['c2', 'claude', 'native:c2']), 'summary']);
  await act(async () => button(host, 'Copy chat ID').click());
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['copy', 'c2'],
    ['toast', 'Copied chat ID'],
  ]);
  // a copy that didn't reach the clipboard says so instead of confirming
  copyError = new Error('clipboard busy');
  await act(async () => button(host, 'Copy chat ID').click());
  await flush();
  assert.deepEqual(calls.slice(-2), [
    ['copy', 'c2'],
    ['toast', "Couldn't copy: clipboard busy", 'error'],
  ]);
  copyError = null;
  await act(() => (host.querySelector('[aria-label=Close]') as HTMLElement).click());
  assert.equal(host.querySelector('.status-grid'), null);
  await unmount();
});

test("the ring's context card opens for a chat only, replaces itself, and hands over to Status", async () => {
  calls.length = 0;
  harness.ctx = 'claude';
  control = async () => ({ totalTokens: 250, maxTokens: 1000, categories: [{ name: 'Messages', tokens: 250, kind: 'used' }] });
  const { host, unmount } = await mount();
  // a new chat has no context to show
  await fire('open-context');
  await fire('open-context', '');
  assert.equal(host.innerHTML, '');
  await fire('open-context', 'ctx');
  await flush();
  assert.equal(host.querySelector('.dialog-head')!.textContent, 'Context');
  assert.deepEqual(
    [...host.querySelectorAll('.ctx-cat .ctx-legend-label')].map((e) => e.textContent),
    ['Conversation', 'Free space'],
  );
  // a second open replaces the card rather than stacking another
  await fire('open-context', 'ctx');
  await flush();
  assert.equal(host.querySelectorAll('.ctx-card').length, 1);
  await act(async () => button(host, 'Chat details').click());
  await flush();
  assert.equal(host.querySelector('.ctx-card'), null);
  assert.equal(rows(host)['Chat ID'], 'ctx');
  await act(() => (host.querySelector('[aria-label=Close]') as HTMLElement).click());
  assert.equal(host.innerHTML, '');
  await unmount();
});

test("status shows the account the chat runs on, with that account's limits, not only the active one", async () => {
  status = { email: 'active@x.com', usage: { windows: [{ label: '5h limit', usedPercent: 10 }] } };
  pool = {
    active: acct('a', 'active@x.com', 10),
    accounts: [acct('a', 'active@x.com', 10), acct('b', 'other@x.com', 80), acct('c', null, 50)],
  };
  chatAccounts = {
    pinned: { id: 'b', pinned: true, serving: 'b' },
    onActive: { id: 'a', pinned: false, serving: 'a' },
    noEmail: { id: 'c', pinned: true, serving: 'c' },
    // pinned to B while B can't serve it: Status says both (design/multi-account rule 1)
    lapsed: { id: 'b', pinned: true, serving: 'a' },
  };
  control = async () => null;
  const { host, unmount } = await mount();
  const open = async (id: string) => {
    await fire('open-status', id);
    await flush();
    return rows(host);
  };
  let r = await open('pinned');
  assert.deepEqual([r.Account, r['5h limit']], ['other@x.com', '20% left']);
  await act(() => (host.querySelector('[aria-label=Close]') as HTMLElement).click());
  r = await open('onActive');
  assert.deepEqual([r.Account, r['5h limit']], ['active@x.com', '90% left']);
  await act(() => (host.querySelector('[aria-label=Close]') as HTMLElement).click());
  r = await open('noEmail');
  assert.deepEqual([r.Account, r['5h limit']], ['Max', '50% left']);
  await act(() => (host.querySelector('[aria-label=Close]') as HTMLElement).click());
  r = await open('lapsed');
  assert.deepEqual([r.Account, r['5h limit']], ['Pinned to other@x.com · now on active@x.com', '90% left']);
  await unmount();
  pool = { active: null, accounts: [] };
  chatAccounts = {};
});

test('status names an unverified CLI login as such, never by the email another app wrote', async () => {
  harness.cu = 'claude';
  status = { email: 'dz@x.com', usage: { windows: [{ label: '5h limit', usedPercent: 10 }] } };
  const doubted = { ...acct('default', 'dz@x.com', 10), unverified: true };
  pool = { active: doubted, accounts: [doubted, acct('b', 'b@x.com', 20)] };
  chatAccounts = { cu: { id: 'b', pinned: true, serving: 'default' } };
  control = async () => null;
  const { host, unmount } = await mount();
  await fire('open-status', 'cu');
  await flush();
  assert.equal(rows(host).Account, 'Pinned to b@x.com · now on Max');
  await act(() => (host.querySelector('[aria-label=Close]') as HTMLElement).click());
  chatAccounts = {};
  await fire('open-status', 'cu');
  await flush();
  assert.equal(rows(host).Account, 'Claude Code login');
  await unmount();
  pool = { active: null, accounts: [] };
});

test('status ignores incomplete or failed context replies and uses runtime token usage when present', async () => {
  harness.c3 = 'claude';
  status = { plan: 'Pro' };
  selection = { modelId: 'm1' };
  for (const reply of [
    async () => ({ totalTokens: null }),
    async () => ({ totalTokens: 1, maxTokens: 0 }),
    async () => null,
    async () => {
      throw new Error('x');
    },
  ]) {
    control = reply;
    const { host, unmount } = await mount();
    await fire('open-status', 'c3');
    await flush();
    assert.equal(rows(host).Context, '—');
    assert.equal(rows(host).Account, 'Pro');
    assert.equal(rows(host).Model, 'm1');
    await unmount();
  }
  calls.length = 0;
  state = {
    runtime: {
      c4: {
        tokenUsageOwner: contextUsageKey(undefined, 'c4'),
        tokenUsage: { modelContextWindow: 200, last: { totalTokens: 50 }, total: { totalTokens: 1234 } },
      },
      c5: { tokenUsageOwner: contextUsageKey(undefined, 'c5'), tokenUsage: { last: { totalTokens: 1 }, total: { totalTokens: 9 } } },
    },
  };
  let m = await mount();
  await fire('open-status', 'c4');
  assert.match(rows(m.host).Context, /^25% used/);
  assert.equal(rows(m.host)['Total tokens'], '1.2k');
  await m.unmount();
  m = await mount();
  await fire('open-status', 'c5');
  assert.equal(rows(m.host).Context, '—');
  await m.unmount();
  // a Codex chat is only asked what main holds, never read afresh
  assert.deepEqual(
    calls.filter((c) => c[0] === 'context').map((c) => c[1]),
    ['get', 'get'],
  );
  // a new chat has no ID to copy and nothing to ask
  status = {};
  selection = {};
  m = await mount();
  await fire('open-status');
  assert.equal(rows(m.host)['Chat ID'], 'New chat');
  assert.equal(rows(m.host).Account, undefined);
  assert.equal(button(m.host, 'Copy chat ID'), undefined);
  await m.unmount();
  state = { runtime: {} };
});

test("a basic chat's status names its own harness, model and context, with no Codex account, limits or Claude call", async () => {
  calls.length = 0;
  const id = 'acp:kimi:1';
  harness[id] = 'acp';
  harness.cx = 'codex';
  status = { email: 'codex@x.com', usage: { windows: [{ label: '5h limit', usedPercent: 30 }] } };
  pool = { active: acct('a', 'codex@x.com', 30), accounts: [acct('a', 'codex@x.com', 30)] };
  selection = { modelId: 'gpt-5', effort: 'high', model: { label: 'GPT-5' } };
  sessions[id] = { acp: { configOptions: [{ category: 'model', currentValue: 'K2' }] } };
  control = async () => null;
  let m = await mount();
  await fire('open-status', id);
  await flush();
  let r = rows(m.host);
  assert.deepEqual([r.Harness, r.Model, r.Account, r['5h limit'], r.Context], ['Kimi Code', 'K2', undefined, undefined, '—']);
  await m.unmount();
  // the harness's usage_update arrives as the chat's token usage
  state = {
    runtime: {
      [id]: {
        tokenUsageOwner: contextUsageKey(undefined, id),
        tokenUsage: { modelContextWindow: 1000, last: { totalTokens: 250 }, total: { totalTokens: 250 } },
      },
    },
  };
  sessions[id] = {};
  m = await mount();
  await fire('open-status', id);
  await flush();
  r = rows(m.host);
  assert.deepEqual([r.Model, r['Total tokens']], ['default', (250).toLocaleString()]);
  assert.match(r.Context, /^25% used/);
  await m.unmount();
  // a Codex chat without token usage yet waits for its turns instead of asking Claude Code
  state = { runtime: {} };
  m = await mount();
  await fire('open-status', 'cx');
  await flush();
  assert.equal(rows(m.host).Harness, 'Codex');
  await m.unmount();
  // a new chat on a picked basic harness
  newHarness = 'acp';
  m = await mount();
  await fire('open-status');
  assert.deepEqual([rows(m.host).Harness, rows(m.host)['Chat ID']], ['Kimi Code', 'New chat']);
  await m.unmount();
  newHarness = 'codex';
  // nothing on a basic or Codex chat is read afresh: their harnesses report token counts only
  assert.deepEqual(
    calls.filter((c) => c[0] === 'context' && c[1] === 'refresh'),
    [],
  );
  pool = { active: null, accounts: [] };
});

test("Status's total is main's session count when it has one, over this window's report", async () => {
  harness.c6 = 'claude';
  state = {
    runtime: {
      c6: {
        tokenUsageOwner: JSON.stringify(['c6', 'claude', 'native:c6']),
        tokenUsage: { modelContextWindow: 1000, last: { totalTokens: 50 }, total: { totalTokens: 70 } },
      },
    },
  };
  control = async () => ({ totalTokens: 100, maxTokens: 1000, session: { totalTokens: 4321 } });
  const m = await mount();
  await fire('open-status', 'c6');
  await flush();
  assert.equal(rows(m.host)['Total tokens'], '4.3k');
  assert.match(rows(m.host).Context, /^10% used/);
  await m.unmount();
  state = { runtime: {} };
});

test('the obsolete cross-harness voice event cannot open a routing confirmation', async () => {
  const { host, unmount } = await mount();
  try {
    await fire('confirm-voice', { resolve: () => assert.fail('obsolete voice event must not resolve a routing action') });
    assert.equal(host.querySelector('[role=alertdialog]'), null);
  } finally {
    await unmount();
  }
});

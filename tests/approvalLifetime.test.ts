// Actual renderer teardown, SessionState card synchronization and reply routing across native segment switches.
import { after, mock, test } from 'node:test';
import assert from 'node:assert/strict';
import { fx, reset, storeSet } from './support/harness-logic-fakes.ts';
import { stubSlice } from './support/stubs.ts';
import { installFakeRuntime } from './support/ports/runtime.ts';

stubSlice('src/store/core.ts', {
  get: () => fx.state,
  set: storeSet,
  patchRuntime: () => {},
  upsertThread: () => {},
  touchChat: () => {},
  patchTurn: () => {},
  patchItem: () => {},
  patchStreamedItem: () => {},
  toast: () => {},
});
stubSlice('src/store/chats.ts', {
  suggestOtherHarness: () => {},
  chatFamily: () => 'claude',
  nativeOf: (id: string) => id,
  chatOf: (id: string) => id,
  noteReportedWindow: () => {},
  usageHarnessOf: () => 'claude',
});
stubSlice('src/store/connection.ts', { loadThreads: async () => {}, refreshAccount: async () => {}, refreshRateLimits: async () => {} });
stubSlice('src/store/projects.ts', { syncCodexProjects: async () => {} });
stubSlice('src/store/actions.ts', { setGoalState: async () => false });
const codexReplies: any[] = [];
mock.module('../src/harness/adapters/codex.ts', {
  namedExports: { respondToCodex: async (...args: any[]) => void codexReplies.push(args) },
});
const realInterval = globalThis.setInterval;
globalThis.setInterval = (() => ({ unref() {} })) as any;
after(() => void (globalThis.setInterval = realInterval));
const { startClaude, resolveClaudeRequest } = await import('../src/session/harness/claude.ts');
const { startAcp, resolveAcpRequest } = await import('../src/session/harness/acp.ts');
// the real notifications slice (the kit stubs it for the harness modules): a copy of its own, under another URL
const realNotifications = new URL('../src/store/notifications.ts?real', import.meta.url).href;
const { syncPending, resolveRequest }: typeof import('../src/store/notifications.ts') = await import(realNotifications);
// resolveRequest reaches Claude Code's and ACP's real answers through the runtime main installs
installFakeRuntime({ resolveClaudeRequest, resolveAcpRequest });

test('old Claude and ACP exits cannot erase replacement cards or send their replies to Codex', () => {
  reset();
  const replies: any[] = [];
  let claudeEvent!: (e: any) => void;
  let acpEvent!: (e: any) => void;
  fx.native.claude = {
    onEvent: (h: any) => (claudeEvent = h),
    onAccountsEvent: () => {},
    onCatalog: () => {},
    accounts: async () => ({ active: 'default', accounts: [] }),
    detect: async () => ({ state: 'signin', bin: null }),
    presence: async () => ({}),
    permission: async (...args: any[]) => void replies.push(['claude', ...args]),
  };
  fx.native.acp = {
    onEvent: (h: any) => (acpEvent = h),
    onHarnesses: () => {},
    harnesses: async () => [],
    onSignIns: () => {},
    signIns: async () => ({}),
    list: async () => [],
    permission: async (...args: any[]) => void replies.push(['acp', ...args]),
  };
  startClaude();
  // startAcp listens for the window regaining focus (a harness installed meanwhile)
  (globalThis as any).window ??= new EventTarget();
  startAcp();
  for (const kind of ['claude', 'acp:kimi']) {
    const chat = `mixed-${kind}`;
    const old = `${kind}:old`,
      next = `${kind}:new`;
    fx.state.segments[chat] = [
      { kind, nativeId: old },
      { kind, nativeId: next },
    ];
    fx.state.threads[chat] = { id: chat, cwd: '/w', status: { type: 'running' } };
    const id = kind === 'claude' ? 'cperm-new' : 'acpperm-new';
    const approvals = [
      { id, method: kind === 'claude' ? 'claude/permission' : 'acp/permission', params: { toolName: 'Bash', input: { command: 'ls' } } },
    ];
    // Main removes the old card and publishes this surviving array before relaying the exit.
    const snapshot = { sessions: { [chat]: { approvals } } };
    syncPending(snapshot);
    const event = kind === 'claude' ? claudeEvent : acpEvent;
    event({ kind: 'closed', key: old });
    // A task-only patch uses the same array; it must not be needed to repair routing.
    syncPending(snapshot);
    assert.equal(fx.state.pending.find((p: any) => p.id === id)?.id, id);
    if (kind === 'claude') {
      event({ kind: 'error', key: old, error: 'old worker failed' });
      assert.equal(fx.state.pending.find((p: any) => p.id === id)?.id, id);
    }
    resolveRequest(id, kind === 'claude' ? { decision: 'accept' } : { optionId: 'allow' });
    assert.equal(replies.at(-1)[0], kind === 'claude' ? 'claude' : 'acp');
    assert.equal(replies.at(-1)[1], id);
    assert.equal(
      fx.state.pending.some((p: any) => p.id === id),
      false,
    );
  }
  assert.deepEqual(codexReplies, []);
});

// The goal pill row's test fixture: a goal in a fake session, the store's goal actions recorded (and failable), and a
// mounted ComposerPills with helpers to open the card and drive its controls and editor.
import { window } from './dom.ts';
import type { ChatGoal } from '../../src/store/types.ts';
import { EMPTY_SESSION, type SessionState } from '../../src/store/session/sessionState.ts';
import { mockSource, stubStore } from './stubs.ts';
import { installNativeStub } from './ports/native.ts';

export const original: ChatGoal = {
  threadId: 'native-1',
  objective: 'Ship the beta',
  status: 'paused',
  tokenBudget: 200000,
  tokensUsed: 1500,
  timeUsedSeconds: 3,
  createdAt: 1,
  updatedAt: 1,
};
export const fixture = {
  goal: { ...original },
  calls: [] as unknown[][],
  notices: [] as string[],
  edit: async (_id: string, _objective: string): Promise<boolean> => true,
  request: async (_method: string, _params: unknown): Promise<unknown> => ({ goal: { ...original, objective: 'Updated' } }),
};
export const f = fixture;
const nop = () => {};
/** A goal button's action: recorded, and rejected with `fails` when set. */
let fails: Error | null = null;
/** Make the next goal button actions reject with `error` (null: succeed). */
export const failWith = (error: Error | null) => {
  fails = error;
};
const act2 = async (what: string, id: string) => {
  f.calls.push([what, id]);
  if (fails) throw fails;
};
export const claudeCalls: unknown[][] = [];
mockSource('src/session/harness/claude.ts', {
  claudeClearGoal: (...a: unknown[]) => claudeCalls.push(['clear', ...a]),
  claudeExtendGoal: (...a: unknown[]) => claudeCalls.push(['extend', ...a]),
  claudePauseGoal: (...a: unknown[]) => claudeCalls.push(['pause', ...a]),
  claudeResumeGoal: (...a: unknown[]) => claudeCalls.push(['resume', ...a]),
  claudeFork: nop,
  claudeRename: nop,
});
mockSource('src/harness/adapters/proxy.ts', { chatProxy: {} });
stubStore({
  inheritCodexPin: async () => {},
  editGoal: (id: string, text: string) => {
    f.calls.push(['edit', id, text]);
    return f.edit(id, text);
  },
  toast: (text: string) => f.notices.push(text),
  toastFailure: (what: string) => (e: any) => f.notices.push(`${what}: ${e?.message ?? e}`),
  pauseGoal: (id: string) => act2('pause', id),
  resumeGoal: (id: string) => act2('resume', id),
  clearGoal: (id: string) => act2('clear', id),
  extendGoal: (id: string) => act2('extend', id),
  setGoalBudget: nop,
  nativeOf: () => 'native-1',
  loadGoal: async () => {},
  withLease: (id: string, method: string, params: unknown) => {
    f.calls.push(['request', id, method, params]);
    return f.request(method, params);
  },
  setGoalState: (id: string, goal: any) => {
    f.calls.push(['state', id, goal]);
    f.goal = goal;
  },
  getState: () => ({ runtime: {} }),
  copyChatConfig: nop,
  navigate: nop,
  revertThread: nop,
  editClaudeMessage: nop,
  upsertThread: nop,
});
const snapshots = new Map<string, SessionState>();
installNativeStub({ session: { snapshot: async (chatId: string) => snapshots.get(chatId) ?? null } });
mockSource('src/harness/adapters/codex.ts', { codexRequest: nop });
mockSource('src/harness/adapters/codexApi.ts', { codexApi: {} });
export const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { refreshSession, useSessions } = await import('../../src/store/session/useSession.ts');
export const { goalCardSummary, goalPillView } = await import('../../src/components/thread/GoalBar.tsx');
const { ComposerPills } = await import('../../src/components/thread/ComposerPills.tsx');
export const { CODEX_HANDLERS } = await import('../../src/session/harness/adapters/codexSemantics.ts');
export const { CLAUDE_HANDLERS } = await import('../../src/session/harness/adapters/claudeSemantics.ts');

export function setGoalSnapshot(chatId: string, goal: ChatGoal | null) {
  snapshots.set(chatId, { ...EMPTY_SESSION, rev: 1, goal });
  return refreshSession(chatId);
}

export function resetGoalSessions() {
  snapshots.clear();
  useSessions.setState({ sessions: {}, loaded: {} });
}

export async function mount(t: any, goal: ChatGoal | null = { ...original }, opts: { showGoal?: boolean } = {}) {
  // an earlier mount's card closes (Escape closes every open popover), so `card()` is this mount's
  await act(async () => {
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }) as any);
  });
  fixture.goal = goal as ChatGoal;
  fixture.calls = [];
  fixture.notices = [];
  fixture.edit = async () => true;
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host as any);
  const render = (threadId = 'chat-1') =>
    act(async () => {
      await setGoalSnapshot(threadId, f.goal);
      root.render(
        createElement(ComposerPills, {
          key: threadId,
          threadId,
          showGoal: opts.showGoal ?? true,
        }),
      );
    });
  await act(resetGoalSessions);
  await render();
  t.after(async () => {
    await act(() => root.unmount());
    host.remove();
  });
  const pill = () => host.querySelector<HTMLButtonElement>('.goal-pill')!;
  const card = () => document.querySelector<HTMLElement>('.goal-card');
  const open = async () => {
    await act(async () => {
      if (!card()) pill().click();
    });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  };
  const button = (label: string) =>
    [...(card()?.querySelectorAll('button') ?? [])].find((b) => b.textContent === label || b.getAttribute('aria-label') === label)!;
  const click = (label: string) =>
    act(async () => {
      button(label).click();
    });
  const controls = () => [...card()!.querySelectorAll('.goal-actions button')].map((b) => b.getAttribute('aria-label'));
  const input = () => card()?.querySelector('textarea') ?? null;
  const change = (text: string) =>
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')!.set!.call(input(), text);
      input()!.dispatchEvent(new window.Event('input', { bubbles: true }) as any);
    });
  const key = (key: string, extra = {}, target: EventTarget = input()!) =>
    act(async () => {
      target.dispatchEvent(new window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...extra }) as any);
    });
  const editObjective = async () => {
    await open();
    await click('Edit goal');
  };
  return { host, render, pill, card, open, button, click, controls, input, change, key, editObjective };
}

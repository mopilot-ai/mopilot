// The hand-off strip's and the browser tab mentions' shared test setup: a mocked store whose state the test sets, the
// native bridge's recorded calls, and the narration and components under test, loaded after the mocks.
import { afterEach } from 'node:test';
import { createRequire } from 'node:module';
import { useSyncExternalStore } from 'react';
import { native, mockStore, autoMock, stubComponent } from './thread-kit.ts';
import { iconStubs, mockSource, taggedIcon } from './stubs.ts';

export const fixture: any = {
  state: {},
  listeners: new Set<Function>(),
  calls: [] as any[],
  subscribe(fn: Function) {
    fixture.listeners.add(fn);
    return () => fixture.listeners.delete(fn);
  },
  update(patch: any) {
    fixture.state = { ...fixture.state, ...patch };
    for (const fn of fixture.listeners) fn();
  },
};
const record =
  (name: string) =>
  (...a: any[]) => {
    fixture.calls.push([name, ...a]);
  };
// the store the components read: the fixture's state, its chat ids and the recorded actions
mockStore({
  useStore: Object.assign((s: any) => s(useSyncExternalStore(fixture.subscribe, () => fixture.state)), { getState: () => fixture.state }),
  chatOf: (id: string) => fixture.chatOf?.[id] ?? id,
  sendMessage: async (...a: any[]) => {
    record('sendMessage')(...a);
    if (fixture.sendFails) throw fixture.sendFails;
    return fixture.sent ?? true;
  },
  toastFailure: (what: string) => (e: Error) => fixture.calls.push(['failed', what, e.message]),
  openAgentBrowserTab: record('openAgentBrowserTab'),
  // whether opening the tab would show anything: the pane state the strip read, and the tab it asks about
  agentBrowserTabOpens: (pane: any, key: string, opts: any) => {
    fixture.paneAsked = [pane, key, opts];
    return fixture.tabInFront !== true;
  },
  navigate: (...a: any[]) => fixture.thread?.navigate?.(...a) ?? null,
});
// ThreadView: only linkify runs; the view's heavier parts are stand-ins
autoMock('src/components/thread/Approvals.tsx', 'approvals', { Approvals: stubComponent('Approvals'), useSageApprovals: () => [] });
autoMock('src/components/thread/HarnessDownNotice.tsx', 'harnessDown', {
  HarnessDownNotice: stubComponent('HarnessDownNotice'),
  useDownHarness: () => null,
});
for (const [rel, name] of [
  ['src/components/composer/Composer.tsx', 'Composer'],
  ['src/components/thread/ElsewhereNotice.tsx', 'ElsewhereNotice'],
  ['src/components/browser/ClaudeInChromeNote.tsx', 'ClaudeInChromeNote'],
  ['src/components/thread/SelectionToolbar.tsx', 'SelectionToolbar'],
  ['src/components/composer/SelectionChip.tsx', 'SelectionChip'],
  ['src/components/markdown/SkillLink.tsx', 'SkillLink'],
  ['src/components/thread/AsyncQuestions.tsx', 'AsyncQuestions'],
])
  autoMock(rel, name, { [name]: stubComponent(name) });
native.shell = {
  openExternal: async (u: string) => {
    fixture.calls.push(['openExternal', u]);
  },
};
native.browser.signinDone = async (...a: any[]) => {
  fixture.calls.push(['signinDone', ...a]);
  if (fixture.signinFails) throw fixture.signinFails;
  return fixture.signinOk ?? true;
};
// every icon renders as a tagged stand-in
mockSource('src/components/ui/icons.tsx', iconStubs(taggedIcon));

const react = await import('react');
export const { act, createElement } = react;
export const { createRoot } = await import('react-dom/client');
export const { renderToStaticMarkup } = await import('react-dom/server');
export const { controlHandoff, controlSource, controlStep, latestHandoff, browserTabsSeen } = await import(
  '../../src/lib/agentNarration.ts'
);
export const { chatAgentTabs } = await import('../../src/lib/agentTabs.ts');
export const { browserTabOptions, useBrowserTabMentions, BrowserTabRows } = await import(
  '../../src/components/composer/BrowserTabMentions.tsx'
);
export const { HandoffStrip, handoffPlace, resumePrompt } = await import('../../src/components/thread/HandoffStrip.tsx');
export const { linkify } = await import('../../src/components/thread/ThreadView.tsx');
const require = createRequire(import.meta.url);
export const { buildInput, CodexAdapter, CODEX_API } = require('../../electron/harness/codex.cjs');
export const { buildClaudeMessage } = require('../../electron/harness/claude/message.cjs');
export const { acpBlocks } = require('../../electron/harness/acpTurns.cjs');

let root: ReturnType<typeof createRoot> | null = null;
let container: HTMLElement;
export async function render(el: any) {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(el));
  return container;
}
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  container?.remove();
  fixture.calls = [];
  fixture.chatOf = undefined;
  fixture.signinOk = undefined;
  fixture.tabInFront = undefined;
  fixture.paneAsked = undefined;
});

let seq = 0;
export const call = (tool: string, args: any = {}, text = '', server = 'sage') => ({
  id: `i${++seq}`,
  type: 'mcpToolCall',
  server,
  tool,
  arguments: args,
  status: 'completed',
  result: { content: text ? [{ type: 'text', text }] : [] },
});
export const chrome = (tool: string, args: any = {}, text = '') => call(`mcp__claude-in-chrome__${tool}`, args, text);
export const js = (code: unknown, text = '', title?: string) => call('js', { code, title }, text, 'cua_repl');

export const view = (tabId: string, tabKey: string | null, o: any = {}) => ({
  tabId,
  tabKey,
  kind: 'tab',
  active: false,
  created: false,
  mark: null,
  takenOver: false,
  origin: null,
  access: null,
  ...o,
});
export const turnOf = (...items: any[]) => ({ runtime: { chat: { turns: [{ items: [] }, { items }] } } });

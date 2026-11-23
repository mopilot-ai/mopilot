// This window's answers to main's pane tools (electron/capabilities/tools/paneTools.cjs): the chat that asked must be the
// one whose side pane this is (on screen, and the focused pane in split view); then it shows, closes or opens a terminal
// in that pane, and the reply says what it did. Main has checked the path and folder; a request names no other chat.

import { chatOf } from './chats';
import { get as getState, set as setState } from './core';
import { closePaneTab, openAgentBrowserTab, openChanges, openPaneTab } from './panes';
import type { PaneTab } from './state';
import { focusedChat, visibleChats } from './split';
import { frontTab, inView, viewChats } from '../lib/agentTabs';
import { basename } from '../lib/paths';
import { terminalTitle } from '../lib/platform';
import { classifyClaudeUrl } from '../../shared/claudeArtifacts.mjs';
import { openArtifactTab } from './artifactPanes';

export type PaneName = 'diff' | 'file' | 'terminal' | 'tasks' | 'preview' | 'artifact';
export type PaneRequest = {
  op: 'show_pane' | 'close_pane' | 'open_terminal' | 'close_terminal';
  caller: string;
  pane: PaneName;
  path?: string;
  line?: number;
  scope?: string;
  tabId?: string;
  cwd?: string;
  /** artifact: the claude.ai page to show */
  url?: string;
};
export type PaneReply = { outcome: string; tab_id?: string };

/** The tab kinds each pane name covers in this app's side pane. */
const KINDS: Record<PaneName, PaneTab['kind'][]> = {
  diff: ['changes'],
  file: ['file', 'files'],
  terminal: ['terminal'],
  tasks: ['tasks'],
  preview: ['browser'],
  artifact: ['artifact'],
};
const OPS = new Set(['show_pane', 'close_pane', 'open_terminal', 'close_terminal']);
const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

/** Whether `raw` is one of the pane tools' requests (the window tools share the channel, src/lib/windowLayout.ts). */
export const isPaneRequest = (raw: unknown) => !!raw && typeof raw === 'object' && OPS.has((raw as { op?: string }).op ?? '');

/** The request as main sends it, or null for anything else. */
export function paneRequest(raw: unknown): PaneRequest | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !OPS.has(r.op as string) || !str(r.caller)) return null;
  const pane = (r.op === 'open_terminal' || r.op === 'close_terminal' ? 'terminal' : r.pane) as PaneName;
  if (!Object.hasOwn(KINDS, pane)) return null;
  if (r.op === 'open_terminal' && !str(r.cwd)) return null;
  if (r.op === 'close_terminal' && !str(r.tabId)) return null;
  if (r.op === 'show_pane' && pane === 'file' && !str(r.path)) return null;
  if (r.op === 'show_pane' && pane === 'artifact' && !classifyClaudeUrl(r.url)) return null;
  return {
    op: r.op as PaneRequest['op'],
    caller: r.caller as string,
    pane,
    ...(str(r.path) ? { path: r.path as string } : {}),
    ...(Number.isInteger(r.line) && (r.line as number) > 0 ? { line: r.line as number } : {}),
    ...(str(r.scope) ? { scope: r.scope as string } : {}),
    ...(str(r.tabId) ? { tabId: r.tabId as string } : {}),
    ...(str(r.cwd) ? { cwd: r.cwd as string } : {}),
    ...(str(r.url) ? { url: r.url as string } : {}),
  };
}

/** What this window does with a pane request, and the outcome it reports. */
export function answerPane(raw: unknown): PaneReply {
  const req = paneRequest(raw);
  if (!req) return { outcome: 'invalid' };
  const s = getState();
  if (!visibleChats(s).includes(req.caller)) return { outcome: 'not_on_screen' };
  // the side pane is the focused pane's chat's (and the side chats in it): another session's pane is never changed
  const chats = viewChats(focusedChat(s), s.paneTabs);
  if (!chats.has(req.caller) && !chats.has(chatOf(req.caller))) return { outcome: 'not_focused' };
  const mine = (t: PaneTab) => KINDS[req.pane].includes(t.kind) && inView(t, chats, chatOf);
  const open = (id: string) => setState({ paneActive: id, diffPanel: { ...getState().diffPanel, open: true } });
  if (req.op === 'close_pane') {
    const front = s.paneTabs.find((t) => t.id === frontTab(s.paneTabs, s.paneActive, chats, chatOf));
    if (!s.diffPanel.open || !front || !mine(front)) return { outcome: 'not_open' };
    setState({ diffPanel: { ...s.diffPanel, open: false } });
    return { outcome: 'closed' };
  }
  if (req.op === 'close_terminal') {
    // only a terminal tab of this chat's own view; closing it ends its shell
    const tab = s.paneTabs.find((t) => t.id === req.tabId && mine(t));
    if (!tab) return { outcome: 'no_tab' };
    closePaneTab(tab.id);
    return { outcome: 'closed', tab_id: tab.id };
  }
  if (req.op === 'open_terminal') {
    const cwd = req.cwd as string;
    openPaneTab('terminal', { cwd, title: terminalTitle(cwd) });
    return { outcome: 'opened', tab_id: getState().paneActive };
  }
  switch (req.pane) {
    case 'diff':
      openChanges({ scope: req.scope ?? 'branch', ...(req.path ? { file: req.path } : {}) });
      return { outcome: 'shown' };
    case 'file': {
      const path = req.path as string;
      openPaneTab('file', { path, ...(req.line ? { line: req.line } : {}), cwd: s.threads[req.caller]?.cwd, title: basename(path) });
      return { outcome: 'shown' };
    }
    case 'tasks':
      openPaneTab('tasks', { threadId: req.caller, views: [] });
      return { outcome: 'shown' };
    case 'artifact':
      // the caller's own tab for the page (main and paneRequest checked the link)
      openArtifactTab({ url: req.url as string }, chatOf(req.caller));
      return { outcome: 'shown' };
    case 'terminal': {
      const tabs = s.paneTabs.filter(mine);
      const tab = req.tabId ? tabs.find((t) => t.id === req.tabId) : (tabs.find((t) => t.id === s.paneActive) ?? tabs.at(-1));
      if (!tab) return { outcome: req.tabId && tabs.length ? 'no_tab' : 'no_terminal' };
      open(tab.id);
      return { outcome: 'shown' };
    }
    case 'preview': {
      // the caller's own agent tabs (a switched chat's segments included), by their browser_* tab id
      const tabs = s.paneTabs.filter((t) => t.kind === 'browser' && !!t.agentChat && chatOf(t.agentChat) === chatOf(req.caller));
      const tab = req.tabId ? tabs.find((t) => t.agentTab === req.tabId) : (tabs.find((t) => t.id === s.paneActive) ?? tabs.at(-1));
      if (!tab) return { outcome: req.tabId && tabs.length ? 'no_tab' : 'no_page' };
      openAgentBrowserTab(tab.agentChat as string, { tabKey: tab.agentTab ?? null });
      return { outcome: 'shown' };
    }
  }
}

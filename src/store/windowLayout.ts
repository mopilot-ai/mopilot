// This window's answers to main's window tools (electron/capabilities/tools/windowTools.cjs): the chat that asked must be
// on screen here; the change is one split view op (or a navigation) on the layout as it is now, and the reply says what
// it did. An agent's pane is opened beside the others and never takes the focus; it closes only panes it opened.

import { applySplitOp, splitRoomNow } from './splitView';
import { get as getState } from './core';
import { navigate } from './panes';
import { showPanel } from './shellPanels';
import { panelShown } from '../lib/shellFit';
import { MAX_SPLIT_PANES, focusedChat, primaryChat, visibleChats } from './split';
import { native } from '../lib/native';
import { answerPane, isPaneRequest } from './windowPanes';
import type { LayoutDescription, LayoutReply } from '../lib/native/layout';

export type LayoutRequest = {
  op: 'split' | 'focus' | 'close' | 'layout' | 'sidebar';
  caller: string;
  chatId: string | null;
  collapsed?: boolean;
};

const OPS = new Set(['split', 'focus', 'close', 'layout', 'sidebar']);

/** The request as main sends it, or null for anything else (a reply is still sent, so main doesn't wait out its time). */
export function layoutRequest(raw: unknown): LayoutRequest | null {
  const r = raw as Partial<LayoutRequest> | null;
  if (!r || typeof r !== 'object' || !OPS.has(r.op as string) || typeof r.caller !== 'string' || !r.caller) return null;
  // no chat (close's most recent pane, the layout): null or left out
  if (r.chatId !== undefined && r.chatId !== null && typeof r.chatId !== 'string') return null;
  if ((r.op === 'split' || r.op === 'focus') && !r.chatId) return null;
  if (r.op === 'sidebar' && typeof r.collapsed !== 'boolean') return null;
  return {
    op: r.op as LayoutRequest['op'],
    caller: r.caller,
    chatId: r.chatId ?? null,
    ...(r.op === 'sidebar' ? { collapsed: r.collapsed } : {}),
  };
}

/** Whether the user is typing: a text field or the terminal has the keyboard (then "focus" doesn't move the main pane). */
export function userTyping(active: Element | null = document.activeElement): boolean {
  return !!active?.closest('input, textarea, [contenteditable="true"], .term-view');
}

/** The window's layout as the tools describe it to the model, from the asking chat's side. */
export function describeLayout(caller: string): LayoutDescription {
  const s = getState();
  const primary = primaryChat(s);
  const focus = focusedChat(s);
  return {
    main: primary ? { session_id: primary } : { page: s.route.name },
    panes: s.split.panes.map((p) => ({ session_id: p.chatId, focused: p.chatId === focus, opened_by_you: p.openedBy === caller })),
    focused: s.split.focus === 'primary' ? 'main' : s.split.focus,
  };
}

/** What this window does with a layout request, and the outcome it reports. */
export function answerLayout(raw: unknown, typing: () => boolean = userTyping): LayoutReply {
  const req = layoutRequest(raw);
  if (!req) return { outcome: 'invalid' };
  const s = getState();
  // the chat that asked must be one this window shows; otherwise it changes nothing here
  if (!visibleChats(s).includes(req.caller)) return { outcome: 'not_on_screen' };
  switch (req.op) {
    case 'layout':
      return { outcome: 'layout', layout: describeLayout(req.caller) };
    case 'sidebar':
      if (panelShown(s, 'sidebar') === !req.collapsed) return { outcome: 'unchanged' };
      showPanel('sidebar', !req.collapsed);
      return { outcome: req.collapsed ? 'collapsed' : 'expanded' };
    case 'split': {
      const chatId = req.chatId as string;
      if (visibleChats(s).includes(chatId)) return { outcome: 'visible' };
      if (s.split.panes.length >= MAX_SPLIT_PANES) return { outcome: 'full' };
      if (s.split.panes.length >= splitRoomNow()) return { outcome: 'no_room' };
      return { outcome: applySplitOp({ op: 'open', chatId, by: req.caller }) };
    }
    case 'focus': {
      const chatId = req.chatId as string;
      // on screen already (the main pane or a split pane): nothing moves, the user's focus included
      if (visibleChats(s).includes(chatId)) return { outcome: 'visible' };
      if (typing()) return { outcome: 'busy' };
      navigate({ name: 'thread', id: chatId });
      return { outcome: 'focused' };
    }
    case 'close': {
      // the pane named, or the most recent (rightmost) one this chat opened
      const chatId = req.chatId ?? s.split.panes.findLast((p) => p.openedBy === req.caller)?.chatId;
      if (!chatId) return { outcome: 'missing' };
      return { outcome: applySplitOp({ op: 'close', chatId, by: req.caller }) };
    }
  }
}

/** Answers main's window tools, and its pane tools on the same channel (src/lib/windowPanes.ts), for as long as this window runs. */
export function startWindowLayout(): () => void {
  return native.layout.onRequest((id, req) => native.layout.reply(id, isPaneRequest(req) ? answerPane(req) : answerLayout(req)));
}

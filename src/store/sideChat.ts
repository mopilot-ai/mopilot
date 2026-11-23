// Side chats: opening a temporary conversation in the side pane, on the machine that owns its parent chat.

import type { Attachment, Thread } from './types';
import type { ThreadForkParams } from '../protocol/v2/ThreadForkParams';
import type { PaneTab } from './state';
import type { HarnessFamily } from '../harness/family';
import { errorText } from '../lib/ignored';
import type { openHostSideChat } from './hostSideChat';

type Draft = { text: string; attachments: Attachment[] };

function isBlankTab(tab: PaneTab | undefined): boolean {
  return !!tab && tab.kind === 'browser' && !tab.url && !tab.agentChat;
}

/** Keep the tab's identity and position, discarding browser-only fields on conversion. */
export function replaceBlankPaneTab(tabs: PaneTab[], kind: PaneTab['kind'], extra: Partial<PaneTab>, tabId: string): PaneTab[] | undefined {
  if (!isBlankTab(tabs.find((t) => t.id === tabId))) return;
  return tabs.map((t) => (t.id === tabId ? { ...extra, id: t.id, kind } : t));
}

interface SideChatActions {
  nativeOf(chatId: string): string;
  familyOf(nativeId: string): HarnessFamily;
  openHostSideChat?: typeof openHostSideChat;
  openClaudeSideChat(chatId: string, nativeId: string, selection?: string, replaceTabId?: string): string | Promise<string>;
  fork(params: ThreadForkParams, hold: boolean): Promise<{ thread: Thread }>;
  /** put a Codex fork on the account its parent chat is pinned to */
  inheritAccount(chatId: string, threadId: string): Promise<void>;
  addThread(thread: Thread): void;
  setDraft(threadId: string, draft: Draft): void;
  selectionAttachment(text: string): Attachment;
  hold(threadId: string): void;
  markLoaded(threadId: string): void;
  getPaneTabs(chatId: string): PaneTab[];
  getWindowTabs?(): PaneTab[];
  getPaneActive(): string;
  canReuse?(threadId: string): boolean;
  getDraft(threadId: string): Draft | undefined;
  addSelection(threadId: string, text: string): boolean | 'refused';
  focusPane(tabId: string, threadId: string, sourceChatId: string): void;
  openPane(threadId: string, sourceChatId: string, replaceTabId?: string): void;
  toast(text: string, level: 'error'): void;
}

type Opener = (chatId: string, threadId: string, selection?: string, replaceTabId?: string) => string | Promise<string>;

/** Open a temporary fork; initialize its draft and live state before mounting the pane. */
export function createSideChat(actions: SideChatActions) {
  const opening = new Map<string, Promise<string | undefined>>();
  const replaceable = (chatId: string, tabId: string) =>
    isBlankTab((actions.getWindowTabs?.() ?? actions.getPaneTabs(chatId)).find((tab) => tab.id === tabId));
  async function codexSideChat(chatId: string, threadId: string, selection?: string, replaceTabId?: string) {
    // Codex rejects deferGoalContinuation with ephemeral: temporary forks cannot carry goals.
    const { thread } = await actions.fork({ threadId, excludeTurns: true, ephemeral: true }, true);
    actions.addThread({ ...thread, turns: [] });
    // the side chat runs on the account the user put the chat on; if that can't be kept, it is said
    await actions
      .inheritAccount(chatId, thread.id)
      .catch((e: unknown) =>
        actions.toast(`The side chat couldn't keep this chat's account (${errorText(e)}); it uses the pool's`, 'error'),
      );
    if (selection) actions.setDraft(thread.id, { text: '', attachments: [actions.selectionAttachment(selection)] });
    actions.hold(thread.id);
    actions.markLoaded(thread.id);
    actions.openPane(thread.id, chatId, replaceTabId);
    return thread.id;
  }
  /** How each harness opens a side chat; null: it has no temporary fork, and the user is told so. */
  const OPENER: Record<HarnessFamily, Opener | null> = {
    codex: codexSideChat,
    claude: (...args) => actions.openClaudeSideChat(...args),
    acp: null,
  };
  async function forkChat(chatId: string, threadId: string, selection?: string, replaceTabId?: string) {
    try {
      return await openOnOwner(chatId, threadId, selection, replaceTabId);
    } catch (e: unknown) {
      actions.toast(`Couldn't open side chat: ${errorText(e)}`, 'error');
    }
  }

  async function openOnOwner(chatId: string, threadId: string, selection?: string, replaceTabId?: string) {
    const remote = await actions.openHostSideChat?.(chatId);
    if (remote) {
      if (replaceTabId && !replaceable(chatId, replaceTabId)) {
        remote.discard();
        return;
      }
      const { thread } = remote;
      remote.publish();
      actions.addThread(thread);
      if (selection) actions.setDraft(thread.id, { text: '', attachments: [actions.selectionAttachment(selection)] });
      actions.markLoaded(thread.id);
      actions.openPane(thread.id, chatId, replaceTabId);
      return thread.id;
    }
    if (actions.nativeOf(chatId) !== threadId) throw new Error('The parent chat changed. Open a new side chat from it.');
    const open = OPENER[actions.familyOf(threadId)];
    if (!open) {
      actions.toast("Side chats aren't available for this harness", 'error');
      return;
    }
    return open(chatId, threadId, selection, replaceTabId);
  }

  return async function openSideChat(
    chatId: string,
    selection?: string,
    replaceTabId?: string,
    { recoveryFrom }: { recoveryFrom?: string } = {},
  ): Promise<string | undefined> {
    const tabs = actions.getPaneTabs(chatId);
    if (replaceTabId && !replaceable(chatId, replaceTabId)) return;
    // Explicitly choosing Side chat on New tab starts a conversation in that tab.
    const sideTabs = tabs.filter(
      (t) => t.kind === 'chat' && !t.readOnly && t.sourceChatId === chatId && t.threadId && actions.canReuse?.(t.threadId) !== false,
    );
    const tab = replaceTabId || recoveryFrom ? undefined : (sideTabs.find((t) => t.id === actions.getPaneActive()) ?? sideTabs.at(-1));
    if (tab?.threadId) {
      const selected = selection ? actions.addSelection(tab.threadId, selection) : true;
      if (selected === 'refused') return;
      if (selection && !selected) {
        const draft = actions.getDraft(tab.threadId);
        actions.setDraft(tab.threadId, {
          text: draft?.text ?? '',
          attachments: [...(draft?.attachments ?? []), actions.selectionAttachment(selection)],
        });
      }
      actions.focusPane(tab.id, tab.threadId, chatId);
      return tab.threadId;
    }
    const key = JSON.stringify([chatId, replaceTabId ?? null, recoveryFrom ?? null]);
    const pending = opening.get(key);
    if (pending !== undefined) {
      const id = await pending;
      if (!id || replaceTabId || recoveryFrom) return id;
      return openSideChat(chatId, selection);
    }
    const threadId = actions.nativeOf(chatId);
    const request = forkChat(chatId, threadId, selection, replaceTabId);
    opening.set(key, request);
    try {
      return await request;
    } finally {
      opening.delete(key);
    }
  };
}

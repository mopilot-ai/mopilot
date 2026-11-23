// Artifact pane tabs: one per chat and claude.ai page, opened from the thread's artifact card, links and agent calls; a publish opens its page beside the chat that made it while that chat is on screen.
import { identityKey } from '../../shared/identityKey.mjs';
import { classifyClaudeUrl } from '../../shared/claudeArtifacts.mjs';
import type { PaneTab } from './state';
import { get, set } from './core';
import { focusedChat } from './split';
import { chatOf } from './chats';
import { paneOpensFull } from '../lib/paneLayout';
import { artifactCall, artifactOpenRequest } from '../lib/designToolCall';

/** A claude.ai page to show: its link, and what the call that made it said about it. */
export interface ArtifactPage {
  url: string;
  title?: string | null;
  version?: string | null;
}

/** What a tab calls a page whose call named no title (the page's own <title> names it on claude.ai). */
const UNTITLED = { artifact: 'Artifact', design: 'Claude Design project' };

/** The tab for a chat's page: one per chat and page, however the page was linked. */
const tabId = (chat: string | null, canonical: string) => identityKey('artifact', chat, canonical);

/**
 * Open (or bring forward) the artifact tab for `page` in `chat`'s pane (the focused chat's when not given). An open tab
 * takes the newer title and version, which reloads its page. With `front` false the tab is only kept current. False
 * for a link that is not a claude.ai artifact or design page.
 */
export function openArtifactTab(page: ArtifactPage, chat: string | null = focusedChat(get()), front = true): boolean {
  const found = classifyClaudeUrl(page.url);
  if (!found) return false;
  const s = get();
  const id = tabId(chat, found.canonical);
  const existing = s.paneTabs.find((t) => t.id === id);
  const tab: PaneTab = {
    ...existing,
    id,
    kind: 'artifact',
    url: page.url,
    artifactKind: found.kind,
    title: page.title ?? existing?.title ?? UNTITLED[found.kind],
    version: page.version ?? existing?.version,
    ...(chat ? { ownerChat: chat } : {}),
  };
  const paneTabs = existing ? s.paneTabs.map((t) => (t.id === id ? tab : t)) : [...s.paneTabs, tab];
  if (!front) {
    set({ paneTabs });
    return true;
  }
  set({
    paneTabs,
    paneActive: id,
    diffPanel: { ...s.diffPanel, open: true },
    paneFull: paneOpensFull('artifact', s.diffPanel.open, s.paneFull, s.prefs.fullViewDefault),
  });
  return true;
}

/**
 * A call finished live in `threadId`: when it published a page and its chat is the one on screen, show the page, as
 * Claude Desktop opens what Claude publishes. A new page opens in front. A page the chat already has a tab for takes
 * its new version (the tab reloads), in front only while the pane is open, so a pane the user closed stays closed;
 * one it has no tab for (the user closed it) stays closed too. A chat that isn't on screen keeps its card only. A
 * finished Artifact `open` call shows its page in front the same way.
 */
export function onArtifactPublished(threadId: string, item: unknown) {
  const made = artifactCall(item);
  const asked = made ? null : artifactOpenRequest(item);
  if (!made && !asked) return;
  const s = get();
  const chat = chatOf(threadId);
  if (focusedChat(s) !== chat) return;
  // the model asked to show a page (the Artifact tool's open): in front, as it asked
  if (!made) return void openArtifactTab({ url: asked as string }, chat);
  const open = s.paneTabs.some((t) => t.id === tabId(chat, made.canonical));
  if (made.action === 'created' || open) openArtifactTab(made, chat, made.action === 'created' || s.diffPanel.open);
}

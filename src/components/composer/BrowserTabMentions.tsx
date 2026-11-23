// "Browser tabs" in the composer's @ menu (BU-09): the chat's in-app browser tabs, from main's agent
// tab state and the pane's titles and URLs, and the tabs in the user's Chrome that the chat's browser
// tools reported (through the narration adapters). Picking one inserts a tab token
// (shared/tabMentions.mjs) that each harness adapter serializes on send.
import { useMemo } from 'react';
import { useStore } from '../../store/core';
import { chatOf } from '../../store/chats';
import { browserTabsSeen, hostOf, type BrowserWhere, type SeenTab } from '../../lib/agentNarration';
import { chatAgentTabs } from '../../lib/agentTabs';
import type { AgentTabView } from '../../lib/native';
import { AppWindow, Globe } from '../ui/icons';

export interface BrowserTabOption {
  key: string;
  where: BrowserWhere;
  title: string;
  url: string;
  tabId: string | null;
  browserId: string | null;
}

type PaneTabLike = { kind: string; agentChat?: string; agentTab?: string; url?: string; title?: string };

/** The tabs the @ menu offers for a query: in-app tabs on a web page first, then the user's Chrome tabs. */
export function browserTabOptions(o: {
  app: { key: string; tabs: AgentTabView[] } | null;
  paneTabs: PaneTabLike[];
  seen: SeenTab[];
  query: string;
  limit?: number;
}): BrowserTabOption[] {
  const out: BrowserTabOption[] = [];
  for (const v of o.app?.tabs ?? []) {
    const pane = o.paneTabs.find((t) => t.kind === 'browser' && t.agentChat === o.app!.key && (t.agentTab ?? null) === v.tabKey);
    const url = pane?.url || v.origin || '';
    if (v.kind !== 'tab' || !/^https?:/.test(url)) continue;
    out.push({ key: `app:${v.tabId}`, where: 'app', title: pane?.title || url, url, tabId: v.tabId, browserId: null });
  }
  for (const t of o.seen) out.push({ key: `${t.where}:${t.tabId}:${t.url}`, ...t });
  const q = o.query.trim().toLowerCase();
  return out.filter((t) => t.title.toLowerCase().includes(q) || t.url.toLowerCase().includes(q)).slice(0, o.limit ?? 6);
}

/** The @ menu's browser tabs for a chat (none for a chat not started yet). */
export function useBrowserTabMentions(threadId: string | null, query: string): BrowserTabOption[] {
  const agentTabs = useStore((s) => s.agentTabs);
  const paneTabs = useStore((s) => s.paneTabs);
  const turns = useStore((s) => (threadId ? s.runtime[threadId]?.turns : undefined));
  return useMemo(() => {
    if (!threadId) return [];
    const seen = browserTabsSeen((turns ?? []).flatMap((t) => t.items));
    return browserTabOptions({ app: chatAgentTabs(agentTabs, threadId, chatOf), paneTabs, seen, query });
  }, [threadId, agentTabs, paneTabs, turns, query]);
}

/** The "Browser tabs" section: rows 0…n-1 of the menu's keyboard order. */
export function BrowserTabRows({
  tabs,
  index,
  setIndex,
  onPick,
}: {
  tabs: BrowserTabOption[];
  index: number;
  setIndex: (n: number) => void;
  onPick: (t: BrowserTabOption) => void;
}) {
  if (!tabs.length) return null;
  return (
    <>
      <div className="composer-popup-label">Browser tabs</div>
      {tabs.map((t, i) => (
        <div
          key={t.key}
          className={`menu-item ${i === index ? 'kbd-active' : ''}`}
          onMouseMove={() => setIndex(i)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(t);
          }}
        >
          <span className="menu-icon">{t.where === 'app' ? <AppWindow size={15} /> : <Globe size={15} />}</span>
          <span className="mention-name">{t.title}</span>
          <span className="mention-path">{`${t.where === 'app' ? 'Built-in browser' : 'Chrome'} · ${hostOf(t.url)}`}</span>
        </div>
      ))}
    </>
  );
}

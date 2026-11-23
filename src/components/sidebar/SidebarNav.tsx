// The sidebar's top rows: New chat (with Quick chat), Search and the app's pages (Scheduled, Plugins, Projects, Code Review).
import type { ReactNode } from 'react';
import { useShortcutHint } from '../../session/shortcutHints';
import { shortcutLabel } from '../../lib/platform';
import { onActivate } from '../../lib/focus';
import { native } from '../../lib/native';
import { useStore, set as setState, toastFailure } from '../../store/core';
import { navigate } from '../../store/panes';
import type { Route } from '../../store/types';
import { Tooltip } from '../ui/Popover';
import { Blocks, CalendarClock, Folder, GitPullRequestArrow, MessageCircleDashed, Search, SquarePen } from '../ui/icons';
import { newStandaloneChat } from './ChatLists';
import { MomoSidebarRow } from '../momo/MomoSidebarRow';

type Page = Extract<Route['name'], 'scheduled' | 'plugins' | 'projects' | 'review'>;
const PAGES: { name: Page; label: string; icon: ReactNode }[] = [
  { name: 'scheduled', label: 'Scheduled', icon: <CalendarClock size={16} strokeWidth={1.7} /> },
  { name: 'plugins', label: 'Plugins', icon: <Blocks size={16} strokeWidth={1.7} /> },
  { name: 'projects', label: 'All projects', icon: <Folder size={16} strokeWidth={1.7} /> },
  { name: 'review', label: 'Code Review', icon: <GitPullRequestArrow size={16} strokeWidth={1.7} /> },
];

/** `homeRow`: the sidebar draws a row for the home page (its homeKey), which is then the home page's current entry. */
export function SidebarNav({ homeRow }: { homeRow: boolean }) {
  const shortcut = useShortcutHint();
  const route = useStore((s) => s.route);
  // New chat is the current page on a home page no row stands for: a chat outside any project, or a target with no row
  // (a machine picked with no folder yet, the one-list and activity views)
  const newChatHere = route.name === 'home' && !homeRow;
  const searchKey = shortcut('command-menu');
  return (
    <div className="sidebar-section sidebar-nav">
      {/* a row, not a <button>: it holds the Quick chat button */}
      <div
        className={`side-row ${newChatHere ? 'selected-soft' : ''}`}
        role="button"
        tabIndex={0}
        onClick={newStandaloneChat}
        onKeyDown={onActivate(newStandaloneChat)}
        aria-label="New chat"
      >
        <span className="side-row-icon">
          <SquarePen size={16} strokeWidth={1.7} />
        </span>
        <span className="side-row-label">New chat</span>
        <span className="side-row-kbd">{shortcut('new-chat') && shortcutLabel(shortcut('new-chat')!)}</span>
        <span className="row-actions">
          <Tooltip label="Quick chat" shortcut={shortcut('quick-chat')}>
            <button
              type="button"
              className="icon-btn xs"
              aria-label="Quick chat"
              onClick={(e) => {
                e.stopPropagation();
                native.win.mini().catch(toastFailure("Couldn't open Quick Chat"));
              }}
            >
              <MessageCircleDashed size={15} strokeWidth={1.7} />
            </button>
          </Tooltip>
        </span>
      </div>
      <MomoSidebarRow />
      <button type="button" className="side-row" onClick={() => setState({ searchOpen: true })} aria-label="Search">
        <span className="side-row-icon">
          <Search size={16} strokeWidth={1.7} />
        </span>
        <span className="side-row-label">Search</span>
        <span className="side-row-kbd">{searchKey && shortcutLabel(searchKey)}</span>
      </button>
      {PAGES.map((p) => {
        const here = route.name === p.name;
        return (
          <button
            type="button"
            key={p.name}
            className={`side-row ${here ? 'selected' : ''}`}
            aria-current={here ? 'page' : undefined}
            onClick={() => navigate({ name: p.name })}
          >
            <span className="side-row-icon">{p.icon}</span>
            <span className="side-row-label">{p.label}</span>
          </button>
        );
      })}
    </div>
  );
}

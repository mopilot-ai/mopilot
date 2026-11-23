// MoMo's own navigation in the sidebar column while its page is open (#2139), as Muse lists its chats beside the chat: Chat and Memory, the earlier main chats a brain change replaced (each opens read-only in Chat), then Settings › MoMo; the column's way back (PageNavColumn) leads to the coding chats.
import { useState, type ReactNode } from 'react';
import { useEffectOn } from '../../lib/effects';
import { navigate } from '../../store/panes';
import { useStore } from '../../store/core';
import type { Route } from '../../store/route';
import { useMomoPrefs } from '../../session/momoPrefs';
import { native, type MomoPreviousChat } from '../../lib/native';
import { ignoring } from '../../lib/ignored';
import { relativeTime } from '../../lib/format';
import { MomoDot } from './MomoSidebarRow';
import { Brain, History, ListChecks, MessageCircle, Settings } from '../ui/icons';

export type MomoTab = NonNullable<Extract<Route, { name: 'momo' }>['tab']>;

const ICON = { size: 16, strokeWidth: 1.7 };
const TABS: [MomoTab, string, ReactNode][] = [
  ['chat', 'Chat', <MessageCircle {...ICON} />],
  ['tasks', 'Tasks', <ListChecks {...ICON} />],
  ['memory', 'Memory', <Brain {...ICON} />],
];

type RowProps = { icon: ReactNode; label: string; meta?: string; selected?: boolean; onClick: () => void };

function NavRow({ icon, label, meta, selected, onClick }: RowProps) {
  return (
    <button
      type="button"
      className={`side-row ${selected ? 'selected' : ''}`}
      aria-current={selected ? 'page' : undefined}
      onClick={onClick}
    >
      <span className="side-row-icon">{icon}</span>
      <span className="side-row-label">{label}</span>
      {meta ? <span className="side-row-kbd">{meta}</span> : null}
    </button>
  );
}

/** MoMo's earlier main chats, newest first, read again whenever a chat becomes one (main retags it, every window hears). */
export function Earlier({ shown }: { shown: string | undefined }) {
  const [chats, setChats] = useState<MomoPreviousChat[]>([]);
  const ids = useStore((s) =>
    Object.keys(s.momoChats)
      .filter((id) => s.momoChats[id] === 'previous')
      .sort()
      .join(' '),
  );
  useEffectOn([ids], () => {
    let current = true;
    native.momoChat.previousChats().then((c) => current && setChats(c), ignoring("list MoMo's earlier chats"));
    return () => {
      current = false;
    };
  });
  if (!chats.length) return null;
  return (
    <div className="sidebar-section">
      <div className="side-label">Earlier</div>
      {chats.map((c) => (
        <NavRow
          key={c.chatId}
          icon={<History {...ICON} />}
          label={c.harness}
          meta={relativeTime(c.at / 1000)}
          selected={c.chatId === shown}
          onClick={() => navigate({ name: 'momo', tab: 'chat', chatId: c.chatId })}
        />
      ))}
    </div>
  );
}

export function MomoNav({ tab = 'chat', chatId }: { tab?: MomoTab; chatId?: string }) {
  // during setup the page is setup alone: no tab to go to yet
  const { onboarding, persona } = useMomoPrefs();
  const ready = onboarding.done;
  // an earlier chat is marked in its own list, not as Chat
  const earlier = useStore((s) => !!chatId && s.momoChats[chatId] === 'previous');
  return (
    <aside className="sidebar" aria-label="MoMo">
      <div className="sidebar-header">
        <span className="sidebar-title static momo-nav-title">
          {ready && <MomoDot size={10} />}
          {persona.name}
        </span>
      </div>
      <div className="sidebar-scroll">
        {ready && (
          <div className="sidebar-section">
            {TABS.map(([id, label, icon]) => (
              <NavRow
                key={id}
                icon={icon}
                label={label}
                selected={id === tab && !earlier}
                onClick={() => navigate({ name: 'momo', tab: id })}
              />
            ))}
          </div>
        )}
        {ready && <Earlier shown={tab === 'chat' ? chatId : undefined} />}
        <div className="sidebar-section">
          <NavRow icon={<Settings {...ICON} />} label="Settings" onClick={() => navigate({ name: 'settings', section: 'momo' })} />
        </div>
      </div>
    </aside>
  );
}

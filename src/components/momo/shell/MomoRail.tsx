// The one navigation column of MoMo's page in the shell (M0b, #4926; design 5.1): a header with the way back to the chats and the toggle that hides it completely (no icon rail is left), the places (Main with its Everything stream, then the channels' list, A2), one "New channel or group" action, and a footer: Memory, Settings (and Tasks while the Tasks panel is off), MoMo's earlier chats, a line naming where MoMo runs as text, and the account row last (RailAccount). The app's own MoMo nav column is not drawn beside it.
import type { ReactNode } from 'react';
import { ArrowLeft, Layers, PanelLeft } from '../../ui/icons';
import { navigate } from '../../../store/panes';
import { Earlier, type MomoTab } from '../MomoNav';
import { RailAccount } from './RailAccount';
import { RailNew } from './RailAction';
import { SHELL_COPY } from './shellCopy';
import styles from './momoShell.module.css';

function RailRow({ label, current, go, icon }: { label: string; current?: boolean; go: () => void; icon?: ReactNode }) {
  return (
    <button type="button" className={styles.railLink} aria-current={current ? 'page' : undefined} onClick={go}>
      {icon}
      {label}
    </button>
  );
}

export function MomoRail({
  paused,
  hide,
  onNewChannel,
  onNewGroup,
  channels,
  width,
  tab = 'chat',
  chatId,
  tasksPage = false,
}: {
  paused: boolean;
  hide: () => void;
  onNewChannel?: () => void;
  onNewGroup?: () => void;
  /** the channels' own list (A2), which takes the place of the single Everything row */
  channels?: ReactNode;
  /** the rail's width, from useRailWidth; the stylesheet's 220 without one */
  width?: number;
  /** the page shown (Memory and Tasks are pages beside the chat) and the chat in it */
  tab?: MomoTab;
  chatId?: string;
  /** the Tasks page is a row of the footer while the Tasks panel (its button) is off */
  tasksPage?: boolean;
}) {
  return (
    <nav className={styles.rail} aria-label="MoMo" style={width === undefined ? undefined : { width }}>
      <div className={styles.head}>
        <button type="button" className={styles.iconBtn} aria-label={SHELL_COPY.hideRail} title={SHELL_COPY.hideRail} onClick={hide}>
          <PanelLeft size={16} strokeWidth={1.8} />
        </button>
        <button
          type="button"
          className={styles.iconBtn}
          aria-label={SHELL_COPY.back}
          title={SHELL_COPY.back}
          onClick={() => navigate({ name: 'home' })}
        >
          <ArrowLeft size={16} strokeWidth={1.8} />
        </button>
      </div>
      {channels ?? (
        <ul className={styles.railList}>
          <li>
            <RailRow
              icon={<Layers size={16} strokeWidth={1.7} aria-hidden="true" />}
              label={SHELL_COPY.everything}
              current={tab === 'chat'}
              go={() => navigate({ name: 'momo', tab: 'chat' })}
            />
          </li>
        </ul>
      )}
      {onNewChannel ? <RailNew onNewChannel={onNewChannel} onNewGroup={onNewGroup} /> : null}
      <div className={styles.more}>
        {tasksPage ? (
          <RailRow label={SHELL_COPY.tasksPage} current={tab === 'tasks'} go={() => navigate({ name: 'momo', tab: 'tasks' })} />
        ) : null}
        <RailRow label={SHELL_COPY.memory} current={tab === 'memory'} go={() => navigate({ name: 'momo', tab: 'memory' })} />
        <RailRow label={SHELL_COPY.settings} go={() => navigate({ name: 'settings', section: 'momo' })} />
        <Earlier shown={tab === 'chat' ? chatId : undefined} />
      </div>
      <p className={styles.home}>{paused ? SHELL_COPY.paused : SHELL_COPY.home}</p>
      <RailAccount />
    </nav>
  );
}

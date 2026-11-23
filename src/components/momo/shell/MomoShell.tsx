// MoMo's page shell (M0b, behind `momo.shell`): the chat in the centre unchanged, the one navigation rail on the left (resized with the app sidebar's own handle at the design's 232 to 420, hidden by its toggle or Cmd/Ctrl+B, both kept in the prefs), and panel buttons at the top right: Tasks (the four-tab panel, only with `momo.tasksPanel`) Files (MoMo's Outputs, only with `momo.outputs`) and Sessions (the other chats, only with `momo.sessions`). One panel at a time (ShellPane), opened and closed in one frame with no animation (design §6); the centre's padding eases over 200 ms as the rail or pane toggles (the rail and pane themselves appear at once); Esc and the same button close the pane.
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useFlag } from '../../../lib/flags';
import { RAIL_BOUNDS } from '../../../lib/sidebarSizing';
import { useMomoPrefs } from '../../../session/momoPrefs';
import { SidebarResize } from '../../sidebar/SidebarResize';
import { Files, ListChecks, PanelLeft, Rows3 } from '../../ui/icons';
import type { MomoTab } from '../MomoNav';
import { MomoRail } from './MomoRail';
import { askForTask } from './newTask';
import { ShellPane } from './ShellPane';
import { SHELL_COPY } from './shellCopy';
import { useRailOpen, usePanel, type ShellPanelId } from './useShellState';
import { usePaneWidth, useRailWidth } from './useRailWidth';
import styles from './momoShell.module.css';

export function MomoShell({
  children,
  onNewChannel,
  onNewGroup,
  channels,
  tab,
  chatId,
  channel,
  feed,
}: {
  children: ReactNode;
  onNewChannel?: () => void;
  onNewGroup?: () => void;
  channels?: ReactNode;
  tab?: MomoTab;
  chatId?: string;
  /** the channel shown, which names the Tasks pane */
  channel?: string;
  /** Everything's feed is shown: it has no composer */
  feed?: boolean;
}) {
  const prefs = useMomoPrefs();
  const filesOn = useFlag('momo.outputs');
  const [rail, setRail] = useRailOpen();
  const available = { tasks: prefs.tasksPanel, files: filesOn, sessions: prefs.sessions };
  const [panel, toggle, close] = usePanel(available);
  // the rail and the pane share the lane with the chat: each leaves the other its width and the chat its minimum
  const pane = usePaneWidth(0);
  const sizing = useRailWidth(panel ? pane.width : 0);
  // the centre eases (200 ms) into the room a closed rail or pane leaves; they themselves go at once
  const [tween, setTween] = useState<'rail' | 'pane' | undefined>();
  const was = useRef({ rail, panel });
  useEffect(() => {
    const before = was.current;
    was.current = { rail, panel };
    if (before.rail && !rail) setTween('rail');
    else if (before.panel && !panel) setTween('pane');
    else setTween(undefined);
  }, [rail, panel]);
  // three 28 px icon buttons at the top right (Tasks, Make, Sessions), each named for assistive technology and in a tooltip
  const buttons: [ShellPanelId, string, ReactNode][] = [
    ['tasks', SHELL_COPY.tasks, <ListChecks size={16} strokeWidth={1.8} aria-hidden="true" />],
    ['files', SHELL_COPY.files, <Files size={16} strokeWidth={1.8} aria-hidden="true" />],
    ['sessions', SHELL_COPY.sessions, <Rows3 size={16} strokeWidth={1.8} aria-hidden="true" />],
  ];
  return (
    <div
      className={styles.shell}
      data-momo-shell=""
      data-panel={panel ?? undefined}
      style={{ '--momo-rail-w': `${sizing.width}px`, '--momo-pane-w': `${pane.width + 24}px` } as CSSProperties}
    >
      {rail || sizing.dragging ? (
        <MomoRail
          paused={prefs.paused}
          hide={() => setRail(false)}
          onNewChannel={onNewChannel}
          onNewGroup={onNewGroup}
          channels={channels}
          width={sizing.width}
          tab={tab}
          chatId={chatId}
          tasksPage={!prefs.tasksPanel}
        />
      ) : null}
      {/* the app sidebar's own handle (same strip, cursor, saving) with the rail's limits and keys; at the rail's right edge, or its left edge while hidden */}
      <SidebarResize
        name="sidebar"
        bounds={RAIL_BOUNDS}
        shortcut="Meta+b"
        open={rail}
        width={sizing.width}
        dragging={sizing.dragging}
        onWidthChange={sizing.setWidth}
        onDraggingChange={sizing.setDragging}
        beside={panel ? pane.width : 0}
        onOpenChange={setRail}
        onSaveWidth={sizing.save}
      />
      <div className={styles.centre} data-rail={rail ? 'open' : 'hidden'} data-tween={tween}>
        {children}
        <div className={styles.bar}>
          {rail ? null : (
            <button
              type="button"
              className={styles.iconBtn}
              aria-label={SHELL_COPY.showRail}
              title={SHELL_COPY.showRail}
              onClick={() => setRail(true)}
            >
              <PanelLeft size={16} strokeWidth={1.8} />
            </button>
          )}
          <span className={styles.spacer} />
          {buttons.map(([id, label, icon]) =>
            available[id] ? (
              <button
                key={id}
                type="button"
                className={styles.panelBtn}
                aria-label={label}
                title={label}
                aria-pressed={panel === id}
                onClick={() => toggle(id)}
              >
                {icon}
              </button>
            ) : null,
          )}
        </div>
      </div>
      {panel ? (
        <ShellPane
          panel={panel}
          sizing={pane}
          beside={rail ? sizing.width : 0}
          close={close}
          channel={channel}
          onNew={() => askForTask({ tab, feed })}
        />
      ) : null}
    </div>
  );
}

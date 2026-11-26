// A chat only a machine's Host lists, as a sidebar row: its title and state, opened through main (src/session/openMachineChat.ts) into the same chat view as any chat. A row of a machine that does not answer is the last it said: it looks so, and opening it says why it cannot and where to fix that.
import { useRef, useState } from 'react';
import { RowDot } from './ThreadIndicators';
import { Tooltip } from '../ui/Popover';
import { onActivate } from '../../lib/focus';
import { toast } from '../../store/core';
import { navigate } from '../../store/panes';
import { openChatWhere } from '../../session/openChat';
import { openMachineChat } from '../../session/openMachineChat';
import type { HostChatRow } from '../../lib/native/hostChats';

const STATE = {
  running: { status: 'working', label: 'Working' },
  attention: { status: 'waiting', label: 'Needs you' },
} as const;

export function MachineChatRow({
  machineId,
  machineName,
  row,
  live,
  offline,
}: {
  machineId: string;
  machineName: string;
  row: HostChatRow;
  /** the machine answers and its list is current */
  live: boolean;
  /** the machine does not answer (a list that is not live on a machine that does is out of date) */
  offline: boolean;
}) {
  const [opening, setOpening] = useState(false);
  // a second press in the same tick sees no state yet: the ref is what says one is under way
  const under = useRef(false);
  const title = row.title || 'Untitled chat';
  const open = async (e?: { altKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
    if (under.current) return;
    if (!live)
      return void toast(
        offline
          ? `${machineName} is offline. Reconnect it to open this chat.`
          : `The list of chats on ${machineName} is out of date. It refreshes by itself: try again in a moment.`,
        'info',
        { action: { label: 'Edit machine', run: () => navigate({ name: 'settings', section: 'connections', tab: 'other' }) } },
      );
    under.current = true;
    setOpening(true);
    try {
      await openMachineChat(machineId, row.chatId, e ? openChatWhere(e) : 'here', { title: row.title, machineName });
    } finally {
      under.current = false;
      setOpening(false);
    }
  };
  // a state the machine said while it answered is not shown as live once it does not
  const mark = row.state === 'idle' || !live ? null : STATE[row.state];
  return (
    <div
      className={`side-row thread-row machine-chat-row${live ? '' : ' not-live'}`}
      role="button"
      aria-label={live ? title : offline ? `${title}, ${machineName} is offline` : `${title}, list out of date`}
      aria-busy={opening || undefined}
      tabIndex={0}
      onClick={(e) => void open(e)}
      onKeyDown={onActivate(() => void open())}
    >
      <span className="thread-row-content">
        <span className="side-row-name">
          {/* a title the machine's Host supplied may be in any direction: it never reorders the row around it */}
          <span className="side-row-label">
            <bdi>{title}</bdi>
          </span>
        </span>
      </span>
      <span className="row-status">
        {mark && (
          <Tooltip label={mark.label}>
            <RowDot status={mark.status} label={mark.label} />
          </Tooltip>
        )}
      </span>
    </div>
  );
}

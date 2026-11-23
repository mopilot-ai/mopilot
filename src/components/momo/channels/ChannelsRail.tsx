// The rail's list of MoMo's places (A2): Main (the default, MoMo's one chat), Everything (every channel's rows by time) with the groups, their channels and the channels with no group nested under it. A channel or group has a menu (its words are in channelCopy.ts); a channel can be dragged onto a group (or moved from its menu, which is the same call); an empty group says "Drag or move channels here". Only the rows: the dialogs and calls are the page's (useChannelsUi.tsx).
import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyEvent, type DragEvent, type ReactNode } from 'react';
import { imeComposing } from '../../../lib/focus';
import { Funnel, Layers, MessageCircle, MessageSquare, MoreHorizontal } from '../../ui/icons';
import { PlusMenu } from '../shell/RailAction';
import type { MomoChannel, MomoChannelGroup } from '../../../lib/native/contracts/momoChannels';
import { CHANNEL_COPY as C } from './channelCopy';
import railStyles from '../shell/momoShell.module.css';
import styles from './channels.module.css';

/** What a row of the rail can be asked to do (the page runs it). */
export interface RailActions {
  openMain: () => void;
  openEverything: () => void;
  openChannel: (id: string) => void;
  rename: (c: MomoChannel) => void;
  instructions: (c: MomoChannel) => void;
  move: (c: MomoChannel, group: string | null) => void;
  /** the same move, for a channel dragged onto a group (its id is what the drag carries) */
  moveById: (id: string, group: string | null) => void;
  /** one place up or down among the channels beside it (Space picks one up, Up and Down move it) */
  reorder: (c: MomoChannel, dir: 'up' | 'down') => void;
  archive: (c: MomoChannel) => void;
  remove: (c: MomoChannel) => void;
  renameGroup: (g: MomoChannelGroup) => void;
  removeGroup: (g: MomoChannelGroup) => void;
  /** Everything's + (the page's New channel and New group) */
  create?: { channel: () => void; group: () => void };
}

/** Everything's Filter (funnel): a small popover with its one row, "Status · Active ›" (channels that are archived are not listed, so Active is the only status). */
function FilterAction() {
  return (
    <RowMenu label={C.filterAction} icon={<Funnel size={14} strokeWidth={1.8} />}>
      {(close) => (
        <Item close={close} checked onPick={() => undefined}>
          {C.statusActive}
        </Item>
      )}
    </RowMenu>
  );
}

/** What is shown now: Main, Everything, or one channel (`none`: a page of MoMo's beside the chat, Memory or Tasks). */
export type RailView = { kind: 'none' } | { kind: 'main' } | { kind: 'everything' } | { kind: 'channel'; id: string };

const DRAG = 'text/x-momo-channel';

/** A small menu under its button: closes on Escape and on a click anywhere else. */
function RowMenu({
  label,
  children,
  show,
  onShow,
  icon,
}: {
  label: string;
  children: (close: () => void) => ReactNode;
  /** the menu opened from outside (a right click on its row) */
  show?: boolean;
  onShow?: (open: boolean) => void;
  /** the button's icon: ⋯ unless given */
  icon?: ReactNode;
}) {
  const [own, setOwn] = useState(false);
  const open = show ?? own;
  const setOpen = useCallback((next: boolean) => (onShow ? onShow(next) : setOwn(next)), [onShow]);
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && !imeComposing(e) && setOpen(false);
    window.addEventListener('mousedown', away);
    window.addEventListener('keydown', esc);
    return () => {
      window.removeEventListener('mousedown', away);
      window.removeEventListener('keydown', esc);
    };
  }, [open, setOpen]);
  return (
    <span ref={box} style={{ position: 'relative' }}>
      <button
        type="button"
        className={styles.small}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        {icon ?? <MoreHorizontal size={14} strokeWidth={1.8} />}
      </button>
      {open ? (
        <div className={styles.menu} role="menu" aria-label={label}>
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </span>
  );
}

function Item({
  onPick,
  close,
  children,
  checked,
  danger,
}: {
  onPick: () => void;
  close: () => void;
  children: ReactNode;
  checked?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={danger ? `${styles.menuItem} ${styles.danger}` : styles.menuItem}
      role={checked === undefined ? 'menuitem' : 'menuitemradio'}
      aria-checked={checked}
      onClick={() => {
        close();
        onPick();
      }}
    >
      {children}
    </button>
  );
}

/** "Move to group ›": opens the groups (and No group) under it; absent when there is none to move to. */
function MoveItems({
  channel,
  groups,
  act,
  close,
}: {
  channel: MomoChannel;
  groups: MomoChannelGroup[];
  act: RailActions;
  close: () => void;
}) {
  const [open, setOpen] = useState(false);
  if (!groups.length && !channel.group) return null;
  return (
    <>
      <button type="button" className={styles.menuItem} role="menuitem" aria-expanded={open} onClick={() => setOpen(!open)}>
        {C.moveToGroup}
      </button>
      {open
        ? groups.map((g) => (
            <Item key={g.id} close={close} checked={channel.group === g.id} onPick={() => act.move(channel, g.id)}>
              {C.move}: {g.name}
            </Item>
          ))
        : null}
      {open && channel.group ? (
        <Item close={close} onPick={() => act.move(channel, null)}>
          {C.move}: {C.noGroup}
        </Item>
      ) : null}
    </>
  );
}

/** A channel's menu (the design's): rename, instructions, move to a group, archive, and Delete in red after a divider; the rail's rows (also by right click) and the channel's own header share it. */
export function ChannelMenu({
  channel,
  groups,
  act,
  show,
  onShow,
}: {
  channel: MomoChannel;
  groups: MomoChannelGroup[];
  act: RailActions;
  show?: boolean;
  onShow?: (open: boolean) => void;
}) {
  return (
    <RowMenu label={C.menuFor(channel.name)} show={show} onShow={onShow}>
      {(close) => (
        <>
          <Item close={close} onPick={() => act.rename(channel)}>
            {C.rename}
          </Item>
          <Item close={close} onPick={() => act.instructions(channel)}>
            {C.instructions}
          </Item>
          <MoveItems channel={channel} groups={groups} act={act} close={close} />
          <Item close={close} onPick={() => act.archive(channel)}>
            {C.archive}
          </Item>
          <div className={styles.menuSep} role="separator" />
          <Item close={close} danger onPick={() => act.remove(channel)}>
            {C.delete}
          </Item>
        </>
      )}
    </RowMenu>
  );
}

function ChannelRow({
  channel,
  groups,
  current,
  nested,
  act,
}: {
  channel: MomoChannel;
  groups: MomoChannelGroup[];
  current: boolean;
  nested: boolean;
  act: RailActions;
}) {
  // a right click anywhere on the row opens the same menu as its ⋯
  const [menu, setMenu] = useState(false);
  // Space picks the row up, Up and Down move it, Space or Escape (or leaving it) drops it
  const [held, setHeld] = useState(false);
  const onKey = (e: ReactKeyEvent<HTMLButtonElement>) => {
    if (e.key === ' ') {
      e.preventDefault();
      setHeld(!held);
    } else if (held && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
      e.preventDefault();
      act.reorder(channel, e.key === 'ArrowUp' ? 'up' : 'down');
    } else if (held && e.key === 'Escape' && !imeComposing(e.nativeEvent)) setHeld(false);
  };
  return (
    <li
      className={`${styles.row} ${nested ? styles.nested : ''}`}
      draggable
      onDragStart={(e: DragEvent) => e.dataTransfer.setData(DRAG, channel.id)}
      onContextMenu={(e) => (e.preventDefault(), setMenu(true))}
    >
      <button
        type="button"
        className={`${railStyles.railLink} ${styles.rowLink}`}
        aria-current={current ? 'page' : undefined}
        data-held={held ? '' : undefined}
        onClick={() => act.openChannel(channel.id)}
        onKeyDown={onKey}
        onKeyUp={(e) => e.key === ' ' && e.preventDefault()}
        onBlur={() => setHeld(false)}
      >
        <MessageSquare size={16} strokeWidth={1.7} aria-hidden="true" />
        <span className={styles.rowName}>{channel.name}</span>
      </button>
      <ChannelMenu channel={channel} groups={groups} act={act} show={menu} onShow={setMenu} />
      <span className={styles.sr} role="status">
        {held ? C.pickedUp(channel.name) : ''}
      </span>
    </li>
  );
}

function GroupBlock({
  group,
  channels,
  groups,
  view,
  act,
}: {
  group: MomoChannelGroup;
  channels: MomoChannel[];
  groups: MomoChannelGroup[];
  view: RailView;
  act: RailActions;
}) {
  const [over, setOver] = useState(false);
  return (
    <li>
      <div
        className={styles.groupHead}
        data-over={over ? '' : undefined}
        onDragOver={(e) => (e.preventDefault(), setOver(true))}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          const id = e.dataTransfer.getData(DRAG);
          if (id) act.moveById(id, group.id);
        }}
      >
        <span className={styles.groupName}>{group.name}</span>
        <RowMenu label={`${C.groupMenu}: ${group.name}`}>
          {(close) => (
            <>
              <Item close={close} onPick={() => act.renameGroup(group)}>
                {C.rename}
              </Item>
              <Item close={close} onPick={() => act.removeGroup(group)}>
                {C.deleteGroup}
              </Item>
            </>
          )}
        </RowMenu>
      </div>
      {channels.length ? (
        <ul className={styles.railGroup}>
          {channels.map((c) => (
            <ChannelRow key={c.id} channel={c} groups={groups} current={view.kind === 'channel' && view.id === c.id} nested act={act} />
          ))}
        </ul>
      ) : (
        <p className={styles.empty}>{C.emptyGroup}</p>
      )}
    </li>
  );
}

export function ChannelsRail({
  channels,
  groups,
  view,
  act,
}: {
  channels: MomoChannel[];
  groups: MomoChannelGroup[];
  view: RailView;
  act: RailActions;
}) {
  const loose = channels.filter((c) => !c.group || !groups.some((g) => g.id === c.group));
  return (
    <ul className={railStyles.railList}>
      <li>
        <button
          type="button"
          className={railStyles.railLink}
          aria-current={view.kind === 'main' ? 'page' : undefined}
          onClick={() => act.openMain()}
        >
          <MessageCircle size={16} strokeWidth={1.7} aria-hidden="true" />
          {C.main}
        </button>
      </li>
      <li>
        <div className={styles.row}>
          <button
            type="button"
            className={`${railStyles.railLink} ${styles.rowLink}`}
            aria-current={view.kind === 'everything' ? 'page' : undefined}
            onClick={() => act.openEverything()}
          >
            <Layers size={16} strokeWidth={1.7} aria-hidden="true" />
            {C.everything}
          </button>
          <span className={styles.hoverActions}>
            <FilterAction />
            {act.create ? <PlusMenu onNewChannel={act.create.channel} onNewGroup={act.create.group} label={C.createMenu} small /> : null}
          </span>
        </div>
        {/* the channels sit under Everything: it is the stream of all of them */}
        <ul className={styles.underEverything} aria-label={C.channelsUnder}>
          {groups.map((g) => (
            <GroupBlock key={g.id} group={g} channels={channels.filter((c) => c.group === g.id)} groups={groups} view={view} act={act} />
          ))}
          {loose.map((c) => (
            <ChannelRow
              key={c.id}
              channel={c}
              groups={groups}
              current={view.kind === 'channel' && view.id === c.id}
              nested={false}
              act={act}
            />
          ))}
        </ul>
      </li>
    </ul>
  );
}

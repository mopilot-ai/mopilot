// The sidebar's "By machine" view: one group per place chats run (this Mac, each machine), each showing its newest chats and a Show more; a machine's heading carries its status dot, its menu and a new chat on it.
import { Fragment, useMemo, useSyncExternalStore } from 'react';
import { Collapse } from '../ui/Presence';
import { Menu, MenuItem, Tooltip, useAnchor } from '../ui/Popover';
import { ChevronRight, Ellipsis, Settings2, SquarePen } from '../ui/icons';
import { HostMark } from '../ui/HostMark';
import { useStore, set as setState, get as getState, toast } from '../../store/core';
import { visibleChats } from '../../store/split';
import { deletionVisibility } from '../../store/deletionVisibility';
import { navigate } from '../../store/panes';
import { pickNewChatHost } from '../../store/projects';
import { onActivate } from '../../lib/focus';
import { useHostChats } from '../../lib/hostChats';
import { useHostMachines } from '../../lib/hostMachines';
import { useHostChatIndex } from '../../lib/hostChatIndex';
import { familiesOf } from '../../lib/sidebarFamilyIndex';
import { isMomoChat } from '../../lib/momoChats';
import { useSidebarLineage } from '../../session/harness/claude/desktopLineage';
import { type MachineGroupData, TRUNCATED_NOTE, machineGroups } from './machineGroupData';
import { ThreadRow } from './ThreadRow';
import { ChildRows } from './ChildRows';
import { MachineChatRow } from './MachineChatRow';
import { useRequiredChats } from './useRequiredChats';
import { WindowFoot } from './WindowFoot';
import { chatWindow } from './chatWindow';

/** Chats a group shows before its Show more. */
export const VISIBLE_PER_MACHINE = 5;
const EMPTY: Record<string, number> = {};

/** The groups the view draws, from the chat records, the machines and the Mac's index of what each machine lists. */
export function useMachineGroups(): MachineGroupData[] {
  const v = useSidebarLineage();
  const threads = useStore((s) => s.threads);
  const listed = useStore((s) => s.threadOrder);
  const momoChats = useStore((s) => s.momoChats);
  const claudeArchived = useStore((s) => s.claudeArchived ?? EMPTY);
  const archived = useStore((s) => s.archived);
  const { machines } = useHostMachines();
  const { owners, status } = useHostChats();
  // a chat deleted here is gone for good: the machine may list it for a while yet (it is told when it is next reached)
  const deletions = useSyncExternalStore(deletionVisibility.subscribe, deletionVisibility.snapshot);
  const { indexes, answered } = useHostChatIndex(() => visibleChats(getState()));
  const roots = familiesOf(v, listed, threads, momoChats, true).roots;
  return useMemo(() => {
    const gone = new Set(archived.map((t) => t.id));
    return machineGroups({
      roots,
      threads,
      ownerOf: (id) => owners.get(id) ?? '',
      // MoMo's chats are in no list of chats (a Host does not list them; this is the rule on this side too)
      hidden: (id) => !!claudeArchived[id] || gone.has(id) || isMomoChat(momoChats, id) || (deletions >= 0 && deletionVisibility.has(id)),
      // a failed read after an answer keeps the owners it had: only before the first answer is nothing known
      ownersKnown: status !== 'unknown',
      machines,
      indexed: indexes,
      answered,
      macName: 'This Mac',
    });
  }, [roots, threads, momoChats, owners, status, claudeArchived, archived, deletions, machines, indexes, answered]);
}

/** The groups, one under the other. */
export function MachineGroups({ activeThread }: { activeThread: string | null }) {
  const groups = useMachineGroups();
  return (
    <>
      {groups.map((g) => (
        <MachineGroup key={g.key} group={g} activeThread={activeThread} />
      ))}
    </>
  );
}

function MachineGroup({ group, activeThread }: { group: MachineGroupData; activeThread: string | null }) {
  const menu = useAnchor();
  const collapsed = useStore((s) => !!s.collapsedProjects[group.key]);
  const expanded = !collapsed;
  const roots = useMemo(() => group.rows.flatMap((r) => (r.kind === 'thread' ? [r.thread] : [])), [group.rows]);
  const required = useRequiredChats(roots, activeThread);
  // Show more survives the group being folded and the view being switched: it is the store's, as a project's is
  const revealed = useStore((s) => s.revealedChats[group.key] ?? 0);
  const { visible, foot, more } = chatWindow(group.rows, VISIBLE_PER_MACHINE, revealed, (r) => r.kind === 'thread' && required.has(r.key));
  const reveal = (n: number) => setState((s) => ({ revealedChats: { ...s.revealedChats, [group.key]: n } }));
  const toggle = () => setState((s) => ({ collapsedProjects: { ...s.collapsedProjects, [group.key]: !collapsed } }));
  const offline = group.dot === 'off';
  const editMachine = () => navigate({ name: 'settings', section: 'connections', tab: 'other' });
  const newChat = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (offline)
      return void toast(`${group.name} is offline. Reconnect it to start a chat there.`, 'info', {
        action: { label: 'Edit machine', run: editMachine },
      });
    pickNewChatHost({ id: group.id || 'local', name: group.name });
    navigate({ name: 'home' });
  };
  return (
    <div className="project-group machine-group" data-machine-group={group.id || 'this-mac'}>
      <div
        className={`side-row project-row ${menu.open ? 'menu-open' : ''}`}
        role="button"
        aria-label={group.name}
        aria-expanded={expanded}
        tabIndex={0}
        onClick={toggle}
        onKeyDown={onActivate(toggle)}
      >
        <span className="side-row-name project-row-name">
          <span className="side-row-label">
            <bdi>{group.name}</bdi>
          </span>
          {group.id && <HostMark id={group.id} name={group.name} cloud={group.cloud} size={16} />}
          {group.dot && (
            <span
              className={`by-machine-dot ${group.dot}`}
              role="img"
              aria-label={group.dot === 'on' ? 'Connected' : 'Not connected'}
              title={group.dot === 'on' ? 'Connected' : 'Not connected'}
            />
          )}
          <ChevronRight className="project-disclosure" size={14} aria-hidden="true" />
        </span>
        <span className="row-actions">
          {group.id && (
            <Tooltip label="Machine actions">
              <button
                ref={menu.ref}
                className="icon-btn xs"
                aria-label={`Actions for ${group.name}`}
                onClick={(e) => {
                  e.stopPropagation();
                  menu.toggle();
                }}
              >
                <Ellipsis size={15} />
              </button>
            </Tooltip>
          )}
          <Tooltip label={offline ? `${group.name} is not connected` : `New chat on ${group.name}`}>
            <button className="icon-btn xs" aria-label={`New chat on ${group.name}`} aria-disabled={offline || undefined} onClick={newChat}>
              <SquarePen size={14} />
            </button>
          </Tooltip>
        </span>
      </div>
      <Collapse open={expanded} className="side-collapse">
        {group.note && <div className={`side-row empty-note machine-note ${group.loading ? 'loading' : ''}`}>{group.note}</div>}
        {group.empty && <div className="side-row empty-note">No chats</div>}
        {visible.map((row) =>
          row.kind === 'thread' ? (
            <Fragment key={row.key}>
              <ThreadRow thread={row.thread} active={row.key === activeThread} nestedView="list" projectHostId={group.id || undefined} />
              <ChildRows parentId={row.key} activeThread={activeThread} view="list" projectHostId={group.id || undefined} />
            </Fragment>
          ) : (
            <MachineChatRow
              key={row.key}
              machineId={row.machineId}
              machineName={group.name}
              row={row.row}
              live={row.live}
              offline={group.dot === 'off'}
            />
          ),
        )}
        <WindowFoot foot={foot} label={group.name} onMore={() => reveal(more)} onLess={() => reveal(0)} />
        {group.truncated && <div className="side-row empty-note machine-note">{TRUNCATED_NOTE}</div>}
      </Collapse>
      {group.id && (
        <Menu anchor={menu.anchor} open={menu.open} onClose={menu.close} placement="bottom-start" width={200}>
          <MenuItem icon={<Settings2 size={15} />} onSelect={editMachine}>
            Edit machine…
          </MenuItem>
        </Menu>
      )}
    </div>
  );
}

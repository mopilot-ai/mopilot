// Linked sidebar families use one rounded guide and one visual level; folding retains attention and open-pane rows.
import { useEffect, type CSSProperties } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useStore, threadTitle } from '../../store/core';
import { chatOf } from '../../store/chats';
import { chatAgentTabs } from '../../lib/agentTabs';
import { linkedChildren, nestedSummary, type NestedCounts } from '../../lib/sideSessions';
import { useSidebarLineage } from '../../session/harness/claude/desktopLineage';
import { familiesOf } from '../../lib/sidebarFamilyIndex';
import { isMomoChat } from '../../lib/momoChats';
import { visibleChats } from '../../store/split';
import { hiddenIn, setNestedHidden, useNestedHidden, useNestedHiddenKeys, type NestedView } from '../../lib/nestedHidden';
import { chatRowState, nestedTally, rowRuntime } from '../../session/chatRowState';
import { ensureSession, useSessions } from '../../store/session/useSession';
import { EMPTY_SESSION } from '../../store/session/sessionState';
import { adapterTasksOf, useAdapterTasksRevision } from '../../store/backgroundTasks';
import { ThreadRow } from './ThreadRow';
import { MenuItem } from '../ui/Popover';
import { ChevronsDownUp, ChevronsUpDown, CircleAlert } from '../ui/icons';

type Props = {
  parentId: string;
  activeThread: string | null;
  view: NestedView;
  projectHostId?: string;
};

/** A flat chat reads only lineage; a family additionally observes every member's current state. */
export function ChildRows(props: Props) {
  const ids = linkedChildren(useSidebarLineage(), props.parentId);
  return ids.length ? <ChildList {...props} /> : null;
}

const NO_ROWS: string[] = [];

function ChildList({ parentId, activeThread, view, projectHostId }: Props) {
  const v = useSidebarLineage();
  const threads = useStore((s) => s.threads);
  const initialTitles = useStore((s) => s.chatInitialTitles);
  const listed = useStore((s) => s.threadOrder);
  const momoChats = useStore((s) => s.momoChats);
  const manual = useStore((s) => s.prefs.chatSort === 'manual');
  const open = useStore(useShallow(visibleChats));
  useAdapterTasksRevision();
  const hidden = useNestedHidden(view, parentId);
  const family = familiesOf(v, listed, threads, momoChats, !manual).descendants.get(parentId) ?? NO_ROWS;
  const key = family.join('\n');
  // only this family's members: a delta in another chat leaves these slices shallow-equal
  const runtimes = useStore(useShallow((s) => family.map((id) => rowRuntime(s.runtime[id]))));
  const requests = useStore(useShallow((s) => s.pending.filter((p) => family.includes(p.threadId as string))));
  const elsewheres = useStore(useShallow((s) => family.map((id) => s.elsewhere[id])));
  const unreads = useStore(useShallow((s) => family.map((id) => !!s.unread[id])));
  const handoffs = useStore(useShallow((s) => family.map((id) => !!chatAgentTabs(s.agentTabs, id, chatOf)?.tabs.some((t) => t.signin))));
  // Hidden rows do not mount, so the family itself asks main for their status snapshots.
  useEffect(() => {
    if (key) for (const id of key.split('\n')) ensureSession(id);
  }, [key]);
  // each member's state is derived in the selector: a session patch or delta that changes no member's state renders nothing
  const states = useSessions(
    useShallow((all) =>
      family.map((id, at) =>
        chatRowState({
          thread: threads[id],
          session: all.sessions[id] ?? EMPTY_SESSION,
          runtime: runtimes[at],
          requests,
          adapterTasks: adapterTasksOf(id),
          elsewhere: elsewheres[at],
          unread: unreads[at],
          linked: v.children[id],
          asks: !!v.wrapUps?.[id]?.ask || handoffs[at],
        }),
      ),
    ),
  );
  const stateOf = (id: string) => states[family.indexOf(id)];
  const kept = hidden
    ? family.filter((id) => ['approval', 'input'].includes(stateOf(id)) || id === activeThread || open.includes(id))
    : family;
  const tucked = family.filter((id) => !kept.includes(id));
  const counts: NestedCounts = { input: 0, failed: 0, unread: 0, working: 0 };
  for (const id of tucked) {
    const tally = nestedTally(stateOf(id));
    if (tally) counts[tally] += 1;
  }
  if (!family.length) return null;
  return (
    <div className="side-children" role="group" aria-label="Sessions this chat started">
      {kept.map((id) => (
        <ThreadRow
          key={id}
          thread={threads[id]}
          active={id === activeThread}
          depth={1}
          projectHostId={projectHostId}
          startedBy={threadTitle(threads[v.children[id].parentId], initialTitles)}
        />
      ))}
      {tucked.length > 0 && (
        <HiddenSummary ids={tucked} counts={counts} more={kept.length > 0} onShow={() => setNestedHidden(view, [parentId], false)} />
      )}
    </div>
  );
}

/** Hidden sessions count failed, unread and working states; attention rows remain directly accessible. */
function HiddenSummary({ ids, counts, more, onShow }: { ids: string[]; counts: NestedCounts; more: boolean; onShow: () => void }) {
  const summary = nestedSummary(ids.length, counts, more);
  return (
    <button
      type="button"
      className="side-row nested-summary linked-child"
      style={{ '--depth': 1 } as CSSProperties}
      aria-label={summary.aria}
      onClick={onShow}
    >
      <span className="side-row-label">
        {summary.label}
        {summary.parts.map((p) => (
          <span key={p.kind} className={`nested-summary-part ${p.kind}`}>
            <span className="nested-summary-sep" aria-hidden>
              ·
            </span>
            {p.kind === 'unread' && <span className="row-dot unread" aria-hidden />}
            {p.text}
          </span>
        ))}
      </span>
      {counts.failed > 0 && (
        <span className="row-status error" aria-hidden>
          <CircleAlert size={16} />
        </span>
      )}
    </button>
  );
}

/** A list's "Hide all nested sessions" (or Show all, once every one is hidden), where several of its chats have some. */
export function NestedAllItem({ parents, view }: { parents: string[]; view: NestedView }) {
  const v = useSidebarLineage();
  const listed = useStore((s) => s.threadOrder);
  const momoChats = useStore((s) => s.momoChats);
  const keys = useNestedHiddenKeys();
  const nesting = parents.filter(
    (id) =>
      !isMomoChat(momoChats, id) && linkedChildren(v, id).some((kid) => kid !== id && listed.includes(kid) && !isMomoChat(momoChats, kid)),
  );
  if (nesting.length < 2) return null;
  const hide = nesting.some((id) => !hiddenIn(keys, view, id));
  return (
    <MenuItem
      icon={hide ? <ChevronsDownUp size={15} /> : <ChevronsUpDown size={15} />}
      onSelect={() => setNestedHidden(view, nesting, hide)}
    >
      {hide ? 'Hide all nested sessions' : 'Show all nested sessions'}
    </MenuItem>
  );
}

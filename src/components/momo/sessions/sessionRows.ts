// What MoMo's Sessions pane lists (M6): the user's other chats, each in one of the design's three groups by the one status every harness shares (chatRowState), with where it runs and which harness it is on. Pure: the hook (useSessionRows.ts) reads the stores and hands this plain data, so the grouping is the same on Claude Code, Codex and basic harnesses, on a mixed list of them, and for a chat on a machine whose window is closed.
import { chatRowStatus, type ChatRowInputs, type ChatRowState } from '../../../session/chatRowState';
import type { SessionState } from '../../../store/session/sessionState';
import { SHELL_COPY } from '../shell/shellCopy';

/** The groups, in the order they are drawn. */
export const SESSION_GROUPS = ['needs', 'working', 'wait'] as const;
export type SessionGroup = (typeof SESSION_GROUPS)[number];

/** The group's heading. */
export const GROUP_TITLE: Record<SessionGroup, string> = {
  needs: SHELL_COPY.sessionsNeeds,
  working: SHELL_COPY.sessionsWorking,
  wait: SHELL_COPY.sessionsWait,
};

/** The group a state belongs to; null for a chat with nothing open (idle, or one that only opens in another app), which the pane leaves out. */
export function groupOf(state: ChatRowState): SessionGroup | null {
  switch (state) {
    case 'approval':
    case 'input':
      return 'needs';
    case 'working':
    case 'elsewhereRunning':
      return 'working';
    case 'error':
    case 'failed':
    case 'unread':
    case 'done':
      return 'wait';
    default:
      return null;
  }
}

/** A chat as the pane draws it. */
export type SessionRow = {
  id: string;
  title: string;
  group: SessionGroup;
  /** what the harness is called, from its own record */
  harness: string;
  /** where it runs: "This Mac", a machine's name, or the machine's name with "away" while it is offline */
  where: string;
};

/** A machine a chat runs on; null is this Mac (also while main has not said which chats are on machines: none is said to be elsewhere before it is known). */
export type Place = { name: string; away: boolean } | null;

export type SessionInputs = {
  /** the chats to consider, in the sidebar's order: roots only */
  ids: readonly string[];
  /** each chat's own inputs for its status; null for a chat the store does not know */
  inputs: (id: string) => (Omit<ChatRowInputs, 'session'> & { session: SessionState | undefined }) | null;
  title: (id: string) => string;
  harness: (id: string) => string;
  place: (id: string) => Place;
};

/** The pane's rows: every listed chat that has something open, in its list order. */
export function sessionRows({ ids, inputs, title, harness, place }: SessionInputs): SessionRow[] {
  const rows: SessionRow[] = [];
  for (const id of ids) {
    const given = inputs(id);
    if (!given) continue;
    const group = groupOf(chatRowStatus(given).state);
    if (!group) continue;
    const at = place(id);
    rows.push({
      id,
      title: title(id),
      group,
      harness: harness(id),
      where: !at ? SHELL_COPY.sessionsHere : at.away ? SHELL_COPY.sessionsAway(at.name) : at.name,
    });
  }
  return rows;
}

/** The rows of each group, groups with none left out. */
export function byGroup(rows: readonly SessionRow[]): { group: SessionGroup; rows: SessionRow[] }[] {
  return SESSION_GROUPS.map((group) => ({ group, rows: rows.filter((r) => r.group === group) })).filter((g) => g.rows.length > 0);
}

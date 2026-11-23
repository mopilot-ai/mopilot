// The shape of momo.tasks.list when the Mac has the four-tab panel on (`v: 2`, electron/momo/tasksPanel.cjs), and of momo.tasks.mark's answer, checked before the page draws them; a row that is not one is left out, a reply that is not a list throws, and a v1 reply is no panel (null).
import { channelOf } from './tasksContract';

export type PanelTab = 'active' | 'next' | 'scheduled' | 'resolved';
export type PanelState = 'needs-you' | 'running' | 'failed' | 'review' | 'queued' | 'scheduled' | 'done' | 'dismissed' | 'archived';
export type PanelTask = {
  id: string;
  kind: 'card' | 'loop' | 'run' | 'routine' | 'brief';
  tab: PanelTab;
  state: PanelState;
  title: string;
  detail: string | null;
  dueDay: string | null;
  /** what the source's own method takes: a loop's id, a card's id, a run's chat id, a routine's id */
  ref: string;
  /** when it started, ended, was said or closed */
  at: number | null;
  /** how a run ended: completed, stopped, failed or interrupted */
  outcome: string | null;
  nextAt: number | null;
  paused: boolean;
  /** a card waiting in a channel (A2): that channel; null for main's cards and every other kind */
  channel: { id: string; name: string } | null;
};
export type PanelView = { tasks: PanelTask[]; paused: boolean; now: number };
export type PanelMark = 'done' | 'archive' | 'delete' | 'reopen';

/** Whether the Mac lists the user's mark: a Mac that does not keeps the classic Tasks list. */
export const MARK_METHOD = 'momo.tasks.mark';

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const KINDS: ReadonlySet<unknown> = new Set(['card', 'loop', 'run', 'routine', 'brief']);
const TABS: ReadonlySet<unknown> = new Set(['active', 'next', 'scheduled', 'resolved']);
const STATES: ReadonlySet<unknown> = new Set([
  'needs-you',
  'running',
  'failed',
  'review',
  'queued',
  'scheduled',
  'done',
  'dismissed',
  'archived',
]);

/** The four-tab list of a `v: 2` reply, or null for the classic list (no `v`). */
export function parseTaskPanel(value: unknown): PanelView | null {
  const v = record(value);
  if (!v || !Array.isArray(v.tasks)) throw new Error('Could not read the tasks.');
  if (v.v !== 2) return null;
  const tasks = v.tasks.flatMap((t): PanelTask[] => {
    const r = record(t);
    const id = text(r?.id);
    const title = text(r?.title);
    const ref = text(r?.ref);
    if (!r || !id || !title || !ref || !KINDS.has(r.kind) || !TABS.has(r.tab) || !STATES.has(r.state)) return [];
    return [
      {
        id,
        kind: r.kind as PanelTask['kind'],
        tab: r.tab as PanelTab,
        state: r.state as PanelState,
        title,
        detail: text(r.detail),
        dueDay: text(r.dueDay),
        ref,
        at: num(r.at),
        outcome: text(r.outcome),
        nextAt: num(r.nextAt),
        paused: r.paused === true,
        channel: channelOf(r.channel),
      },
    ];
  });
  return { tasks, paused: v.paused === true, now: num(v.now) ?? 0 };
}

/** `momo.tasks.mark`'s answer: the token that takes the mark back, when there is one. */
export function parseMarked(value: unknown): { undoToken: string | null } {
  return { undoToken: text(record(value)?.undoToken) };
}

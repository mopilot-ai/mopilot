// The shape of momo.tasks.list (the Mac's Tasks list, electron/momo/tasks.cjs), checked before the page draws it; a row that is not one is left out, a reply that is not a list throws.
export type Task = {
  id: string;
  kind: 'run' | 'loop' | 'card';
  state: 'running' | 'needs-you';
  title: string;
  detail: string | null;
  dueDay: string | null;
  /** what the source's own method takes: a loop's id (momo.loops.act), a card's id, a run's chat id */
  ref: string;
  /** a card waiting in a channel (A2): that channel; null for main's cards and every other kind */
  channel: { id: string; name: string } | null;
};

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
/** The channel a card waits in (id and name), or null: main's cards and every other kind name none, and a half-named one is none. */
export const channelOf = (value: unknown): { id: string; name: string } | null => {
  const r = record(value);
  const id = text(r?.id);
  const name = text(r?.name);
  return id && name ? { id, name } : null;
};
const KINDS: ReadonlySet<unknown> = new Set(['run', 'loop', 'card']);
const STATES: ReadonlySet<unknown> = new Set(['running', 'needs-you']);

/** Whether the Mac lists the method: a Mac that does not shows no Tasks. */
export const TASKS_METHOD = 'momo.tasks.list';

/** `momo.tasks.list`: the tasks in the order the Mac gave (the ones that need you first). */
export function parseTasks(value: unknown): Task[] {
  const v = record(value);
  if (!v || !Array.isArray(v.tasks)) throw new Error('Could not read the tasks.');
  return v.tasks.flatMap((t) => {
    const r = record(t);
    const id = text(r?.id);
    const title = text(r?.title);
    const ref = text(r?.ref);
    if (!r || !id || !title || !ref || !KINDS.has(r.kind) || !STATES.has(r.state)) return [];
    return [
      {
        id,
        kind: r.kind as Task['kind'],
        state: r.state as Task['state'],
        title,
        detail: text(r.detail),
        dueDay: text(r.dueDay),
        ref,
        channel: channelOf(r.channel),
      },
    ];
  });
}

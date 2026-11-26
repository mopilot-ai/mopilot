// Normalize phone snapshots and live item events into a single displayable thread.
import type { Sent } from './sentMessages';
import { unread } from '../../../electron/chrome-extension/src/panelPreview.mjs';
import { callIdOf, liveStep, savedExtras, type StepExtras } from './stepRows';
import { stepFacts, type Kind } from './toolRuns';
export type Data = Record<string, unknown>;
type FeedEvent = {
  ev?: string;
  rev?: number;
  feedSeq?: number;
  live?: boolean;
  patch?: Data;
  status?: string | null;
  turnId?: string | null;
  started?: boolean;
  items?: Data[];
  itemId?: string | number;
  field?: string;
  text?: string;
  index?: number;
  cards?: unknown;
};
type SnapshotInput = {
  items: Data[];
  session: Data;
  rev: number;
  itemsShape: string;
  history?: Data[];
  liveTurn?: { id?: string; status?: string };
  historyStale?: boolean;
  /** What the chat's saved history started as (the Mac's `historyEpoch`): it changes when the history was compacted or replaced. */
  historyEpoch?: unknown;
  liveUnavailable?: boolean;
  feedSeq?: number;
};
export type Thread = {
  rev: number;
  session: Data;
  items: Data[];
  shape: string;
  feedSeq: number;
  history: Data[];
  liveTurn: string | null;
  liveTurnStatus: string | null;
  historyStale: boolean;
  liveUnavailable: boolean;
  /** The Mac's name for what the history started as; absent from a Mac that sends none. */
  epoch?: string;
};
/** A row of the transcript; a step also says what kind of step it was, how long it took and how far it got, where that is known. */
export type Row = {
  role: string;
  text: string;
  optimistic?: boolean;
  pictures?: string[];
  clientId?: string;
  id?: string;
  kind?: Kind;
  ms?: number | null;
  /** how many pictures a message of yours carries, and the id the computer finds them by (messages.image) */
  images?: number;
  messageId?: string;
} & StepExtras;

/** The pictures a message of yours carries: how many, and the id to ask the computer for them by; none when it has no usable id. */
function picturesOf(count: number, id: unknown): { images?: number; messageId?: string } {
  const named = typeof id === 'string' && id && id.length <= 2048 ? id : undefined;
  return Number.isSafeInteger(count) && count > 0 && named ? { images: Math.min(count, 99), messageId: named } : {};
}
/** An answer that is not a chat snapshot (a computer whose MoPilot this phone cannot read). */
export const UNREADABLE = 'The chat could not be read. Try again.';
export function snapshot(value: unknown): Thread {
  const input = value as Partial<SnapshotInput> | null;
  if (!input || !Array.isArray(input.items) || !input.session || typeof input.rev !== 'number') throw new Error(UNREADABLE);
  return {
    rev: input.rev,
    session: { ...input.session, turnStatus: input.session.turn },
    items: input.items,
    shape: input.itemsShape ?? 'rows',
    history: Array.isArray(input.history) ? input.history : [],
    liveTurn: typeof input.liveTurn?.id === 'string' ? input.liveTurn.id : null,
    liveTurnStatus: typeof input.liveTurn?.status === 'string' ? input.liveTurn.status : null,
    historyStale: input.historyStale === true,
    liveUnavailable: input.liveUnavailable === true,
    feedSeq: typeof input.feedSeq === 'number' ? input.feedSeq : -1,
    ...(typeof input.historyEpoch === 'string' && input.historyEpoch ? { epoch: input.historyEpoch } : {}),
  };
}
export function update(thread: Thread, input: Data): Thread {
  const event = input as FeedEvent;
  if (event.ev === 'session.patch') {
    if (typeof event.rev !== 'number' || event.rev <= thread.rev) return thread;
    const session = { ...thread.session, ...event.patch };
    if (event.patch && Object.hasOwn(event.patch, 'turn')) session.turnStatus = event.patch.turn;
    return { ...thread, rev: event.rev, session };
  }
  if (event.ev && ['turn.state', 'items.append', 'items.replace', 'items.delta'].includes(event.ev)) {
    if (typeof event.feedSeq !== 'number' || !Number.isSafeInteger(event.feedSeq) || thread.feedSeq < 0)
      throw new Error('Live updates need a newer MoPilot on your computer.');
    if (event.feedSeq <= thread.feedSeq) return thread;
    thread = { ...thread, feedSeq: event.feedSeq };
    if (event.live === false) return { ...thread, historyStale: true };
  }
  if (event.ev === 'cards.changed') {
    // the Mac's hand-offs began or ended: the cards it sends are the whole list, as at a snapshot
    if (typeof event.rev !== 'number' || event.rev < thread.rev || !Array.isArray(event.cards)) return thread;
    return { ...thread, rev: event.rev, session: { ...thread.session, cards: event.cards } };
  }
  if (event.ev === 'turn.state') {
    const starts = event.status === 'inProgress' || event.status === 'running';
    const nextId = typeof event.turnId === 'string' ? event.turnId : null;
    if (
      starts &&
      (nextId !== thread.liveTurn ||
        (event.started === true && thread.liveTurnStatus !== 'inProgress' && thread.liveTurnStatus !== 'running'))
    ) {
      // Reconcile by identity before retiring the turn; preserve saved metadata and end running steps.
      const history = mergedRows(thread).map(({ state, ...r }) => ({
        ...r,
        ...(state === 'failed' ? { state } : {}),
        role: r.role === 'preview' ? 'assistant' : r.role === 'liveUser' ? 'user' : r.role === 'live' ? 'step' : r.role,
      }));
      return {
        ...thread,
        history,
        items: [],
        shape: 'items',
        liveTurn: nextId,
        liveTurnStatus: event.status!,
        session: { ...thread.session, turnStatus: event.status },
      };
    }
    return { ...thread, liveTurnStatus: event.status ?? null, session: { ...thread.session, turnStatus: event.status } };
  }
  if (event.ev === 'items.append' || event.ev === 'items.replace') {
    const items = thread.shape === 'rows' ? [] : [...thread.items];
    const history = thread.shape === 'rows' ? thread.items : thread.history;
    for (const item of Array.isArray(event.items) ? event.items : []) {
      const at = items.findIndex((existing) => existing.id === item.id);
      if (at < 0) items.push(item);
      else items[at] = item;
    }
    return { ...thread, shape: 'items', history, items };
  }
  if (event.ev === 'items.delta' && typeof event.text === 'string') {
    return {
      ...thread,
      items: thread.items.map((item) => {
        if (item.id !== event.itemId) return item;
        if (event.field === 'text') return { ...item, text: `${item.text ?? ''}${event.text}` };
        if (
          event.field === 'summary' &&
          typeof event.index === 'number' &&
          Number.isInteger(event.index) &&
          event.index >= 0 &&
          event.index < 1000
        ) {
          const summary = [...(Array.isArray(item.summary) ? item.summary : [])];
          summary[event.index] = `${summary[event.index] ?? ''}${event.text}`;
          return { ...item, summary };
        }
        return item;
      }),
    };
  }
  return thread;
}
export function row(item: Data, shape: string): Row {
  if (shape === 'rows') {
    const out = { role: String(item.role ?? 'step'), text: String(item.text ?? '') };
    if (out.role === 'user')
      return {
        ...out,
        ...(typeof item.clientId === 'string' ? { clientId: item.clientId } : {}),
        ...picturesOf(Number(item.images) || 0, item.id),
      };
    return out.role === 'step' ? { ...out, ...stepFacts(item, out.text, false), ...savedExtras(item) } : out;
  }
  const type = item.type;
  if (type === 'userMessage') {
    const content: Data[] = Array.isArray(item.content) ? item.content : [];
    return {
      role: 'user',
      ...(typeof item.clientId === 'string' ? { clientId: item.clientId } : {}),
      text: content
        .filter((v: Data) => v.type === 'text')
        .map((v: Data) => v.text)
        .join('\n'),
      ...picturesOf(content.filter((v: Data) => v.type === 'image' || v.type === 'localImage').length, item.messageId ?? item.id),
    };
  }
  if (type === 'agentMessage') return { role: 'assistant', text: String(item.text ?? '') };
  const text =
    typeof item.text === 'string'
      ? item.text
      : Array.isArray(item.summary)
        ? item.summary.join('\n')
        : (item.description ?? item.command ?? item.type ?? 'Activity');
  const step = liveStep(item, typeof text === 'string' ? text : JSON.stringify(text));
  return { role: 'step', ...step, ...stepFacts(item, step.text, true), ...callIdOf(item) };
}

/** Merge live items in event order, replacing matching history in place and retaining saved metadata. */
/** A saved item's row, made once: the same item gives the same row object on every commit, so a streamed delta leaves the rows around it equal by identity. */
const savedRows = new WeakMap<Data, Row & Data>();
const savedRow = (item: Data): Row & Data => {
  let made = savedRows.get(item);
  if (!made) {
    made = { ...item, ...row(item, 'rows'), ...(typeof item.phoneId === 'string' ? { id: item.phoneId } : {}) };
    savedRows.set(item, made);
  }
  return made;
};
function mergedRows(thread: Thread): (Row & Data)[] {
  const history = thread.shape === 'rows' ? thread.items : thread.history;
  const rows: (Row & Data)[] = history.map(savedRow);
  if (thread.shape === 'rows') return rows;
  const identity = (item: Data) => (typeof item.rowId === 'string' ? item.rowId : item.id);
  for (const [index, item] of thread.items.entries()) {
    const id = identity(item);
    const at = id == null ? -1 : rows.findIndex((saved) => saved.id === id);
    const r = row(item, 'items');
    if (at >= 0) {
      const saved = rows[at];
      // The history read can be newer than the live ring. An older streamed prefix cannot truncate it.
      const text = r.role === 'assistant' && saved.text.startsWith(r.text) ? saved.text : r.text;
      const { state: _state, ...previous } = saved;
      rows[at] = { ...previous, ...r, text, role: saved.role, id: saved.id };
      continue;
    }
    // Compatibility with older Macs which do not send cross-source identities.
    const text =
      r.role === 'assistant' && typeof item.rowId !== 'string'
        ? unread(
            r.text,
            history.map((item) => row(item, 'rows')),
            { joined: true },
          )
        : r.text;
    if (r.role === 'assistant' && !text.trim()) continue;
    const live = {
      ...r,
      text,
      ...(typeof item.rowId === 'string' ? { id: item.rowId } : r.role === 'assistant' ? { id: String(item.id) } : {}),
      role: r.role === 'assistant' ? 'preview' : r.role === 'user' ? 'liveUser' : 'live',
    };
    // A saved snapshot need not be a prefix (a ring can be clipped). Use the next known live identity as an anchor.
    const following = new Set(
      thread.items
        .slice(index + 1)
        .map(identity)
        .filter((value) => value != null),
    );
    const before = rows.findIndex((saved) => saved.id != null && following.has(saved.id));
    rows.splice(before < 0 ? rows.length : before, 0, live);
  }
  return rows;
}

export function displayRows(thread: Thread): Row[] {
  return mergedRows(thread);
}

export function progress(status: unknown): string {
  return status === 'running' || status === 'inProgress' ? 'Working…' : status === 'awaitingUser' ? 'Waiting for you' : '';
}

// Stateless transcript rows use their content and occurrence to distinguish repeated messages without index keys. A live
// reply ('preview') is keyed by its item's id, so it keeps one key while it grows (not drawn anew with every delta, its reveal
// can pace it) and several replies of a turn stay apart.
export function keyedRows(rows: Row[]): (Row & { key: string })[] {
  const counts = new Map<string, number>();
  return rows.map((value) => {
    if (value.id) return withKey(value, JSON.stringify(['item', value.id]));
    if (value.role === 'preview') return withKey(value, JSON.stringify(['preview']));
    const role = value.role === 'liveUser' ? 'user' : value.role === 'live' ? 'step' : value.role;
    const base = JSON.stringify([role, value.text]);
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    return withKey(value, JSON.stringify([base, count]));
  });
}

/** A row with its key, made once per row and key: the same row at the same place gives the same object, so what shows it can skip a commit that did not change it. */
const keyedOnce = new WeakMap<Row, { key: string; keyed: Row & { key: string } }>();
function withKey(value: Row, key: string): Row & { key: string } {
  const known = keyedOnce.get(value);
  if (known?.key === key) return known.keyed;
  const keyed = { ...value, key };
  keyedOnce.set(value, { key, keyed });
  return keyed;
}

/** Pending sends keep their place ahead of later Mac activity, anchored to the last row visible at the tap. */
export function withPendingRows(rows: (Row & { key: string })[], pending: Sent[]): (Row & { key: string })[] {
  const result = [...rows];
  // Reverse insertion preserves the order of sends sharing an anchor.
  for (const sent of [...pending].reverse()) {
    const anchor = sent.after ? result.findIndex((r) => r.key === sent.after) : -1;
    result.splice(anchor + 1, 0, {
      role: 'user',
      text: sent.text,
      key: `sent:${sent.id ?? sent.base}`,
      optimistic: true,
      ...(sent.pictures ? { pictures: sent.pictures } : {}),
    });
  }
  return result;
}

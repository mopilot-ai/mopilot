// Milliseconds from the app's launch to each step of getting the chat list on screen, and from a chat's opening to its first rows: kept for the last few launches and opens so Settings › About can show where a slow start went. Timings only, never a title, a message or an id.

/** One launch or one chat open: when it began and the steps reached, each in ms after its start. */
export type SendTraceOwner = {
  id: string;
  pairId: string;
  chatId: string;
  momo?: boolean;
};
let sendOwner: SendTraceOwner | undefined;
const sameSend = (a: SendTraceOwner | undefined, b: SendTraceOwner | undefined) =>
  a?.id === b?.id && a?.pairId === b?.pairId && a?.chatId === b?.chatId && (a?.momo === true) === (b?.momo === true);

export type TraceKind = 'launch' | 'chat' | 'send';
export type TraceRecord = {
  kind: TraceKind;
  id: number;
  at: number;
  steps: [string, number][];
};
/** Where records are kept between runs (a table on the device); absent in tests that do not need it. */
export type TraceStore = {
  load(): Promise<TraceRecord[]>;
  save(record: TraceRecord): Promise<void>;
};

export const KEPT = { launch: 5, chat: 10, send: 10 } as const;
/** A launch or open that has not finished is saved this long after it began, so a slow one is not lost. */
export const SAVE_AFTER_MS = 15_000;
/** The steps after which a record is saved at once: the list is on screen, the relay token came back, the list answered (launch); the rows are on screen (chat). */
const SAVES: Record<TraceKind, string[]> = {
  launch: ['list-shown', 'relay-token', 'list-answer'],
  chat: ['rows-shown'],
  // a message is kept once the Mac took it and once its reply began to arrive
  send: ['acked', 'first-delta'],
};

/** The engine's clock counts from the device's boot, so each step is told from the moment this module loaded: the first JS the app runs. */
const now = () => performance.now();
const base = now();

let store: TraceStore | null = null;
/** A timer that does not hold a process open where timers can be told so (node); React Native's timers are numbers and need no telling. */
const later = (fn: () => void, ms: number): unknown => {
  const timer = setTimeout(fn, ms) as unknown as { unref?: () => void };
  timer.unref?.();
  return timer;
};
let schedule: (fn: () => void, ms: number) => unknown = later;
const live: Record<TraceKind, { record: TraceRecord; began: number; timer: unknown } | null> = { launch: null, chat: null, send: null };

/** Writes a record as it stands; it is written again, in place, as it grows. */
const save = (record: TraceRecord) => {
  if (store) void store.save({ ...record, steps: [...record.steps] }).catch(() => undefined);
};

function begin(kind: TraceKind, began: number) {
  // a chat left before its rows came (the slow one worth knowing about) is kept as far as it got, not lost to the next open
  const previous = live[kind];
  if (previous) save(previous.record);
  const record: TraceRecord = {
    kind,
    id: Date.now(),
    at: Date.now(),
    steps: [],
  };
  live[kind] = {
    record,
    began,
    timer: schedule(() => {
      save(record);
      // a message not answered by now is kept as it stands, and later events are not its steps
      if (kind === 'send' && live.send?.record === record) live.send = null;
    }, SAVE_AFTER_MS),
  };
}

/** Notes a launch step once: the first time it is reached is the one that counts. */
export function mark(step: string, at: number = now()) {
  if (!live.launch) begin('launch', base);
  note('launch', step, at);
}

/** Starts a chat open (`open`) or notes a step of the one begun; a step after the open ended is ignored. */
export function markChat(step: string, at: number = now()) {
  if (step === 'open') {
    begin('chat', at);
    return note('chat', step, at);
  }
  if (live.chat) note('chat', step, at);
}

/**
 * A message's way to the screen: `tap` starts a record, then `dispatched` (the request leaves), `mac-done` (the Mac says how long it
 * held the request, as ms after `dispatched`), `acked` (its answer is here), `first-delta` (the first of the reply's rows). A step
 * with no message in flight is ignored; the first of each step counts.
 */
export function markSend(step: string, at: number = now(), owner?: SendTraceOwner) {
  if (step === 'tap') {
    sendOwner = owner;
    begin('send', at);
    return note('send', step, at);
  }
  if (live.send && sameSend(sendOwner, owner)) note('send', step, at);
}

/** What a followed chat's event says of the message in flight: its turn started, the Mac echoed it, the reply's first rows came. */
export function markSendEvent(
  event: { ev?: unknown; status?: unknown; items?: unknown },
  owner?: { pairId: string | null; chatId: string; momo?: boolean },
) {
  if (!live.send) return;
  if (
    sendOwner &&
    (!owner ||
      owner.pairId !== sendOwner.pairId ||
      owner.chatId !== sendOwner.chatId ||
      (owner.momo === true) !== (sendOwner.momo === true))
  )
    return;
  const noteEvent = (step: string) => markSend(step, now(), sendOwner);
  if (event.ev === 'turn.state') return event.status === 'inProgress' || event.status === 'running' ? noteEvent('turn-started') : undefined;
  if (event.ev === 'items.delta') return noteEvent('first-delta');
  if (event.ev !== 'items.append' && event.ev !== 'items.replace') return;
  for (const item of Array.isArray(event.items) ? (event.items as { type?: unknown }[]) : []) {
    if (item?.type === 'agentMessage') noteEvent('first-delta');
    else if (item?.type === 'userMessage') noteEvent('echoed');
  }
}

function note(kind: TraceKind, step: string, at: number) {
  const open = live[kind]!;
  if (open.record.steps.some(([name]) => name === step)) return;
  open.record.steps.push([step, Math.round(at - open.began)]);
  if (SAVES[kind].includes(step)) save(open.record);
  // a message is over once its answer and its reply's first row are both in: a later event is another turn's
  if (kind === 'send' && ['acked', 'first-delta'].every((done) => open.record.steps.some(([name]) => name === done))) live.send = null;
}

/** `vault 120 · account 180 · …` for one record, in the order reached. */
export const lineOf = (record: Pick<TraceRecord, 'steps'>): string => record.steps.map(([step, ms]) => `${step} ${ms}`).join(' · ');

/** The launch in progress as one line (the dev-host tag); empty before anything was noted. */
export const traceLine = (): string => (live.launch ? lineOf(live.launch.record) : '');

/** Connects the device store; what a launch or open reaches from now on is kept. */
export function attachTraceStore(next: TraceStore | null) {
  store = next;
}

/** The saved records, newest first, at most the few kept of each kind. */
export async function loadTrace(): Promise<TraceRecord[]> {
  if (!store) return [];
  try {
    const all = await store.load();
    const newest = (kind: TraceKind) =>
      all
        .filter((r) => r.kind === kind)
        .sort((a, b) => b.id - a.id)
        .slice(0, KEPT[kind]);
    return [...newest('launch'), ...newest('chat'), ...newest('send')];
  } catch {
    return [];
  }
}

/** Forgets everything and lets the clock for saves be replaced (tests). */
export function resetTrace(timer?: (fn: () => void, ms: number) => unknown) {
  live.launch = live.chat = live.send = null;
  sendOwner = undefined;
  store = null;
  schedule = timer ?? later;
}

// The phone's outgoing messages: kept per computer and chat while the computer is away, sent in order once it is back, each under one send id so a message the Mac already took is never sent twice.
import { lostInFlight } from './remote/unconfirmed';
import { markSend } from './launchTrace';
import { channelOfKey } from './momo/channelsContract';

export type QueuedSend = {
  /** The send id the Mac de-duplicates by; it never changes for this message. */
  id: string;
  pairId: string;
  chatId: string;
  text: string;
  attachments: string[];
  /** Device-local previews while this process holds the send; never persisted or transmitted. */
  pictures?: string[];
  images?: number;
  /** Opaque native correlation survives restore independently of local preview bytes. */
  nativeId?: string;
  /** The skills the message carries beside its text (the / menu of a Codex chat); absent when it has none. */
  skills?: string[];
  /** A message for MoMo's main chat: it goes out as momo.chat.send. */
  momo?: true;
  at: number;
  /** queued: waiting for the computer; sending: in flight; failed: the computer or its harness refused it (Retry or Cancel). */
  status: 'queued' | 'sending' | 'failed';
  error: string | null;
  /** Stable wire code, retained across retries and device restoration. */
  errorCode?: string;
  /** Earlier delivery may have happened; a later failure cannot prove otherwise. */
  uncertain?: true;
  /** Only Cancel is left: sending it again would not be safe. */
  final?: boolean;
  /** Read back after the app was closed: it is never sent without the send id, and never by itself if it was in flight. */
  restored?: boolean;
  /** It has been in flight at least once, so the computer may hold it: its words are never changed, whatever its status is now. */
  attempted?: boolean;
};

/** How long a message may wait on the phone: the Mac keeps what it answers a repeat with for a week, so a message older than that could be taken twice. */
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** How many messages may wait at once. */
export const MAX_QUEUED = 100;
const CLOCK_SLACK_MS = 5 * 60 * 1000;
export const STALE = 'This message waited longer than a week. Copy it if you still need it, then cancel it.';
export const NO_ID =
  'This computer cannot take messages typed before the app was closed. Update MoPilot on it; copy this message, then cancel it.';
export const FILES_LOST = 'Its attachments were not kept. Send the text, or cancel.';
export const WAS_SENDING = 'The app closed while this was sending. Check the chat, then send it again if it is missing.';

const ID = /^[\w-]{8,64}$/;
/** A skill's name and how many a message carries, as the computer accepts them. */
const SKILL = /^[\w:.-]{1,100}$/;
const MAX_SKILLS = 10;

/** What a message asks of the computer, without its send id and deadline. */
export const sendParams = (item: QueuedSend) => ({
  chatId: item.chatId,
  text: item.text,
  attachments: item.attachments,
  ...(item.skills ? { skills: item.skills } : {}),
});

export const savedItems = (items: QueuedSend[]) => items.map(({ pictures: _pictures, ...item }) => item);

/** The request that takes a message: MoMo's own method for a MoMo message (its id is the Mac's de-duplication key), else chat.send. */
export const sendCall = (item: QueuedSend, withSendId: boolean, deadline: number): [string, Record<string, unknown>] =>
  item.momo
    ? [
        'momo.chat.send',
        { id: item.id, text: item.text, followUp: 'queue', ...(channelOfKey(item.chatId) ? { channelId: channelOfKey(item.chatId) } : {}) },
      ]
    : ['chat.send', { ...sendParams(item), ...(withSendId ? { sendId: item.id } : {}), deadline }];

/** What a message carries beside its words when it is queued. */
export const sendExtras = (skills: string[], momo?: true) => ({ ...(skills.length ? { skills } : {}), ...(momo ? { momo } : {}) });

/** The skill names saved with a message, if they are names the computer would take. */
const skillsOf = (saved: unknown) => {
  const names = Array.isArray(saved) ? saved.filter((n): n is string => typeof n === 'string' && SKILL.test(n)).slice(0, MAX_SKILLS) : [];
  return names.length ? { skills: names } : {};
};

/** The messages saved before the app closed, made ready to wait again; anything unreadable, for a computer that is gone or beyond the limits is left out. */
export function restoreItems(saved: unknown, o: { now: number; pairs: Set<string> }): QueuedSend[] {
  if (!Array.isArray(saved)) return [];
  const out: QueuedSend[] = [];
  for (const raw of saved as Array<Partial<QueuedSend> | null>) {
    if (out.length >= MAX_QUEUED) break;
    if (!raw || typeof raw.id !== 'string' || !ID.test(raw.id) || typeof raw.text !== 'string' || typeof raw.chatId !== 'string') continue;
    if (typeof raw.pairId !== 'string' || !o.pairs.has(raw.pairId) || !Number.isFinite(raw.at)) continue;
    const item: QueuedSend = {
      id: raw.id,
      pairId: raw.pairId,
      chatId: raw.chatId,
      text: raw.text,
      attachments: [],
      ...skillsOf(raw.skills),
      ...(typeof raw.nativeId === 'string' && /^[a-f0-9-]{36}$/.test(raw.nativeId) ? { nativeId: raw.nativeId } : {}),
      ...(Number.isInteger(raw.images) && raw.images! > 0 && raw.images! <= 10 ? { images: raw.images } : {}),
      ...(typeof raw.errorCode === 'string' ? { errorCode: raw.errorCode } : {}),
      ...(raw.uncertain === true ? { uncertain: true as const } : {}),
      ...(raw.momo === true ? { momo: true as const } : {}),
      at: raw.at as number,
      status: 'queued',
      error: null,
      restored: true,
      ...(raw.attempted === true ? { attempted: true } : {}),
    };
    // a time far ahead of the clock is a clock that was wrong when it was typed, so its age is not known
    if (o.now - item.at > MAX_AGE_MS || item.at - o.now > CLOCK_SLACK_MS)
      Object.assign(item, { status: 'failed', error: STALE, final: true });
    else if (raw.status === 'sending') Object.assign(item, { status: 'failed', error: WAS_SENDING });
    else if (Array.isArray(raw.attachments) && raw.attachments.length) Object.assign(item, { status: 'failed', error: FILES_LOST });
    else if (raw.status === 'failed')
      Object.assign(item, {
        status: 'failed',
        error: typeof raw.error === 'string' ? raw.error : WAS_SENDING,
        final: raw.final === true,
      });
    out.push(item);
  }
  return out;
}

/** What an older computer, which cannot recognise a send it already took, is never asked to guess about. */
export const UNSURE = 'The connection dropped while this was sending. Check the chat, then send it again if it is missing.';
const UNCONFIRMED = 'This message may have reached the chat. Check the chat before explicitly choosing whether to send another message.';

/** A message whose fate is not known (it may or may not have arrived): shown as "not confirmed", never as "not sent". */
export const isUnconfirmed = (item: Pick<QueuedSend, 'status' | 'error' | 'uncertain'>) =>
  item.status === 'failed' && (item.uncertain === true || item.error === UNSURE || item.error === WAS_SENDING);

/** A typed server uncertainty or unfamiliar code never becomes a false assertion of non-delivery. */
function failedSend(error: unknown, wasUncertain?: true, fallback = 'The message was not sent.'): Partial<QueuedSend> {
  const value = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  const code = typeof value === 'string' ? value : undefined;
  // the last four are a Host's refusals before it did anything (host/src/ledger.mjs NOT_DONE): the message was not taken, and the same one may be sent again
  const safe = [
    'invalid',
    'forbidden',
    'gone',
    'failed',
    'send_unavailable',
    'send_capacity',
    'send_conflict',
    'stale',
    'unsupported',
    'harness_not_configured',
    'directory_missing',
    'unknown_client',
  ];
  const uncertain = wasUncertain === true || (code !== undefined && !safe.includes(code));
  return {
    status: 'failed',
    error: uncertain ? UNCONFIRMED : error instanceof Error ? error.message : fallback,
    ...(code === undefined ? {} : { errorCode: code }),
    ...(uncertain ? { uncertain: true as const } : {}),
    ...(uncertain || code === 'send_conflict' || code === 'stale' ? { final: true } : {}),
  };
}

export function createOutbox(o: {
  /** Whether the computer is connected right now. */
  online(pairId: string): boolean;
  /** Sends one message and resolves when the computer accepted it. */
  send(item: QueuedSend): Promise<unknown>;
  /** The connection went away under the request, so the message may be sent again; any other error is the computer's answer. */
  lost(error: unknown): boolean;
  /** Whether this computer answers a repeated send id once; one that does not must never be sent a message that may already have arrived. */
  idempotent(pairId: string): boolean;
  /** Learns what the computer can do before the first message goes to it; false when the connection went meanwhile. */
  ready(pairId: string): Promise<boolean>;
  identity?(item: { pairId: string; chatId: string }, id: string): string | undefined;
  newId(): string;
  now(): number;
  onChange(items: QueuedSend[]): void;
}) {
  let items: QueuedSend[] = [];
  /** One active pass per full conversation owner; a flush during its awaits requests another pass. */
  const running = new Map<string, { pairId: string; run: Promise<void> }>();
  const wanted = new Set<string>();
  const probes = new Map<string, Promise<boolean>>();
  const readyFor = (pairId: string) => {
    const pending = probes.get(pairId);
    if (pending !== undefined) return pending;
    const probe = Promise.resolve()
      .then(() => o.ready(pairId))
      .finally(() => {
        if (probes.get(pairId) === probe) probes.delete(pairId);
      });
    probes.set(pairId, probe);
    return probe;
  };
  const ownerOf = (item: { pairId: string; chatId: string; momo?: boolean }) =>
    JSON.stringify([item.pairId, item.chatId, item.momo === true]);
  const set = (next: QueuedSend[]) => {
    items = next;
    o.onChange(items);
  };
  const patch = (id: string, fields: Partial<QueuedSend>) => set(items.map((item) => (item.id === id ? { ...item, ...fields } : item)));
  const has = (id: string) => items.some((item) => item.id === id);
  // The Mac's dedicated MoMo ledger does not enable replay until this client verifies pinned-target persistence and recovery.
  const canReplay = (item: QueuedSend) => !item.momo && o.idempotent(item.pairId);

  /** One pass in order; a refused message holds back every later one of its chat until it is sent again or cancelled, so none overtakes it. */
  async function pass(pairId: string, owner: string, current: () => boolean) {
    while (current()) {
      if (items.some((item) => ownerOf(item) === owner && item.status === 'failed')) return;
      const next = items.find((item) => ownerOf(item) === owner && item.status === 'queued');
      if (!next || !o.online(pairId)) return;
      markSend('ready-sent', performance.now(), next);
      let ready: boolean;
      try {
        ready = await readyFor(pairId);
      } catch (error) {
        if (!current()) return;
        if (!has(next.id)) continue;
        // the computer did not say what it can do: the message is not sent blind, and can be sent again
        patch(next.id, failedSend(error, next.uncertain, 'The computer did not answer.'));
        continue;
      }
      if (!current() || !ready) return;
      markSend('ready-answered', performance.now(), next);
      // whatever changed while the computer was asked (a cancel, an edit) is looked at again, and the message goes as it is now
      const fresh = items.find((item) => item.id === next.id);
      if (!o.online(pairId) || !fresh || fresh.status !== 'queued') continue;
      // a message from before the app closed goes only to a computer that answers a repeat of its id once
      if (fresh.restored && !canReplay(fresh)) {
        patch(next.id, { status: 'failed', error: NO_ID, final: true });
        continue;
      }
      patch(next.id, { status: 'sending', error: null, attempted: true });
      try {
        const dispatched = performance.now();
        markSend('dispatched', dispatched, fresh);
        const reply = await o.send({
          ...fresh,
          status: 'sending',
          error: null,
          attempted: true,
        });
        // the Mac says how long it held the request: that part of the wait was not the network's
        const held = (reply as { tookMs?: unknown } | null)?.tookMs;
        if (typeof held === 'number') markSend('mac-done', dispatched + held, fresh);
        markSend('acked', performance.now(), fresh);
      } catch (error) {
        if (!has(next.id)) continue;
        const failure = failedSend(error, fresh.uncertain);
        if (failure.errorCode !== undefined) {
          patch(next.id, failure);
          continue;
        }
        if (o.lost(error)) {
          if (canReplay(fresh)) return patch(next.id, { status: 'queued', uncertain: true });
          // an older computer would take the message a second time: the person decides
          patch(next.id, { status: 'failed', error: UNSURE, uncertain: true });
          continue;
        }
        // a request cut off by the computer not answering may have arrived (the connection is up, so it is not sent again by itself)
        if (lostInFlight(error)) patch(next.id, { status: 'failed', error: UNSURE, uncertain: true });
        else patch(next.id, failure);
        continue;
      }
      // cleared or dropped while it was in flight: nothing left to update
      if (has(next.id)) set(items.filter((item) => item.id !== next.id));
    }
  }
  async function flush(pairId: string) {
    const owners = new Set(items.filter((item) => item.pairId === pairId).map(ownerOf));
    await Promise.all(
      [...owners].map((owner) => {
        wanted.add(owner);
        const active = running.get(owner);
        if (active) return active.run;
        const run = Promise.resolve().then(async () => {
          try {
            while (running.get(owner)?.run === run && wanted.delete(owner))
              await pass(pairId, owner, () => running.get(owner)?.run === run);
          } finally {
            if (running.get(owner)?.run === run) running.delete(owner);
          }
        });
        running.set(owner, { pairId, run });
        return run;
      }),
    );
  }
  return {
    /** Keeps a message for later and sends it now if the computer is there. */
    add(
      m: { pairId: string; chatId: string; text: string; attachments: string[]; skills?: string[]; momo?: true },
      pictures: string[] = [],
    ) {
      const id = o.newId();
      const nativeId = o.identity?.(m, id);
      markSend('tap', performance.now(), { ...m, id });
      set([
        ...items,
        {
          ...m,
          ...(pictures.length ? { pictures: pictures.slice(0, 10), images: Math.min(10, pictures.length) } : {}),
          ...(nativeId ? { nativeId } : {}),
          id,
          at: o.now(),
          status: 'queued',
          error: null,
        },
      ]);
      void flush(m.pairId);
      return id;
    },
    /** Drops a message that has not gone out; one in flight cannot be taken back. */
    cancel(id: string) {
      const item = items.find((i) => i.id === id);
      if (!item || item.status === 'sending') return false;
      set(items.filter((i) => i.id !== id));
      // what the refused message held back may go now
      if (item.status === 'failed') void flush(item.pairId);
      return true;
    },
    /** Rewrites a message that is still waiting and was never in flight, keeping its id and place in the queue; any other is left as it is. */
    edit(id: string, text: string) {
      const item = items.find((i) => i.id === id);
      // a message that has been in flight may already be at the computer, which would refuse the same id with other words
      if (!item || item.status !== 'queued' || item.attempted || (!text.trim() && !item.attachments.length)) return false;
      patch(id, { text });
      return true;
    },
    /** Sends a refused message again under its own id. */
    retry(id: string) {
      const item = items.find((i) => i.id === id);
      if (!item || item.status !== 'failed' || item.final) return false;
      patch(id, { status: 'queued', error: null, ...(isUnconfirmed(item) ? { uncertain: true as const } : {}) });
      void flush(item.pairId);
      return true;
    },
    flush,
    /** Puts back what was saved before the app closed. */
    restore(saved: QueuedSend[]) {
      if (saved.length) set([...saved, ...items]);
    },
    /** Forgets what belongs to a computer that was removed. */
    drop(pairId: string) {
      probes.delete(pairId);
      for (const [owner, active] of running) {
        if (active.pairId !== pairId) continue;
        running.delete(owner);
        wanted.delete(owner);
      }
      if (items.some((item) => item.pairId === pairId)) set(items.filter((item) => item.pairId !== pairId));
    },
    clear() {
      probes.clear();
      running.clear();
      wanted.clear();
      if (items.length) set([]);
    },
  };
}

/** A request the closed connection cut off may have reached the computer, so the message is sent again under its id when it is back; so is one made before a computer was connected. */
export const sendLost = (error: unknown) =>
  error instanceof Error && /^(Connection closed|Connect to a computer first|relay disconnected)/i.test(error.message);

/** The calls a screen makes on the queue: take a message back, rewrite a waiting one, send a refused one again. */
export const sendActions = (box: { cancel(id: string): boolean; edit(id: string, text: string): boolean; retry(id: string): boolean }) => ({
  cancelSend: (id: string) => box.cancel(id),
  editSend: (id: string, text: string) => box.edit(id, text),
  retrySend: (id: string) => box.retry(id),
});

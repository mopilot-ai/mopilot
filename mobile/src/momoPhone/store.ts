// MoMo's phone store: the home's view as the home last said it, with what the user did in flight laid over it, the messages held until the home has them, and every refusal kept as its real cause with its one-tap fix.
import type { MomoChatRow, MomoNoteView } from '../../../shared/momoView';
import type { HomeCopy, HomeLoad } from './homeCache';
import type { Admit } from './stamps';
import { publicTurns, start, step, type QEffect, type QEvent, type QState } from './queue';
import { say } from './say';
import { SNOOZE_MS } from './wire';
import { NO_CHANGE_MS, SLOW_KINDS } from './followUp';
import type { Intent, IntentResult, LocalTurn, MomoTransport, PhoneView } from './types';

export type MomoState = {
  /** The home's view with the intents still in flight applied on top; null before the first read. */
  view: PhoneView | null;
  loading: boolean;
  /** The last refusal's cause and fix; cleared by the next success or dismiss. */
  failure: { cause: string; fix: { label: string; intent: Intent } | null; late?: true } | null;
  /** The keys of the intents in flight (`intentKey`), so a button can show it is working and a second tap does nothing. */
  busy: ReadonlySet<string>;
  /** The messages this phone holds until the home has them. */
  turns: readonly LocalTurn[];
  /** The notes saved on this phone, while the home has not been read: they can be read, not changed. */
  cached: readonly MomoNoteView[] | null;
  /** What the phone kept for this account and computer could not be read: unsent messages from before may be lost. */
  lost: boolean;
};

export type MomoStore = {
  get(): MomoState;
  subscribe(listener: () => void): () => void;
  load(): Promise<void>;
  act(intent: Intent): Promise<IntentResult>;
  /** Saves a message on the phone, then sends it when the home can take it. Resolves true once it is on the phone, false when it could not be kept (nothing was sent: its text stays with the person). */
  sendText(text: string): Promise<boolean>;
  dismissFailure(): void;
  /** The kept messages cannot be read and the person gave them up: what is kept starts again. */
  discardLost(): void;
  /** Stops listening and forgets everything read from the home. */
  dispose(): void;
  /** Reads the home again without showing a load (after a reconnect or the app coming back): a change that was not told is found. */
  refresh(): Promise<void>;
};

/** What identifies an intent in flight: the same intent twice is one. */
export const intentKey = (intent: Intent) => JSON.stringify(intent);

/** An intent's optimistic effect on the view, so the screen answers before the home does. */
export function applyIntent(v: PhoneView, intent: Intent): PhoneView {
  const { view } = v;
  switch (intent.kind) {
    case 'wake':
      return { ...v, waking: true };
    case 'rule-undo':
      return { ...v, view: { ...view, rules: view.rules.map((r) => (r.id === intent.ruleId ? { ...r, state: 'undone' } : r)) } };
    case 'prefs': {
      const p = intent.patch;
      const s = view.settings;
      const settings = {
        brief: { on: p.brief ?? s.brief.on, time: p.briefTime ?? s.brief.time },
        quietHours: { from: p.quietFrom ?? s.quietHours.from, to: p.quietTo ?? s.quietHours.to },
        dailyCap: p.dailyCap ?? s.dailyCap,
        previews: p.previews ?? s.previews,
      };
      const setup = p.notifications ? { ...view.setup, notifications: p.notifications } : view.setup;
      return { ...v, view: { ...view, settings, setup } };
    }
    // the Mac drops a task it no longer watches from the list
    case 'task-stop-watching':
      return { ...v, view: { ...view, tasks: view.tasks.filter((t) => t.id !== intent.taskId) } };
    case 'task-stop':
      return { ...v, view: { ...view, tasks: view.tasks.map((t) => (t.id === intent.taskId ? { ...t, state: 'stopped' } : t)) } };
    case 'task-snooze': {
      const until = v.now + SNOOZE_MS;
      return { ...v, view: { ...view, tasks: view.tasks.map((t) => (t.id === intent.taskId ? { ...t, nextCheck: until } : t)) } };
    }
    case 'move-ack':
    case 'move-stay':
    case 'reclaim':
      return { ...v, view: { ...view, home: { ...view.home, move: null } } };
    default:
      return v;
  }
}

/** Where the phone keeps its copy between runs: read once when the screen opens, written after every change. */
export type Persist = { load(): Promise<HomeLoad>; save(copy: HomeCopy): Promise<void> };

/** Intents whose effect stays shown until the home's next view says so (a switch must not flip back when the answer carries no view). */
const STICKY = new Set(['prefs', 'rule-undo', 'task-stop', 'task-stop-watching', 'move-ack', 'move-stay', 'reclaim']);

/** Runs a Google intent on this phone (its sign-in needs the phone's browser): `ok`, or the real cause and a fix to try again. */
export type GoogleOnPhone = (
  intent: 'connect' | 'reconnect' | 'grant-send',
) => Promise<{ ok: true } | { ok: false; cause: string; fix?: object; fixLabel?: string }>;

async function onPhone(run: GoogleOnPhone, intent: 'connect' | 'reconnect' | 'grant-send'): Promise<IntentResult> {
  const done = await run(intent);
  if (done.ok) return { ok: true };
  const again =
    (done.fix as { kind?: string; intent?: string } | undefined)?.kind === 'google' ? (done.fix as { intent: string }).intent : null;
  const fix: Intent | undefined =
    again === 'connect' || again === 'reconnect' || again === 'grant-send' || again === 'remove'
      ? { kind: 'google', intent: again }
      : undefined;
  return { ok: false, cause: done.cause, ...(fix && done.fixLabel ? { fix, fixLabel: done.fixLabel } : {}) };
}

export function createMomoStore(
  transport: MomoTransport,
  options: { newId?: () => string; now?: () => number; persist?: Persist; stamps?: () => Promise<Admit>; google?: GoogleOnPhone } = {},
): MomoStore {
  const newId = options.newId ?? (() => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
  const clock = options.now ?? Date.now;
  const persist = options.persist;
  let base: PhoneView | null = null;
  let overlays: { key: string; intent: Intent; done: boolean }[] = [];
  // the held messages are the queue machine's: this store only carries out what it asks for and tells it what happened
  let q: QState = start(persist ? 'unread' : 'ok');
  let loading = false;
  let cached: readonly MomoNoteView[] | null = null;
  let failure: MomoState['failure'] = null;
  let disposed = false;
  let loaded = false;
  // what an old home says is refused: until the newest lease seen has been read nothing is taken
  let admit: Pick<Admit, 'view'> | null = options.stamps ? null : { view: () => true };
  let writes: Promise<unknown> = Promise.resolve();
  let notesKept = '';
  const saving = new Map<string, (kept: boolean) => void>();
  const checking = new Map<string, (r: IntentResult) => void>();
  const inflight = new Map<string, Promise<IntentResult>>();
  /** Tasks the person put off, and when each comes back: kept after the home's view arrives, until that time. */
  const snoozed = new Map<string, number>();
  /** When the person last tried a failed move again: the failed card says so until the move is over. */
  let retriedAt: number | null = null;
  /** Cancel was pressed and the move has not ended: the card says Cancelling… until the home's view says it has. */
  let cancelling = false;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const later = (ms: number, fn: () => void | Promise<void>) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) void fn();
    }, ms);
    timers.add(timer);
  };
  const listeners = new Set<() => void>();

  const derive = (): MomoState => {
    const shown = base && overlays.reduce((v, o) => applyIntent(v, o.intent), base);
    const back = Object.fromEntries([...snoozed].filter(([, until]) => shown && until > shown.now));
    const withSnoozed = shown && Object.keys(back).length ? { ...shown, snoozed: back } : shown;
    const withRetried = withSnoozed && retriedAt !== null ? { ...withSnoozed, retriedAt } : withSnoozed;
    const view = withRetried && cancelling ? { ...withRetried, cancelling } : withRetried;
    return {
      view,
      loading,
      failure,
      busy: new Set(overlays.filter((o) => !o.done).map((o) => o.key)),
      turns: publicTurns(q),
      cached,
      lost: q.disk === 'unreadable',
    };
  };
  let state = derive();
  const refused = (result: { cause: string; fix?: Intent; fixLabel?: string }) => ({
    cause: result.cause,
    fix: result.fix && result.fixLabel ? { label: result.fixLabel, intent: result.fix } : null,
  });
  const publish = () => {
    state = derive();
    saveNotes();
    for (const l of [...listeners]) l();
  };

  /** One write after another, never two at once: each carries the copy as it was asked for, and says how it went. */
  const enqueueWrite = (id: string | null, image: HomeCopy['turns']) => {
    const copy: HomeCopy = { notes: base ? base.view.notes : [...(cached ?? [])], turns: image };
    notesKept = JSON.stringify(copy.notes);
    writes = writes
      .then(() => persist?.save(copy))
      .then(
        () => true,
        () => false,
      )
      .then((ok) => {
        if (!disposed) dispatch({ t: 'wrote', id, ok, image });
        return undefined;
      });
  };
  /** The notes are kept with every change of them, and are never kept before what was kept has been read. */
  function saveNotes() {
    if (!persist || q.disk !== 'ok' || disposed) return;
    const notes = JSON.stringify(base ? base.view.notes : (cached ?? []));
    if (notes !== notesKept) enqueueWrite(null, q.image);
  }

  function carryOut(f: QEffect) {
    switch (f.t) {
      case 'write':
        enqueueWrite(f.id, f.image);
        break;
      case 'send':
        void sendOut(f.id, f.text);
        break;
      case 'check':
        void askOut(f.id);
        break;
      case 'reject':
        saving.get(f.id)?.(false);
        saving.delete(f.id);
        break;
      case 'tell':
        failure = {
          cause: say('couldNotKeep'),
          fix: f.again ? { label: say('tryAgain'), intent: { kind: 'retry-held' } } : null,
        };
        break;
    }
  }
  /** Gives the machine one event, carries out what it asks, and tells the screens. */
  function dispatch(e: QEvent): QEffect[] {
    const was = q;
    const out = step(q, e);
    q = out.state;
    if (e.t === 'wrote' && e.ok && e.id && was.turns.find((t) => t.id === e.id)?.op === 'save') {
      saving.get(e.id)?.(true);
      saving.delete(e.id);
    }
    for (const f of out.effects) carryOut(f);
    if (!disposed) publish();
    return out.effects;
  }

  /** The turns the home has now are its to say; the rest are still this phone's. */
  /** What the cards of the page stand on: a failure said about one of them no longer fits once this changes. */
  const standing = (v: PhoneView) => {
    const h = v.view.home;
    return [h.state, h.homeMachineId, h.move?.moveId, h.move?.outcome, h.move?.step].join('|');
  };
  const take = (view: PhoneView) => {
    if (failure && base && standing(base) !== standing(view)) failure = null;
    if (!view.view.home.move || (view.view.home.move.outcome !== 'failed' && view.view.home.move.outcome !== 'running')) retriedAt = null;
    if (view.view.home.move?.outcome !== 'running') cancelling = false;
    base = view;
    overlays = overlays.filter((o) => !o.done);
    const known = new Set(view.view.chat.flatMap((r: MomoChatRow) => (r.kind === 'user' ? [r.id] : [])));
    const mine = q.turns.filter((t) => known.has(t.id)).map((t) => t.id);
    dispatch({ t: 'home', running: view.view.home.state === 'running' });
    if (mine.length) dispatch({ t: 'listed', ids: mine });
  };
  /** The view with the home's patch laid on it, only when the home that sent it is not older than the newest seen. */
  const taken = (view: PhoneView): boolean => {
    if (!admit?.view(view)) return false;
    take(view);
    return true;
  };
  const merge = (patch: Partial<PhoneView>) => {
    if (disposed || !base) return;
    taken({ ...base, ...patch });
  };
  const off = transport.subscribe(merge);

  async function sendOut(id: string, text: string): Promise<void> {
    let result: IntentResult;
    try {
      result = await transport.send({ kind: 'send', turnId: id, text });
    } catch {
      // no answer: it stays in doubt, and only a status answer lets it go again
      if (!disposed) dispatch({ t: 'sent', id, answer: 'unanswered' });
      return;
    }
    if (disposed) return;
    if (result.ok) {
      if (result.view && base) taken({ ...base, ...result.view });
      dispatch({ t: 'sent', id, answer: 'accepted' });
    } else {
      failure = refused(result);
      dispatch({ t: 'sent', id, answer: 'refused' });
    }
  }

  /** Check again: the home says whether it has the turn, as a status. A home that lists it has it; one that says it never did allows a resend under the same id; one that cannot say leaves it in doubt. */
  async function askOut(id: string): Promise<void> {
    let result: IntentResult;
    try {
      result = await transport.send({ kind: 'check-turn', turnId: id });
    } catch (e) {
      result = { ok: false, cause: e instanceof Error ? e.message : String(e) };
    }
    if (disposed) {
      // whoever asked still gets the answer; nothing here changes
      checking.get(id)?.(result);
      checking.delete(id);
      return;
    }
    if (result.ok) {
      failure = null;
      if (result.view && base) taken({ ...base, ...result.view });
      const held = q.turns.some((t) => t.id === id);
      if (held) {
        const answer = result.turn === 'has' ? 'has' : result.turn === 'missing' ? 'missing' : 'unavailable';
        // a home that cannot say whether it has the turn is told as that, never taken as a no
        if (answer === 'unavailable') failure = { cause: say('cannotTellYet'), fix: null };
        dispatch({ t: 'checked', id, answer });
      }
    } else {
      failure = refused(result);
      dispatch({ t: 'checked', id, answer: 'unavailable' });
    }
    checking.get(id)?.(result);
    checking.delete(id);
  }

  /** Reads the home again without showing a load; a read that fails leaves what is shown as it was. */
  async function refresh(): Promise<void> {
    try {
      const view = await transport.load();
      if (!disposed) taken(view);
    } catch {
      // the next push or Try again reads it
    }
  }

  async function run(intent: Intent, key: string): Promise<IntentResult> {
    // what the cards stood on when it was pressed: only a view that still stands there ten seconds later has not changed
    const before = base ? standing(base) : null;
    overlays = [...overlays, { key, intent, done: false }];
    if (intent.kind === 'move-cancel') cancelling = true;
    publish();
    let result: IntentResult;
    try {
      // connecting runs here, with this phone's browser; the home is read again after it
      result =
        intent.kind === 'google' && intent.intent !== 'remove' && options.google
          ? await onPhone(options.google, intent.intent)
          : await transport.send(intent);
    } catch (e) {
      result = { ok: false, cause: e instanceof Error ? e.message : String(e) };
    }
    inflight.delete(key);
    if (disposed) return result;
    // an answer with no view keeps a setting's effect on screen until the home's next view; a refusal takes it off
    const keepShown = result.ok && !result.view && STICKY.has(intent.kind);
    overlays = overlays.flatMap((o) => (o.key !== key ? [o] : keepShown ? [{ ...o, done: true }] : []));
    if (result.ok) {
      // what the sign-in changed is read from the home: the answer carries no view
      if (intent.kind === 'google' && !result.view) await refresh();
      if (intent.kind === 'task-snooze') snoozed.set(intent.taskId, clock() + SNOOZE_MS);
      if (base && result.view) taken({ ...base, ...result.view, waking: false });
      failure = null;
      if (intent.kind === 'move-retry') retriedAt = clock();
      // a machine that does not change in time says so with a way to try again, never a silent return to the old card
      if (SLOW_KINDS.has(intent.kind) && before !== null) {
        later(NO_CHANGE_MS, async () => {
          await refresh();
          if (base && standing(base) === before) {
            // told after the person has gone on reading: the page is not moved for it
            failure = { cause: say('hasNotChanged'), fix: { label: say('retry'), intent }, late: true };
            publish();
          }
        });
      }
    } else {
      failure = refused(result);
      if (intent.kind === 'move-cancel') cancelling = false;
      // a refused answer may mean the card is no longer the one on screen: read the home again
      if (intent.kind === 'approval') await refresh();
    }
    publish();
    return result;
  }

  /** Reads what the phone kept, once it can be read: a copy that cannot be read is told, never written over, and read again when asked. */
  async function restoreKept(): Promise<void> {
    if (!persist || loaded || q.disk === 'ok') return;
    const read = await persist.load().catch((): HomeLoad => ({ status: 'unreadable' }));
    if (disposed) return;
    if (read.status === 'unreadable') {
      if (q.disk !== 'unreadable') dispatch({ t: 'load', read: 'unreadable' });
      return;
    }
    loaded = true;
    if (read.status === 'ok') {
      cached = read.copy.notes;
      notesKept = JSON.stringify(read.copy.notes);
      dispatch({ t: 'load', read: 'ok', turns: read.copy.turns.filter((t) => t.delivery !== 'accepted') });
    } else dispatch({ t: 'load', read: 'none' });
    saveNotes();
  }

  return {
    get: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    async load() {
      await restoreKept();
      if (disposed) return;
      loading = true;
      publish();
      try {
        admit ??= await (options.stamps as () => Promise<Admit>)();
        const view = await transport.load();
        if (disposed) return;
        // a computer that is an old home is not MoMo's home any more: it says so, with Try again (the person asks again, or the owner reclaims)
        if (!taken(view)) throw new Error(say('notTheHomeAnyMore'));
        failure = null;
      } catch (e) {
        failure = { cause: e instanceof Error ? e.message : String(e), fix: null };
      }
      loading = false;
      if (!disposed) publish();
    },
    act(intent) {
      const key = intentKey(intent);
      const running = inflight.get(key);
      if (running !== undefined) return running;
      if (intent.kind === 'retry-held') {
        failure = null;
        dispatch({ t: 'retry' });
        return Promise.resolve({ ok: true });
      }
      if (intent.kind === 'check-turn' && q.turns.some((t) => t.id === intent.turnId)) {
        const answer = new Promise<IntentResult>((resolve) => checking.set(intent.turnId, resolve));
        const asked = dispatch({ t: 'check', id: intent.turnId });
        if (!asked.some((f) => f.t === 'check')) {
          checking.delete(intent.turnId);
          return Promise.resolve({ ok: true });
        }
        inflight.set(key, answer);
        void answer.then(() => inflight.delete(key));
        return answer;
      }
      if (intent.kind === 'send') {
        // Send now: the same turn goes again under its own id, once the home has said it never had it
        if (q.turns.some((t) => t.id === intent.turnId)) dispatch({ t: 'resend', id: intent.turnId });
        else {
          const row = base?.view.chat.find((r) => r.kind === 'user' && r.id === intent.turnId);
          dispatch({ t: 'adopt', id: intent.turnId, text: intent.text, at: row?.at ?? clock() });
        }
        return Promise.resolve({ ok: true });
      }
      const promise = run(intent, key);
      inflight.set(key, promise);
      return promise;
    },
    sendText(text) {
      const clean = text.trim();
      if (!clean || disposed) return Promise.resolve(false);
      const id = newId();
      const kept = new Promise<boolean>((resolve) => saving.set(id, resolve));
      dispatch({ t: 'submit', id, text: clean, at: clock() });
      return kept;
    },
    dismissFailure() {
      failure = null;
      publish();
    },
    discardLost() {
      notesKept = '';
      dispatch({ t: 'discard' });
    },
    refresh,
    dispose() {
      disposed = true;
      off();
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      for (const resolve of saving.values()) resolve(false);
      saving.clear();
      base = null;
      overlays = [];
      q = start('ok');
      cached = null;
      failure = null;
      listeners.clear();
      state = derive();
    },
  };
}

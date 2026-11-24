// The one method set both clients call for MoMo's home (agreed with the phone and Mac UI lanes, #5474): `momo.home.view` → `{ view, movedAwayTo? }`, `momo.home.intent { intent }` → `{ ok: true, view? }` or `{ ok: false, cause, fix?, fixLabel? }`, and the event `momo.home.changed` carrying the same payload as the view. The view is the whole `MomoView` of #5482. This file is the behaviour behind those names, over what the caller injects (the Host's answers, the app's machine list, the move runner and the other lanes' intent handlers), so the Mac's IPC and the phone's channel serve the same answers and a scripted fake can stand in for both.
import { parseFixId } from './momoFixId.mjs';
import { userError } from './userError.mjs';

export const VIEW_METHOD = 'momo.home.view';
export const INTENT_METHOD = 'momo.home.intent';
export const CHANGED_EVENT = 'momo.home.changed';

/** What a view holds before another lane fills its part: first-run done, nothing to show, settings as the design's defaults (D1, D2). */
const EMPTY = () => ({
  setup: { step: 'done', google: 'idle', notifications: 'unknown' },
  chat: [],
  tasks: [],
  notes: [],
  rules: [],
  signals: [],
  problems: [],
  settings: { brief: { on: true, time: '08:00' }, quietHours: { from: '22:00', to: '08:00' }, dailyCap: 6, previews: false },
});

/**
 * A failure of an intent with the one tap that fixes it: the cause is shown as is, `fix` is an intent the screen offers as a button
 * labelled `fixLabel` ("Update Mac mini", "Sign in on Studio").
 */
export class IntentError extends Error {
  /** @param {string} cause @param {{ fix?: object, fixLabel?: string }} [how] */
  constructor(cause, how = {}) {
    super(cause);
    this.name = 'IntentError';
    this.fix = how.fix;
    this.fixLabel = how.fixLabel;
  }
}

/**
 * @param {object} o
 * @param {() => Promise<{ home: any, rest?: Record<string, unknown> }>} o.compose the home part (shared/momoHomeView.mjs `homeView`) and the other lanes' parts of the view
 * @param {Record<string, (intent: any) => unknown | Promise<unknown>>} [o.intents] one handler per intent kind; throws `IntentError` (or any error) to refuse
 */
export function createHomeApi({ compose, intents = {} }) {
  /** @type {Set<(payload: any) => void>} */
  const listeners = new Set();

  /** The whole view, with a home that has none yet shown as the first-run choice (`setup.step: 'where'`). */
  const view = async () => {
    const { home, rest = {} } = await compose();
    const first = home.state === null;
    const whole = {
      ...EMPTY(),
      ...rest,
      ...(first ? { setup: { ...EMPTY().setup, .../** @type {any} */ (rest.setup ?? {}), step: 'where' } } : {}),
    };
    const away = home.movedAway;
    return {
      view: { ...whole, home: first ? { ...home, state: 'asleep' } : home },
      // the phone reads where MoMo went from the top level as well
      ...(away ? { movedAwayTo: { name: away.machine.name, at: away.at } } : {}),
    };
  };

  /**
   * A fix the view offered (`{ kind: 'fix', id }`) is the intent it names: `update-machine`, `sign-in-agent` and `install-agent`, each with its encoded fields (shared/momoFixId.mjs). An id that names nothing is no intent. @param {any} raw
   */
  const unfix = (raw) => {
    if (raw?.kind !== 'fix' || typeof raw.id !== 'string') return raw;
    const [machineId, agent] = parseFixId(raw.id)?.fields ?? [];
    const kind = parseFixId(raw.id)?.kind;
    if (kind === 'update-machine' && machineId) return { kind, machineId };
    if ((kind === 'sign-in-agent' || kind === 'install-agent') && machineId) return { kind, machineId, agent: agent ?? '' };
    return { kind: 'fix', id: raw.id };
  };

  /** Everyone with a listener hears the fresh view; one that throws does not stop the others. @param {object} fresh */
  const tell = (fresh) => {
    const payload = { ev: CHANGED_EVENT, ...fresh };
    for (const fn of listeners) {
      try {
        fn(/** @type {any} */ (payload));
      } catch (error) {
        void error; // a screen's own failure is its own
      }
    }
  };

  /** @param {any} raw */
  const intent = async (raw) => {
    const intent = unfix(raw);
    const kind = typeof intent?.kind === 'string' ? intent.kind : '';
    const handler = Object.hasOwn(intents, kind) ? intents[kind] : null;
    if (!handler)
      return { ok: /** @type {const} */ (false), cause: kind ? 'MoMo can’t do that yet.' : 'That is not something MoMo can do.' };
    /** @type {any} */
    let out;
    try {
      out = await handler(intent);
    } catch (error) {
      const e = /** @type {any} */ (error);
      return {
        ok: /** @type {const} */ (false),
        cause: e instanceof IntentError ? e.message : userError(error),
        ...(e instanceof IntentError && e.fix && e.fixLabel ? { fix: e.fix, fixLabel: e.fixLabel } : {}),
      };
    }
    // a handler may answer something of its own that a screen reads beside the view: `check-turn` answers `turn: 'has' | 'missing' | 'unknown'`
    // what an intent changed reaches every client (a second window, the phone), not only the one that asked
    const fresh = await view();
    tell(fresh);
    return {
      ok: /** @type {const} */ (true),
      ...(out && typeof out === 'object' && typeof out.turn === 'string' ? { turn: out.turn } : {}),
      // something the person should be told though the intent worked (a Google account removed here that Google could not be asked to revoke)
      ...(out && typeof out === 'object' && typeof out.notice === 'string' ? { notice: out.notice } : {}),
      ...fresh,
    };
  };

  return {
    view,
    intent,
    /** The methods as a table the Mac's IPC and the phone's channel register under their names. */
    methods: /** @type {Record<string, (p: any) => Promise<unknown>>} */ ({
      [VIEW_METHOD]: () => view(),
      [INTENT_METHOD]: (p) => intent(p?.intent),
    }),
    /** @param {(payload: { ev: string, view: any, movedAwayTo?: any }) => void} fn @returns {() => void} */
    onChanged(fn) {
      listeners.add(fn);
      return () => void listeners.delete(fn);
    },
    /** Something that changes the view happened (a Host's answer, a move step): tell everyone with the fresh view. A listener that throws does not stop the others. */
    async changed() {
      if (listeners.size === 0) return;
      tell(await view());
    },
  };
}

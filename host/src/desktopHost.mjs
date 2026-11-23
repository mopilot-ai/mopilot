// The Host's desktop (G8, #3903): one lease on this machine's desktop for one chat, and the allowlisted helper calls that lease may make. The Host adds what the helper cannot know: who holds the desktop (one connection, one chat, one epoch), which apps that chat may touch (checked and injected on every call, so a client cannot widen it), and that a resent call is answered, never done twice.
//
// Never falls back: when the helper cannot be reached a call fails; nothing here reaches another desktop. Unattended means no client: the lease dies with its connection, so nothing runs on the desktop for a chat nobody is connected to.
import { ANY_APP, DESKTOP_READS, LOOKUPS, desktopCallAllowed } from '../../shared/host/desktop.mjs';

export class DesktopError extends Error {
  /** @param {'unavailable' | 'busy' | 'no_lease' | 'stale_lease' | 'outside_grant' | 'too_large' | 'aborted' | 'unsupported_call' | 'call_id_reused' | 'helper_restarted'} code @param {string} message */
  constructor(code, message) {
    super(message);
    this.name = 'DesktopError';
    this.code = code;
  }
}

/** How many answered calls a chat's memory holds for a resend. */
const MEMO = 64;
/** How long answered calls are remembered: a resend after a reconnect comes within moments, and a stale entry must not answer a new action. */
const MEMO_MS = 10 * 60_000;
/** How many chats' memories are kept. */
const MEMO_CHATS = 16;
/** How long a lease may go without a call before the Host lets go of it: a client that vanished without closing (a half-open connection) must not keep input held. */
const IDLE_MS = 10 * 60_000;
/** What a helper says when the session under it changed: it went away, or macOS took a grant back. These make the Host look again; a refused action does not. */
const HELPER_TROUBLE = new Set([
  'helper_exited',
  'helper_unavailable',
  'helper_restarted',
  'helper_stopped',
  'helper_not_running',
  'permission_denied',
]);

/**
 * The call's params with the lease's apps as the limit: named apps must be inside the grant, and the helper is told the grant for every call (`bundleIds` for the helper's own restriction, `includeBundleIds` so a full-display shot shows only those apps).
 * @param {string[] | typeof ANY_APP} apps @param {string} method @param {Record<string, any>} params
 */
export function scopeParams(apps, method, params) {
  if (apps === ANY_APP) return params;
  // no apps yet: the lookups a chat needs to name the apps it will ask for, nothing else, whatever the call names
  if (apps.length === 0) {
    if (!LOOKUPS.has(method)) throw new DesktopError('outside_grant', 'No apps are granted in this chat yet.');
    return params;
  }
  const inside = (/** @type {unknown} */ ids) => Array.isArray(ids) && ids.every((id) => typeof id === 'string' && apps.includes(id));
  for (const key of ['bundleIds', 'includeBundleIds']) {
    if (params[key] !== undefined && !inside(params[key]))
      throw new DesktopError('outside_grant', 'That action names an app this chat may not control.');
  }
  if (params.bundleId !== undefined && !inside([params.bundleId]))
    throw new DesktopError('outside_grant', 'That action names an app this chat may not control.');
  /** @type {Record<string, any>} */
  const scoped = { ...params, bundleIds: params.bundleIds ?? apps };
  if (method === 'screenshot') scoped.includeBundleIds = params.includeBundleIds ?? apps;
  return scoped;
}

/**
 * A reply with what the lease may not see taken out: the calls that look at the whole desktop (the running apps, a lookup of apps by name) answer only about the lease's apps, since the helper restricts what it touches but not what these two list.
 * @param {string[] | typeof ANY_APP} apps @param {string} method @param {any} reply
 */
export function scopeReply(apps, method, reply) {
  // a lease with no apps yet may look the apps up: it is shown them all, to name the ones it will ask for
  if (apps === ANY_APP || apps.length === 0 || !Array.isArray(reply?.apps)) return reply;
  const granted = new Set(apps.map((id) => id.toLowerCase()));
  const may = (/** @type {any} */ app) => typeof app?.bundleId === 'string' && granted.has(app.bundleId.toLowerCase());
  if (method === 'apps.list') return { ...reply, apps: reply.apps.filter(may) };
  if (method === 'apps.resolve')
    return { ...reply, apps: reply.apps.map((/** @type {any} */ r) => (r?.app && !may(r.app) ? { query: r.query, app: null } : r)) };
  return reply;
}

/**
 * @param {object} o
 * @param {{ call: (method: string, params: object, opts?: { timeoutMs?: number }) => Promise<any>, stop: () => void, running: boolean, generation: number }} o.helper the CU helper client (helperClient.mjs)
 * @param {{ ok: () => boolean, why: () => string, recheck: () => void }} o.probe whether this Host can serve the desktop now (desktopProbe.mjs)
 * @param {(chatId: string) => number} o.epochOf the chat's current epoch (a lease of an older one is dead)
 * @param {number} o.maxReply the most a reply may carry, in bytes
 * @param {() => number} [o.now] @param {number} [o.idleMs] @param {typeof setTimeout} [o.setTimer] @param {typeof clearTimeout} [o.clearTimer]
 */
export function createDesktopHost({
  helper,
  probe,
  epochOf,
  maxReply,
  now = Date.now,
  idleMs = IDLE_MS,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
}) {
  /** @type {null | { owner: object, chatId: string, epoch: number, apps: string[] | typeof ANY_APP, chain: Promise<unknown>, aborted: boolean, idle: any, gen: number }} */
  let held = null;
  /** lease changes one at a time, so two connections racing for the desktop get one winner */
  let turn = Promise.resolve();
  let disposed = false;
  /** chat id -> the calls it made and their answers: they outlive a lease, so a resend after a reconnect (the realistic resend) gets the first answer and never acts twice. @type {Map<string, { epoch: number, calls: Map<string, { sig: string, run: Promise<any>, at: number }> }>} */
  const memos = new Map();
  /** The chat's memory for its current epoch: a new owner (a higher epoch) starts with none, and the oldest chats' memories are let go. @param {string} chatId @param {number} epoch */
  const memoOf = (chatId, epoch) => {
    let memo = memos.get(chatId);
    if (!memo || memo.epoch < epoch) {
      memo = { epoch, calls: new Map() };
      memos.delete(chatId);
      memos.set(chatId, memo);
      if (memos.size > MEMO_CHATS) memos.delete(/** @type {string} */ (memos.keys().next().value));
    }
    return memo;
  };
  const serial = (/** @type {() => Promise<any>} */ fn) => {
    const run = turn.then(fn, fn);
    turn = run.catch(() => undefined);
    return run;
  };

  /** Lets go of the helper's control and any key or button the chat left held. Best effort: the helper may already be gone. */
  const letGo = async () => {
    for (const method of ['input.release', 'control.release']) {
      try {
        await helper.call(method, {}, { timeoutMs: 5000 });
      } catch {
        // a helper that exited has nothing held
      }
    }
  };
  const end = async (/** @type {NonNullable<typeof held>} */ lease) => {
    if (held === lease) held = null;
    lease.aborted = true;
    clearTimer(lease.idle);
    await letGo();
  };
  /** The lease is used: its idle bound starts over. When it runs out the Host ends the lease itself and gives the helper's control back. @param {NonNullable<typeof held>} lease */
  const keepAlive = (lease) => {
    clearTimer(lease.idle);
    lease.idle = setTimer(() => void serial(async () => (held === lease ? end(lease) : undefined)), idleMs);
    lease.idle.unref?.();
  };
  const deadLease = () => held !== null && epochOf(held.chatId) !== held.epoch;

  return {
    /** Takes the desktop for `chatId` on behalf of the connection `owner`, with `apps` as what it may touch. */
    lease: (
      /** @type {object} */ owner,
      /** @type {string} */ chatId,
      /** @type {number} */ epoch,
      /** @type {string[] | typeof ANY_APP} */ apps,
    ) =>
      serial(async () => {
        if (disposed || !probe.ok()) throw new DesktopError('unavailable', probe.why());
        if (held && held.chatId !== chatId && !deadLease()) throw new DesktopError('busy', "Another chat is using this Host's desktop.");
        if (held && held.chatId === chatId && epoch < held.epoch)
          throw new DesktopError('stale_lease', 'That chat has moved to a newer owner.');
        // the same chat again (a reconnect, or new grants) starts from nothing: fresh input state, fresh grants
        if (held) await end(held);
        await helper.call('control.acquire', { holder: 'MoPilot' });
        const lease = { owner, chatId, epoch, apps, chain: Promise.resolve(), aborted: false, idle: null, gen: helper.generation };
        held = lease;
        keepAlive(lease);
        return { leased: true };
      }),

    /** One helper call for the lease holder. A resent `callId` gets the first answer. */
    call(
      /** @type {object} */ owner,
      /** @type {string} */ chatId,
      /** @type {number} */ epoch,
      /** @type {string} */ callId,
      /** @type {string} */ method,
      /** @type {Record<string, any>} */ params,
    ) {
      const lease = held;
      if (!lease || lease.owner !== owner || lease.chatId !== chatId)
        return Promise.reject(new DesktopError('no_lease', 'This chat does not hold the desktop.'));
      if (lease.epoch !== epoch) return Promise.reject(new DesktopError('stale_lease', 'That chat has moved to a newer owner.'));
      if (!desktopCallAllowed(method))
        return Promise.reject(new DesktopError('unsupported_call', 'That desktop action is not one a Host serves.'));
      // a resend is the same call: a call id that comes back with another action is a mistake, never a result to hand over
      const sig = JSON.stringify([method, params]);
      keepAlive(lease);
      const memo = memoOf(chatId, epoch);
      const again = memo.calls.get(callId);
      if (again && now() - again.at <= MEMO_MS)
        return again.sig === sig
          ? again.run
          : Promise.reject(new DesktopError('call_id_reused', 'That call id was already used for a different action.'));
      const run = lease.chain.then(async () => {
        if (lease.aborted) throw new DesktopError('aborted', 'The desktop was let go before this action ran.');
        // the helper went and came back since the lease took control (it restarts on demand, and the readings start it too): it holds no control and no held input now, so control is taken again, and a write is not run blind: the chat looks again first
        // (a probe may have started it again meanwhile, so "is it up" is not enough: it must be the helper this lease took control on)
        if (!helper.running || helper.generation !== lease.gen) {
          await helper.call('control.acquire', { holder: 'MoPilot' });
          lease.gen = helper.generation;
          if (!DESKTOP_READS.has(method))
            throw new DesktopError(
              'helper_restarted',
              'The desktop helper restarted, so what it held is gone. Take a fresh screenshot, then act again.',
            );
        }
        const reply = scopeReply(lease.apps, method, await helper.call(method, scopeParams(lease.apps, method, params)));
        // the frame limit is in bytes; a screenshot near it is refused with the way out instead of cutting the connection
        if (Buffer.byteLength(JSON.stringify(reply ?? null)) > maxReply)
          throw new DesktopError('too_large', 'The answer is more than one message can carry. Ask for a smaller screenshot.');
        return reply;
      });
      lease.chain = run.catch(() => undefined);
      // a failure means the session may have changed (the helper went, the user logged out): look again soon
      run.catch((/** @type {any} */ e) => {
        if (HELPER_TROUBLE.has(e?.reason)) probe.recheck();
      });
      if (!DESKTOP_READS.has(method)) {
        memo.calls.set(callId, { sig, run, at: now() });
        if (memo.calls.size > MEMO) memo.calls.delete(/** @type {string} */ (memo.calls.keys().next().value));
      }
      return run;
    },

    /** The holder lets go. A release by anyone else is a no-op, so a late one cannot end a newer lease. */
    release: (/** @type {object} */ owner, /** @type {string} */ chatId, /** @type {number} */ epoch) =>
      serial(async () => {
        if (held && held.owner === owner && held.chatId === chatId && held.epoch === epoch) await end(held);
        return { released: true };
      }),

    /** Stop: waiting calls fail at once and the desktop is let go; the chat's owner (any connection) may stop it. */
    abort: (/** @type {string} */ chatId) => {
      const lease = held;
      if (lease && lease.chatId === chatId) {
        lease.aborted = true;
        return serial(async () => {
          if (held === lease) await end(lease);
          return { aborted: true };
        });
      }
      return Promise.resolve({ aborted: false });
    },

    /** What the chat's side may show: whether it holds the desktop, and whether this Host can serve one. */
    state: (/** @type {object} */ owner, /** @type {string} */ chatId) => ({
      held: Boolean(held && held.owner === owner && held.chatId === chatId),
      busy: Boolean(held && held.chatId !== chatId && !deadLease()),
      available: probe.ok(),
      ...(probe.ok() ? {} : { reason: probe.why() }),
    }),

    /** The chat has a new owner (its epoch moved on): a lease of an older epoch ends, with held input cancelled. @param {string} chatId @param {number} epoch */
    epochMoved: (chatId, epoch) =>
      serial(async () => {
        if (held && held.chatId === chatId && held.epoch < epoch) await end(held);
      }),

    /** The connection went away: its lease ends, with whatever was held released and no resume. */
    closed: (/** @type {object} */ owner) =>
      serial(async () => {
        if (held && held.owner === owner) await end(held);
      }),

    async dispose() {
      disposed = true;
      memos.clear();
      await serial(async () => {
        if (held) await end(held);
      });
      helper.stop();
    },
  };
}

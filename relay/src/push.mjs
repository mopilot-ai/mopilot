// Push: the registry of phone tokens plus the path from a Mac's clear push request {pair, kind, ref} to one provider
// send. The relay never gives a token to a Mac. Providers are an interface (`send`); the push-proxy mode is one
// implementation of it, a plain HTTP forward of {token, kind} to a push.mopilot.ai-style endpoint.
import { createHash } from 'node:crypto';
import { Metrics } from './metrics.mjs';
import { ActivityFeed, FINISHED_LINGER_MS, STALE_MS } from './activity.mjs';
import { Notifier } from './notifier.mjs';
import { messageOf } from './processGuards.mjs';
import { retryAfterMs } from './pushRetry.mjs';

/**
 * @typedef {{ timestamp: number, event: 'update' | 'end', state: object, staleAt: number, dismissAt: number, priority: 5 | 10 }} ActivityUpdate
 * @typedef {{ platform: 'apns' | 'fcm', token: string, kind: string, title: string, count: number, collapseId: string, ref: string, sealed?: string, card?: string, sealedBody?: string, topic?: string, activity?: ActivityUpdate }} PushMessage `card`: the opaque handle of the MoMo card a momoNeedsYou push is for; `topic`: the APNs topic that last sent to this token (a hint for which credential set to try first)
 * @typedef {(m: PushMessage) => Promise<{ ok: boolean, invalidToken?: boolean, status?: number, reason?: string, topic?: string }>} PushSend
 * @typedef {{ sandbox: boolean, topic: string }} ApnsTarget an APNs credential set as the token log names it
 * @typedef {(m: PushMessage) => Promise<import('./pushRetry.mjs').SendResult>} RawSend a provider's single attempt; withRetry (pushRetry.mjs) turns it into a PushSend
 */

/**
 * The proxy holds the Apple and Google keys and the fixed texts, and sees no account and no chat: it gets a token, a
 * kind, a count and a collapse id that is a hash of the chat handle, never the handle.
 * @param {{ url: string, authToken?: string, fetch?: typeof fetch, timeoutMs?: number }} o
 * @returns {RawSend}
 */
export function proxySender({ url, authToken = '', fetch: f = fetch, timeoutMs = 10_000 }) {
  return async (m) => {
    // the push service has no ActivityKit path: an activity update is refused here rather than forwarded as an alert
    if (m.activity) return { ok: false };
    try {
      const res = await f(url, {
        signal: AbortSignal.timeout(timeoutMs),
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(authToken && { authorization: `Bearer ${authToken}` }) },
        body: JSON.stringify({
          token: m.token,
          platform: m.platform,
          kind: m.kind,
          count: m.count,
          collapseId: m.collapseId,
          ...(m.sealed && { sealed: m.sealed }),
          // MoMo's opt-in body, sealed for the phone: handed on unread, as `sealed` is
          ...(m.sealedBody && { sealedBody: m.sealedBody }),
        }),
      });
      // 404/410 from the proxy: the provider said the token is dead
      return {
        ok: res.ok,
        invalidToken: res.status === 404 || res.status === 410,
        retry: res.status === 429 || res.status >= 500,
        retryAfterMs: retryAfterMs(res.headers.get('retry-after')),
        fault: res.status >= 500 || res.status === 401 || res.status === 403,
      };
    } catch {
      return { ok: false, retry: true, fault: true };
    }
  };
}

/** Push requests one phone may have out or waiting at once. */
const MAX_PER_PHONE = 4;

export class PushService {
  /**
   * @param {{ store: import('./store.mjs').Store, send: PushSend | null, now?: () => number, metrics?: import('./metrics.mjs').Metrics, log?: (event: string, data: object) => void, apns?: ApnsTarget | ApnsTarget[] | null }} o `apns`: where iOS tokens are sent, one entry per APNs credential set
   */
  constructor({ store, send, now = Date.now, metrics = new Metrics(), log = () => undefined, apns = null }) {
    this.log = log;
    // where an iOS token is sent, one entry per credential set: its environment and topic, named in the token log lines (a token of one environment is refused by the other)
    this.apns = Array.isArray(apns) ? apns : apns ? [apns] : [];
    this.metrics = metrics;
    this.store = store;
    this.send = send;
    this.now = now;
    /** @type {Map<string, Notifier>} */
    this.notifiers = new Map();
    /** @type {Map<string, Promise<void>>} the last push request of each chat that has not finished: the next one for it waits (pairId:ref) */
    this.chains = new Map();
    /** @type {Map<string, number>} requests out or waiting per receiving phone */
    this.pending = new Map();
    this.activities = new ActivityFeed();
    /** @type {Map<string, { run: Promise<string> | null, again: boolean }>} per phone: the Live Activity update in flight, and whether a newer state arrived meanwhile */
    this.activitySlots = new Map();
    /** @type {Map<string, { token: string, needs: number }>} per phone: the "needs you" count the last update to that activity carried, so only a rise is sent at high priority */
    this.lastNeeds = new Map();
  }

  get enabled() {
    return this.send !== null;
  }

  async register({ deviceId, userId, platform, token }) {
    const before = await this.store.pushTokenOf(deviceId);
    await this.store.setPushToken({ deviceId, userId, platform, token, now: this.now() });
    // never the token itself: the device, whether it is new, replaced or the same again, and where it will be sent
    const same = before?.token === token;
    this.#tokenLog(deviceId, before === null ? 'registered' : same ? 'same' : 'replaced', platform, {
      topic: same ? before?.topic : undefined,
    });
  }

  /**
   * The log line of a token event. It names the topic and environment of the credential set used (`why.topic`); with one set that is the only one,
   * with several and none used yet (a new token, no send) it names neither.
   * @param {string} device @param {string} kind @param {string} provider @param {{ apns?: number, reason?: string, topic?: string }} [why]
   */
  #tokenLog(device, kind, provider, why = {}) {
    const set =
      provider === 'apns'
        ? (this.apns.find((s) => s.topic === why.topic) ?? (this.apns.length === 1 ? this.apns[0] : undefined))
        : undefined;
    const environment = set ? (set.sandbox ? 'sandbox' : 'production') : undefined;
    this.log('push_token', {
      device,
      kind,
      provider,
      environment,
      topic: set?.topic,
      apns: why.apns,
      reason: why.reason,
      at: this.now(),
    });
  }

  async unregister(/** @type {string} */ deviceId, /** @type {string | undefined} */ token = undefined) {
    await this.store.deletePushToken(deviceId, token);
    // a dead token that the phone has already replaced leaves the phone's notice memory alone
    if (token === undefined || (await this.store.pushTokenOf(deviceId)) === null) this.notifiers.delete(deviceId);
  }

  /** The push-to-update token of the phone's running Live Activity (it changes with every activity). */
  async registerActivity({ deviceId, userId, token }) {
    await this.store.setActivityToken({ deviceId, userId, token, now: this.now() });
  }

  /**
   * A freshly registered activity is sent the state already held, so it does not start empty. The caller runs this after answering the phone,
   * so a slow provider holds up neither the phone's other messages nor the answer. Only a state with something in it is sent: an empty one would end the activity just started.
   */
  async refreshActivity(/** @type {string} */ deviceId) {
    const held = this.activities.merged(deviceId, this.now());
    if (this.send && held && held.needs + held.running > 0) await this.#activityPush(deviceId);
  }

  async unregisterActivity(/** @type {string} */ deviceId) {
    await this.store.deleteActivityToken(deviceId);
    this.lastNeeds.delete(deviceId);
  }

  /**
   * A Mac's snapshot of its chats (already parsed): kept for the pair and pushed to the phone's Live Activity as the merge of its pairs.
   * @param {{ phoneDeviceId: string, pairId: string }} pair @param {NonNullable<ReturnType<typeof import('./activity.mjs').parseSnapshot>>} snapshot
   * @returns {Promise<'disabled' | 'no_token' | 'sent' | 'failed'>}
   */
  async activity(pair, snapshot) {
    this.activities.set(pair.phoneDeviceId, pair.pairId, snapshot, this.now());
    const status = this.send ? await this.#activityPush(pair.phoneDeviceId) : 'disabled';
    this.metrics.inc('relay_activity_updates_total', { status }, 1, 'Live Activity updates from Macs, by outcome');
    return status;
  }

  /**
   * One update at a time per phone, and the newest state wins: an update asked for while one is out is folded into one more send that reads the state when it runs.
   * @returns {Promise<'no_token' | 'sent' | 'failed'>}
   */
  #activityPush(/** @type {string} */ phone) {
    let slot = this.activitySlots.get(phone);
    if (slot?.run) {
      slot.again = true;
      return /** @type {Promise<'no_token' | 'sent' | 'failed'>} */ (slot.run);
    }
    slot = { run: null, again: false };
    this.activitySlots.set(phone, slot);
    const mine = slot;
    mine.run = (async () => {
      let status = /** @type {'no_token' | 'sent' | 'failed'} */ ('no_token');
      try {
        do {
          mine.again = false;
          status = await this.#activitySend(phone);
        } while (mine.again);
      } finally {
        this.activitySlots.delete(phone);
      }
      return status;
    })();
    return /** @type {Promise<'no_token' | 'sent' | 'failed'>} */ (mine.run);
  }

  /** @returns {Promise<'no_token' | 'sent' | 'failed'>} */
  async #activitySend(/** @type {string} */ phone) {
    const token = await this.store.activityTokenOf(phone);
    if (!token) {
      this.lastNeeds.delete(phone);
      return 'no_token';
    }
    const now = this.now();
    // no snapshot left (the pair was removed, or the Mac went quiet): the activity is told it is over, and leaves at once
    const held = this.activities.merged(phone, now);
    const state = held ?? { needs: 0, running: 0, kind: 'done', since: 0, rows: [] };
    const over = state.needs + state.running === 0;
    const last = this.lastNeeds.get(phone);
    const rise = state.needs > (last?.token === token ? last.needs : 0);
    // with several APNs credential sets the one that last sent to this activity goes first
    const topic = this.apns.length > 1 ? ((await this.store.activityTopicOf(phone, token)) ?? undefined) : undefined;
    const result = await /** @type {NonNullable<typeof this.send>} */ (this.send)({
      platform: 'apns',
      token,
      ...(topic && { topic }),
      kind: 'activity',
      title: '',
      count: 0,
      collapseId: '',
      ref: '',
      activity: {
        timestamp: Math.floor(now / 1000),
        event: over ? 'end' : 'update',
        state,
        staleAt: Math.floor((now + STALE_MS) / 1000),
        dismissAt: Math.floor((now + (held && state.kind === 'done' ? FINISHED_LINGER_MS : 0)) / 1000),
        priority: rise ? 10 : 5,
      },
    });
    // a dead activity token is the activity's, not the phone's: the phone's alert token stays; and only the token that was sent is removed,
    // so Apple's late answer about an ended activity cannot remove the one the phone registered since
    if (result.invalidToken) {
      await this.store.deleteActivityToken(phone, token);
      if (this.lastNeeds.get(phone)?.token === token) this.lastNeeds.delete(phone);
    } else if (result.ok) {
      this.lastNeeds.set(phone, { token, needs: state.needs });
      if (result.topic && result.topic !== topic)
        await this.#remember(() => this.store.setActivityTopic(phone, token, /** @type {string} */ (result.topic)));
    }
    return result.ok ? 'sent' : 'failed';
  }

  /**
   * @param {{ phoneDeviceId: string, pairId: string }} pair
   * @returns {Promise<'disabled' | 'no_token' | 'suppressed' | 'sent' | 'failed'>}
   */
  async request(
    pair,
    /** @type {string} */ kind,
    /** @type {string} */ ref,
    /** @type {string} */ sealed = '',
    /** @type {string} */ card = '',
    /** @type {boolean} */ fromHost = false,
    /** @type {string} */ sealedBody = '',
  ) {
    const status = await this.#ordered(pair, kind, ref, sealed, card, fromHost, sealedBody);
    this.metrics.inc('relay_push_requests_total', { status, kind }, 1, 'Push requests from Macs, by outcome and kind');
    return status;
  }

  /**
   * One chat's pushes go out in the order they were asked for (a retried "done" must not overtake the "needs you" that followed it
   * and replace it on the phone), and one phone has at most MAX_PER_PHONE requests out or waiting, so a Mac cannot take the
   * provider's room from everyone else.
   * @returns {Promise<'disabled' | 'no_token' | 'suppressed' | 'sent' | 'failed'>}
   */
  async #ordered(
    pair,
    /** @type {string} */ kind,
    /** @type {string} */ ref,
    /** @type {string} */ sealed,
    /** @type {string} */ card,
    /** @type {boolean} */ fromHost,
    /** @type {string} */ sealedBody,
  ) {
    const phone = pair.phoneDeviceId;
    const busy = this.pending.get(phone) ?? 0;
    if (busy >= MAX_PER_PHONE) return 'failed';
    this.pending.set(phone, busy + 1);
    const key = `${pair.pairId}:${ref}`;
    const run = (this.chains.get(key) ?? Promise.resolve()).then(() => this.#request(pair, kind, ref, sealed, card, fromHost, sealedBody));
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    try {
      return await run;
    } finally {
      if (this.chains.get(key) === tail) this.chains.delete(key);
      const left = /** @type {number} */ (this.pending.get(phone)) - 1;
      if (left > 0) this.pending.set(phone, left);
      else this.pending.delete(phone);
    }
  }

  /** @returns {Promise<'disabled' | 'no_token' | 'suppressed' | 'sent' | 'failed'>} */
  async #request(
    pair,
    /** @type {string} */ kind,
    /** @type {string} */ ref,
    /** @type {string} */ sealed,
    /** @type {string} */ card,
    /** @type {boolean} */ fromHost,
    /** @type {string} */ sealedBody,
  ) {
    if (!this.send) return 'disabled';
    const target = await this.store.pushTokenOf(pair.phoneDeviceId);
    if (!target) return 'no_token';
    const now = this.now();
    let notifier = this.notifiers.get(pair.phoneDeviceId);
    if (!notifier) this.notifiers.set(pair.phoneDeviceId, (notifier = new Notifier()));
    // the same handle in two pairs is two chats
    const handle = `${pair.pairId}:${ref}`;
    const shown = notifier.push(kind, handle, now, fromHost);
    if (!shown) return 'suppressed';
    const hash = (/** @type {string} */ s) => createHash('sha256').update(s).digest('hex').slice(0, 32);
    // a clearing replaces what the chat's "needs you" was shown as: its own notification, or the merged "(n)" it joined
    const collapseId =
      kind === 'cleared' ? (notifier.takeCollapse(handle) ?? hash(handle)) : shown.merged ? `merged:${kind}` : hash(handle);
    if (shown.merged && kind === 'needsYou') notifier.remember(handle, collapseId, now);
    const result = await this.send({
      ...target,
      kind,
      title: shown.title,
      count: shown.count,
      collapseId,
      ref,
      // a merged "(n)" title stands for several chats, so one chat's sealed title would be wrong on it; MoMo and offline pushes keep their fixed titles
      ...(sealed && !shown.merged && (kind === 'needsYou' || kind === 'done') && { sealed }),
      // likewise one MoMo card: a merged push opens MoMo's chat
      ...(card && !shown.merged && kind === 'momoNeedsYou' && { card }),
      // and MoMo's opt-in body, which only the phone can open: a merged push names no routine
      ...(sealedBody && !shown.merged && kind === 'momoNeedsYou' && { sealedBody }),
    });
    // what the provider answered, never a token, a chat handle or a sealed title: a push that did not arrive can be told from one that was refused
    this.log('push', {
      kind,
      provider: target.platform,
      outcome: result.ok ? 'sent' : 'failed',
      apns: result.status,
      reason: result.reason,
    });
    if (result.invalidToken) {
      this.#tokenLog(pair.phoneDeviceId, 'rejected', target.platform, { apns: result.status, reason: result.reason, topic: result.topic });
      await this.unregister(pair.phoneDeviceId, target.token);
    } else if (result.ok && result.topic && result.topic !== target.topic) {
      await this.#remember(() => this.store.setPushTopic(pair.phoneDeviceId, target.token, /** @type {string} */ (result.topic)));
    }
    // a notice that did not go out is not remembered as shown: it would hold back a later one for this chat and count in a merged "(n)"
    if (!result.ok) shown.undo();
    return result.ok ? 'sent' : 'failed';
  }

  /** Remembering which credential set a token belongs to only saves a rejected try next time: a store that fails here must not turn a push that went out into an error. */
  async #remember(/** @type {() => Promise<void>} */ write) {
    try {
      await write();
    } catch (e) {
      this.log('push_topic_failed', { message: messageOf(e) });
    }
  }

  /**
   * A pair was removed: its chats are forgotten, and a phone left with no pair at all loses its token (nothing may push to a phone that has unpaired from every Mac).
   * @param {string} pairId @param {string | null} phoneDeviceId
   */
  async pairRemoved(pairId, phoneDeviceId) {
    if (!phoneDeviceId) return;
    this.notifiers.get(phoneDeviceId)?.forgetPair(pairId);
    this.activities.forgetPair(pairId);
    if (!(await this.store.phoneHasPair(phoneDeviceId))) {
      await this.unregister(phoneDeviceId);
      // the phone is leaving every Mac: the activity is ended first, then its token goes
      if (this.send) await this.#activityPush(phoneDeviceId);
      await this.unregisterActivity(phoneDeviceId);
    } else if (this.send) await this.#activityPush(phoneDeviceId);
  }

  prune(/** @type {number} */ now) {
    const shown = [...this.activities.byPhone.keys()];
    this.activities.prune(now);
    // a phone whose last snapshot expired (its Mac went to sleep or quit) is told the activity is over rather than left with a stale frame
    for (const phone of shown) {
      if (this.activities.byPhone.has(phone) || !this.send) continue;
      this.#activityPush(phone).catch(() => this.metrics.inc('relay_activity_updates_total', { status: 'failed' }, 1));
    }
    for (const [id, n] of this.notifiers) {
      n.prune(now);
      if (!n.byRef.size && !n.groups.size) this.notifiers.delete(id);
    }
  }
}

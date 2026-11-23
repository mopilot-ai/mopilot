// A chat whose turn ended on its harness's usage limit follows two independent preferences (Settings → General): switch
// to another first-tier harness, or resume when its quota resets. Main owns it on every harness, so it
// works with no window open and two windows cannot both send the Continue.
const { addHook, addGuard } = require('./hookChain.cjs');
const { guardInput } = require('./contract/inputGuard.cjs');
const crypto = require('node:crypto');
const { clock } = require('../platform/ports/clock.cjs');
const { noteIgnored } = require('../ignored.cjs');
const { authoredOr } = require('./authoredInput.cjs');
const { configuredSwitchModel } = require('../../shared/switchModel.mjs');
const { modelLabel } = require('../../shared/modelLabels.mjs');

/** What the chat sends to pick up the turn the limit cut off. */
const CONTINUE_TEXT = 'Continue';
/** The quota is read as back this long after the time the registry names. */
const RESET_GRACE_MS = 30_000;
/** How long after the limit's turn ends before main acts: the account pool may have moved the chat on meanwhile. */
const SETTLE_MS = 2500;
/** setTimeout's longest wait. */
const MAX_TIMER_MS = 2 ** 31 - 1;
/** What a send's receipt says when the harness took the message (shared/sendReceipt.mjs). */
const ACCEPTED = new Set(['started', 'dispatched']);
const SHOWN = Object.freeze({ by: 'mopilot', title: 'Continuing after the usage limit' });

/**
 * @typedef {{ chatId: string, turnId: string | null, kind: string, afterSwitch: boolean, timer: unknown, itemId: string | null }} Owner
 */

class LimitContinuation {
  /**
   * @param {object} o
   * @param {any} o.controller the ChatController whose hooks feed this
   * @param {AbortSignal} [o.signal] ends it (a test's); the app's lasts as long as the controller
   * @param {() => boolean} o.resumeEnabled resume on this harness after its quota resets
   * @param {() => boolean} o.switchEnabled switch to another harness at a usage limit
   * @param {(kind: string) => boolean} o.exhausted all usable accounts of the source harness have run out
   * @param {() => any} [o.prefs] the destination harness's configured model, captured with its pending switch
   * @param {(chatId: string, own: string) => Promise<string | null>} o.choose the first-tier harness that can run instead of `own`
   * @param {(kind: string) => number | null} o.resetAt when `kind`'s usage is back (ms), null when unknown or not out
   * @param {(chatId: string, item: object) => Promise<{ action?: string } | undefined>} o.send
   * @param {((chatId: string, text: string, show: { by: string, title: string }) => object) | null} [o.make] an authored input (authoredInput.cjs)
   */
  constructor({
    controller,
    signal = new AbortController().signal,
    resumeEnabled,
    switchEnabled,
    exhausted,
    choose,
    resetAt,
    send,
    make = null,
    prefs = () => ({}),
  }) {
    this.controller = controller;
    this.signal = signal;
    this.resumeEnabled = resumeEnabled;
    this.switchEnabled = switchEnabled;
    this.exhausted = exhausted;
    this.prefs = prefs;
    this.choose = choose;
    this.resetAt = resetAt;
    this.send = send;
    this.make = make;
    /** @type {Map<string, string>} chat → the kind of harness whose turn hit the limit, until that turn ends */
    this.hits = new Map();
    /** @type {Map<string, Owner>} */
    this.owners = new Map();
    /** chats whose Continue the app sent after a switch: a limit in that turn means both harnesses are out */
    this.switched = new Set();
    /** @type {Set<string>} ids of the Continue items this sends, which are not a newer input */
    this.own = new Set();
    addHook(controller, 'onLimit', (/** @type {string} */ chatId) => this.hit(chatId));
    addHook(controller, 'onFinished', (/** @type {{ chatId: string, turnId?: string | null }} */ e) => this.finished(e));
    addGuard(controller, 'beforeDispatch', (/** @type {{ chatId: string, item: { id?: string } }} */ e) => {
      if (!e.item?.id || !this.own.has(e.item.id)) this.retire(e.chatId);
    });
    for (const name of ['onCrash', 'onInterrupt', 'onStopped'])
      addHook(controller, name, (/** @type {string} */ chatId) => this.retire(chatId));
    signal.addEventListener('abort', () => [...this.owners.keys()].forEach((id) => this.retire(id)), { once: true });
  }

  /** Either independent preference can take up a limited turn. */
  enabled() {
    return this.resumeEnabled() || this.switchEnabled();
  }

  /** A source-account failover may still be running after the settlement delay. */
  canSwitch(kind) {
    return this.switchEnabled() && this.exhausted(kind);
  }

  /** The chat's running turn is ending on its harness's usage limit. */
  hit(chatId) {
    if (this.signal.aborted) return;
    try {
      this.hits.set(chatId, this.controller.ref(chatId).kind);
    } catch (error) {
      noteIgnored('read the harness of a chat at its usage limit', error);
    }
  }

  /** Drops what the chat waits to do: its user's message, a Stop, a crash or a newer limit replaced it. */
  retire(chatId) {
    this.hits.delete(chatId);
    this.switched.delete(chatId);
    const owner = this.owners.get(chatId);
    if (!owner) return;
    this.owners.delete(chatId);
    clock.clearTimeout(/** @type {any} */ (owner.timer));
  }

  /** A turn ended: one that ended on the limit is taken up, once. */
  /** @param {{ chatId: string, turnId?: string | null }} e */
  finished({ chatId, turnId = null }) {
    const kind = this.hits.get(chatId);
    this.hits.delete(chatId);
    const afterSwitch = this.switched.delete(chatId);
    if (!kind || this.signal.aborted || !this.enabled()) return;
    // every harness reports a limit more than once
    if (this.owners.get(chatId)?.turnId === turnId) return;
    this.retire(chatId);
    /** @type {Owner} */
    const owner = { chatId, turnId, kind, afterSwitch, timer: null, itemId: null };
    this.owners.set(chatId, owner);
    owner.timer = clock.setTimeout(
      () => void this.settle(owner).catch((e) => noteIgnored('continue a chat at its usage limit', e)),
      SETTLE_MS,
    );
  }

  /** The chat is still where the limit left it: nothing runs, queues or waits to run. */
  stopped(owner) {
    if (this.signal.aborted || !this.enabled() || this.owners.get(owner.chatId) !== owner) return false;
    const c = this.controller;
    const s = c.state.get(owner.chatId);
    return s.turn === 'idle' && !s.activeTurn && !s.queue.length && !s.pendingSwitch && c.ref(owner.chatId).kind === owner.kind;
  }

  async settle(owner) {
    if (!this.stopped(owner)) return;
    // one automatic switch per limit: a limit in the Continue it sent means the other harness is out too
    const to = !owner.afterSwitch && this.canSwitch(owner.kind) ? await this.choose(owner.chatId, owner.kind) : null;
    if (!this.stopped(owner)) return;
    if (to && this.canSwitch(owner.kind)) return void (await this.switchTo(owner, to));
    this.wait(owner);
  }

  /** Readies the switch and sends Continue, which settles it. */
  async switchTo(owner, harness) {
    const { chatId } = owner;
    const model = configuredSwitchModel(harness, null, this.prefs());
    this.controller.state.patch(chatId, {
      pendingSwitch: { harness, model, modelLabel: model ? modelLabel(model) : '', mode: 'auto' },
    });
    const ps = this.controller.state.get(chatId).pendingSwitch;
    this.switched.add(chatId);
    const started = await this.sendContinue(owner, 'switch');
    if (started) return;
    this.switched.delete(chatId);
    // the switch the failed send left is not the user's choice
    if (this.controller.state.get(chatId).pendingSwitch === ps) this.controller.state.patch(chatId, { pendingSwitch: null });
  }

  /** Sends Continue when the registry says the quota is back; a time it does not know leaves the note's button. */
  wait(owner) {
    if (!this.resumeEnabled()) return;
    const at = this.resetAt(owner.kind);
    if (at === null) return;
    this.arm(owner, at + RESET_GRACE_MS);
  }

  arm(owner, at) {
    owner.timer = clock.setTimeout(
      () => {
        if (!this.resumeEnabled() || !this.stopped(owner)) return;
        if (clock.now() < at) return this.arm(owner, at);
        // limited again for longer: wait for that
        const later = this.resetAt(owner.kind);
        if (later !== null && later + RESET_GRACE_MS > clock.now()) return this.arm(owner, later + RESET_GRACE_MS);
        void this.sendContinue(owner, 'reset').catch((e) => noteIgnored('continue a chat when its usage is back', e));
      },
      Math.min(Math.max(at - clock.now(), 0), MAX_TIMER_MS),
    );
  }

  /** @returns {Promise<boolean>} whether the harness took the message */
  async sendContinue(owner, mode) {
    const made = /** @type {{ id?: string }} */ (authoredOr(this.make, owner.chatId, CONTINUE_TEXT, SHOWN));
    const item = { ...made, id: made.id ?? crypto.randomUUID() };
    this.own.add(item.id);
    guardInput(
      item,
      () => this.owners.get(owner.chatId) === owner && (mode === 'switch' ? this.canSwitch(owner.kind) : this.resumeEnabled()),
    );
    try {
      return ACCEPTED.has((await this.send(owner.chatId, item))?.action ?? '');
    } finally {
      this.own.delete(item.id);
    }
  }
}

module.exports = { LimitContinuation, CONTINUE_TEXT, RESET_GRACE_MS, SETTLE_MS };

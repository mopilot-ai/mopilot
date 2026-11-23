// The ChatController's send paths that wait before they send: a Claude message whose images are read first
// (electron/harness/claude/message.cjs) keeps the chat's sends in order and is not sent once its turn was stopped or ended;
// a Stop pressed after any send began and before its harness took the prompt cancels that send (stopGuard); a
// message that did not start goes back first in line in the order it was sent. ACP prompts go through here too.
const crypto = require('node:crypto');
const { withInput } = require('./userTurn.cjs');
const { asGoalCommand } = require('./goalCommand.cjs');
const { queueItem } = require('./queueItem.cjs');
const { traitsOf } = require('../harness/family.cjs');
const { errorText } = require('../../shared/userError.mjs');
const { ignoring, messageOf, noteIgnored } = require('../ignored.cjs');
const { sendReceipt } = require('../../shared/sendReceipt.mjs');
const { buildClaudeMessage, claudeMessage, hasImages, withMomoMessage, messageText } = require('../harness/claude/message.cjs');
const { busy } = require('./controllerEvents.cjs');
const { momoContextFor, forgetMomoSent } = require('../momo/contract/context.cjs');
const { ControllerQueue } = require('./controllerQueue.cjs');
const { assertInputCurrent, guardSend, inputIsGuarded } = require('./contract/inputGuard.cjs');
const { holdCompaction, retireCompaction } = require('./compactionQueue.cjs');
const { assertRetryAdmission } = require('./retryAdmission.cjs');
const { startCompact } = require('../harness/compact.cjs');

const { voiceWriter } = require('./voice.cjs');
const { folderMutation } = require('./folderMutation.cjs');

const STOPPED = 'Stopped before this message was sent';
/** What a message that did not come through the chat's window hears for a chat that runs on another machine: it is not sent there from here yet (#4738). */
const ON_MACHINE = 'This chat runs on another machine, and this message is not sent there yet.';

/** @typedef {InstanceType<typeof import('./controller.cjs').ChatController>} ChatController */
/** @typedef {import('../../shared/sendReceipt.mjs').SendReceipt} SendReceipt */
/** @typedef {{ action: 'started' | 'steered' | 'queued', id: string } | { action: 'failed', id: string, error: string }} SendIntent */

// This layer owns no state of its own: it uses the controller's per-chat runtime (rt) and session state.
class ControllerSends extends ControllerQueue {
  /** @type {((chatId: string, item: any) => void) | undefined} a message now waits in the chat's queue (orchestration hooks it) */
  onQueued = undefined;

  /** @type {{ wants(attachments: any): boolean, keep(chatId: string, attachments: any[]): Promise<any[]> } | null} keeps a sent picture past the temp folder's prune (platform/chatPictures.cjs, set by app/chatPicturesWiring.cjs) */
  pictures = null;

  /** A turn or steer on the current adapter, with audio admitted before dispatch. @this {ChatController} */
  dispatch(chatId, kind, item, origin) {
    if (voiceWriter(this, chatId)) return Promise.resolve({ started: false, error: 'Voice conversation is still active' });
    if (this.obsoleteGoalCommand(chatId, item)) return Promise.resolve({ started: false, discarded: true });
    const ref = this.ref(chatId);
    const adapter = this.adapterFor(ref.kind);
    if (item.attachments?.some((a) => a.kind === 'audio') && !adapter.audioInput)
      return Promise.resolve({ started: false, error: 'This chat does not accept audio messages. Use Dictate to send text.' });
    const traits = traitsOf(ref.kind);
    const rt = this.rt(chatId);
    const attempt = { token: rt.token, startAttempt: rt.startAttempt };
    const active = this.state.get(chatId).activeTurn;
    const engagement =
      kind === 'steer' && item.opts.human && !item.peer && active ? { token: rt.token, version: (rt.engagementVersion ?? 0) + 1 } : null;
    // A user can join an automatic goal turn. Keep its original provenance, but
    // let tools see that the current turn now has actual user input. Queued input
    // has not reached this turn and must not change its attendance.
    if (engagement) {
      if (rt.engagementToken !== rt.token) {
        rt.engagementToken = rt.token;
        rt.engagementBase = !!active.userEngaged;
        rt.engagements = new Set();
      }
      rt.engagementVersion = engagement.version;
      rt.engagements.add(engagement.version);
      this.state.patch(chatId, { activeTurn: { ...active, userEngaged: true } });
    }
    const run = () => {
      if (rt.token !== attempt.token || rt.startAttempt !== attempt.startAttempt) return { started: false, error: 'turn_changed' };
      if (kind === 'steer' && !item.peer && !busy(this.state.get(chatId))) return { started: false, error: 'turn_ended' };
      // input no human wrote reaching the turn it was sent to: that turn is no longer the user's word (#2249)
      const turn = this.state.get(chatId).activeTurn;
      if (kind === 'steer' && withInput(turn, item) !== turn) this.state.patch(chatId, { activeTurn: withInput(turn, item) });
      if (item.opts.compact) {
        if (turn) this.state.patch(chatId, { activeTurn: { ...turn, compact: true } });
        const current = this.turnCheck(chatId);
        return startCompact(
          adapter,
          chatId,
          ref,
          item,
          origin,
          () => this.state.get(chatId),
          () => {
            current();
            const selected = this.ref(chatId);
            if (selected.kind !== ref.kind || selected.key !== ref.key || selected.instance !== ref.instance)
              throw new Error('The chat changed before compaction started.');
          },
        );
      }
      if (kind === 'steer' && traits.steers) return adapter.steer(chatId, ref, item, origin);
      if (item.opts.goal && traits.nativeGoal) return adapter.startGoal(chatId, ref, item, origin);
      return adapter.startTurn(chatId, ref, traits.nativeGoal ? item : asGoalCommand(item), origin);
    };
    const delivery = { chatId, kind, item, ref };
    return (async () => {
      let result;
      try {
        // the pasted or sketched pictures are kept before any adapter or journal records their path (#5183)
        const pictures = this.pictures;
        if (pictures?.wants(item.attachments)) {
          // in place: the queue and a retry hold this same item and must not keep the temp path either
          item.attachments = await pictures.keep(chatId, item.attachments);
        }
        this.chromeContinuationCheck?.(delivery);
        if (this.beforeDispatch) await this.beforeDispatch(delivery);
        this.chromeContinuationCheck?.(delivery);
        result = await run();
      } catch (error) {
        noteIgnored('dispatch a chat message', error);
        result = { started: false, error: errorText(error), ...(error?.queuedFallback ? { queuedFallback: true } : {}) };
      }
      if (engagement && !result?.started && rt.token === engagement.token && this.state.get(chatId).activeTurn) {
        rt.engagements.delete(engagement.version);
        this.state.patch(chatId, {
          activeTurn: { ...this.state.get(chatId).activeTurn, userEngaged: rt.engagementBase || rt.engagements.size > 0 },
        });
      }
      // A journal ACK failure after native acceptance cannot turn that acceptance into a rejection.
      try {
        await this.onDispatchResult?.({ ...delivery, result });
      } catch (error) {
        noteIgnored('save a dispatched message receipt', error);
        result = { ...result, receiptError: errorText(error) };
      }
      return result;
    })();
  }

  /**
   * @overload
   * @param {string} chatId
   * @param {any} item
   * @param {number | null} [origin]
   * @param {false} [waitForDelivery]
   * @returns {SendIntent}
   */
  /**
   * @overload
   * @param {string} chatId
   * @param {any} item
   * @param {number | null | undefined} origin
   * @param {true} waitForDelivery
   * @returns {Promise<SendReceipt>}
   */
  /**
   * A message from a window. Starts a turn when the chat is idle; while a turn runs it is queued,
   * or steered into the turn when the user asked for that and it carries no plan, goal or switch.
   * @this {ChatController}
   * @returns {SendIntent | Promise<SendReceipt>}
   */
  send(chatId, item, origin, waitForDelivery = false) {
    // a chat a Switch host is moving keeps whatever is sent to it in the durable outbox, and it goes to the chat's owner once the move ends (electron/host/remoteSendRebase.cjs)
    const held = this.remote.moving?.(chatId) ? this.remote.hold?.(chatId, item, origin) : null;
    if (held) return waitForDelivery ? Promise.resolve(held) : held;
    // a chat on another machine is sent to through its window's route (electron/host/remoteSend.cjs); any other sender is refused, never started on this Mac's agent host (#4738)
    if (this.remote.owns?.(chatId)) {
      const refused = /** @type {SendIntent} */ ({ action: 'failed', id: item?.id ?? crypto.randomUUID(), error: ON_MACHINE });
      return waitForDelivery ? Promise.resolve(refused) : refused;
    }
    const s = this.state.get(chatId);
    // A Retry is conditional human input. Reject a stale window before it can queue or steer into newer work.
    assertRetryAdmission(this.state, chatId, item, !!voiceWriter(this, chatId));
    const compact = item?.opts?.compact && s.queue.find((q) => q.opts.compact && q.opts.compact.args === item.opts.compact.args);
    if (compact) {
      const receipt = /** @type {SendIntent} */ ({ action: 'queued', id: compact.id });
      return waitForDelivery ? Promise.resolve(receipt) : receipt;
    }
    const q = queueItem(item, origin);
    // Keep a retry visible to every window if native admission later fails, including after a writer lock or reload.
    if (item?.retryAtRevision !== undefined) q.opts.retainInMain = true;
    this.audioPending?.admit(chatId, q);
    const steering =
      item?.followUp === 'steer' &&
      traitsOf(this.ref(chatId).kind).steers &&
      !q.opts.compact &&
      !q.opts.plan &&
      !q.opts.goal &&
      !s.pendingSwitch;
    // a message waiting in the queue is still the user's word to the chat's turn (orchestration: an offer's card)
    const queued = () => {
      this.onQueued?.(chatId, q);
      const receipt = /** @type {SendIntent} */ ({ action: 'queued', id: q.id });
      return waitForDelivery ? Promise.resolve(receipt) : receipt;
    };
    if ((!busy(s) || steering) && holdCompaction(this, chatId, q)) return queued();
    if (folderMutation(this, chatId)) {
      this.state.patch(chatId, { queue: [...s.queue, q] });
      return queued();
    }
    if (voiceWriter(this, chatId) || busy(s)) {
      // a harness that can't steer (ACP has no way into a running prompt): follow-ups always queue
      if (steering && !voiceWriter(this, chatId)) {
        // steer() keeps a message the harness didn't take; only its own bookkeeping can fail here
        const sending = this.steer(chatId, q, origin);
        if (waitForDelivery) return this.waitForSend(chatId, q, sending, 'steered');
        sending.catch(ignoring('steer a message into the running turn'));
        return { action: 'steered', id: q.id };
      }
      this.state.patch(chatId, { queue: [...s.queue, voiceWriter(this, chatId) ? { ...q, waitingFor: 'voiceConversation' } : q] });
      return queued();
    }
    const sending = this.startOrKeep(chatId, q);
    if (waitForDelivery) return this.waitForSend(chatId, q, sending);
    sending.catch(ignoring('keep a message that did not start in the queue'));
    return { action: 'started', id: q.id };
  }

  /**
   * Starts a turn with the item. One that does not start, including a start that throws, waits first in the
   * queue; a peer delivery keeps its own failure record instead. Resolves with the start's result.
   * @this {ChatController}
   */
  startOrKeep(chatId, item) {
    // a message that reaches a start while a Switch host moves the chat (a retry, Send now) is kept for the move, off the queue it was in
    if (this.remote.moving?.(chatId)) {
      const held = this.remote.hold?.(chatId, item, item.origin ?? null);
      if (held?.action === 'queued') this.removeQueued(chatId, item.id, false);
      // one that could not be kept stays where it was, with the cause
      else if (!this.state.get(chatId).queue.some((q) => q.id === item.id)) this.queueFirst(chatId, item, true);
      return Promise.resolve(held?.action === 'queued' ? { started: false, queuedFallback: true } : { started: false, error: held?.error });
    }
    if (this.remote.owns?.(chatId)) return Promise.resolve({ started: false, error: ON_MACHINE });
    this.audioPending?.admit(chatId, item);
    if (voiceWriter(this, chatId)) {
      if (!this.state.get(chatId).queue.some((q) => q.id === item.id)) this.queueFirst(chatId, item);
      return Promise.resolve({ started: false });
    }
    if (holdCompaction(this, chatId, item)) return Promise.resolve({ started: false, compactionQueued: true });
    return this.start(chatId, item)
      .catch((error) => ({ started: false, error: messageOf(error) }))
      .then((result) => {
        if (result?.discarded) {
          this.drain(chatId)?.catch(ignoring('send input after a superseded command'));
          return result;
        }
        const state = this.state.get(chatId);
        // held: a window took it to send once the chat is free (Codex's writer lock), so it isn't queued here too
        if (
          !result?.started &&
          !result?.held &&
          !result?.compactionQueued &&
          !item.peer &&
          !inputIsGuarded(item) &&
          !state.queue.some((x) => x.id === item.id)
        )
          this.queueFirst(chatId, result?.retryItem ?? item, true);
        return result;
      });
  }

  /** A renderer receipt distinguishes native acceptance from retained input, without dispatching again. @this {ChatController} */
  async waitForSend(chatId, item, sending, accepted = 'started') {
    const result = await sending;
    const queued = this.state.get(chatId).queue.some((q) => q.id === item.id);
    // Its hold may already have been claimed by release; admission still owns the input, not a second composer draft.
    if (result?.compactionQueued) return /** @type {SendReceipt} */ ({ action: 'queued', id: item.id });
    return sendReceipt(result, item.id, queued, accepted);
  }

  /**
   * The user (or MoPilot for them) stopped the chat: every send that began before this and has not reached its
   * harness yet is not sent (stopCheck). Counted, so a Stop before a send began never blocks it.
   * @this {ChatController}
   */
  noteStop(chatId) {
    retireCompaction(this, chatId);
    const r = this.rt(chatId);
    r.stops = (r.stops ?? 0) + 1;
  }

  /**
   * The harness names the turn the user started (turn/start's answer or turn/started): its token becomes the id, and a Stop that came meanwhile is carried out.
   * @this {ChatController}
   */
  nameTurn(chatId, id) {
    this.state.patch(chatId, { activeTurn: { ...this.state.get(chatId).activeTurn, id } });
    if (id) this.stopIfAsked(chatId);
  }

  /**
   * A Stop that came while a Codex turn was starting reached `turn/interrupt` with nothing to name: the turn had only its `pending-` token, and the
   * stop guard had let the send go because turn/start was already out. Once the turn has its id this carries that Stop out (once). A turn that
   * saw no Stop since it began does nothing here.
   * @this {ChatController}
   */
  stopIfAsked(chatId) {
    const r = this.rt(chatId);
    // a turn this controller did not start (no count taken) is no one's Stop to carry out
    if (!traitsOf(this.ref(chatId).kind).namesTurnLate || r.stopsAtStart === undefined || (r.stops ?? 0) === r.stopsAtStart) return;
    r.stopsAtStart = r.stops;
    Promise.resolve(this.codex.stopTurn(chatId)).catch((error) =>
      noteIgnored('carry out a Stop that came while a Codex turn started', error),
    );
  }

  /** A check that throws once the chat was stopped after it was made. @this {ChatController} */
  stopCheck(chatId) {
    const r = this.rt(chatId);
    const stops = r.stops ?? 0;
    return () => {
      if ((r.stops ?? 0) !== stops) throw new Error(STOPPED);
    };
  }

  /**
   * A send begins (ChatController.start, steer): until it is let go, a Stop means its prompt never reaches the
   * harness. Each adapter carries the item's guard to its transport, which checks it right before the prompt goes
   * (electron/harness/claude/sessions.cjs send, electron/harness/acp.cjs send, the Codex connection's turn/start). Returns
   * the release.
   * @this {ChatController}
   */
  stopGuard(chatId, item) {
    return guardSend(item, this.stopCheck(chatId));
  }

  /**
   * A check that throws once the chat's turn was stopped or replaced since it was made: a send that read its
   * images first (electron/harness/claude/message.cjs) is not started then. A stop seen before the check was made
   * doesn't count (a steer into a stopped turn goes on as before), the turn's end does.
   * @this {ChatController}
   */
  turnCheck(chatId) {
    const r = this.rt(chatId);
    const { token, startAttempt } = r;
    const stopped = this.stopCheck(chatId);
    return () => {
      if (r.token !== token || r.startAttempt !== startAttempt) throw new Error('The turn ended before this message was sent');
      stopped();
    };
  }

  /* -- Claude (the CLI runs in main: electron/harness/claude/index.cjs) -------------- */
  /**
   * Every Claude send goes through here, so the turn's bookkeeping sees each prompt. `input` is what
   * was typed and attached ({text, attachments, prefix}); the message is built here. Its images are read
   * first (sips converts HEIC, BMP, TIFF), off main's thread, so a chat's sends wait for the ones before
   * them and reach Claude in the order they were made, and one whose turn was stopped or ended meanwhile
   * is not sent. The turn's bookkeeping and claude.send then run with no await between them.
   * @this {ChatController}
   */
  async claudeSend(chatId, key, opts, input, priority, meta = {}) {
    const r = this.rt(chatId);
    const built = input && typeof input === 'object' && 'role' in input;
    // a MoMo chat's memory goes with a message that starts a turn (one the window built too), never with a steer into
    // the running one: decided as the message is built, after the sends ahead of it reached Claude (one of them may
    // have started the turn); a send that fails gives it back, so the next turn carries it
    let gave = false;
    const momo = () => {
      if (meta.compact || (priority === 'now' && busy(this.state.get(chatId)))) return null;
      const block = momoContextFor(chatId, { session: key, query: built ? messageText(input) : String(input?.text ?? '') });
      gave = !!block;
      return block;
    };
    const build = () => (built ? withMomoMessage(input, momo()) : { ...(input ?? { text: '' }), momo: momo() });
    const deliver = (/** @type {any} */ message) =>
      this.claudeDeliver(chatId, key, opts, message, priority, meta).catch((e) => {
        if (gave) forgetMomoSent(chatId, key);
        throw e;
      });
    if (!r.claudeSending && (built || !hasImages(input))) return deliver(built ? build() : buildClaudeMessage(build()));
    const current = this.turnCheck(chatId);
    const before = r.claudeSending;
    const step = (async () => {
      await before;
      const message = built ? build() : await claudeMessage(build(), this.readImage);
      current();
      // the sends after this one wait only for claude.send to be called, not for its answer
      return { sent: deliver(message) };
    })();
    const mine = step.then(
      () => undefined,
      () => undefined,
    );
    r.claudeSending = mine;
    try {
      return (await step).sent;
    } finally {
      if (r.claudeSending === mine) r.claudeSending = null;
    }
  }

  /**
   * claudeSend's bookkeeping and the send itself, with the message built. A send stopped since it began stops here,
   * before the bookkeeping forgets the Stop (interrupted).
   * @this {ChatController}
   */
  async claudeDeliver(chatId, key, opts, message, priority, meta) {
    assertInputCurrent(meta);
    const s = this.state.get(chatId);
    const r = this.rt(chatId);
    const steer = priority === 'now' && busy(s);
    if (steer) r.outstanding++;
    else {
      r.outstanding = 1;
      r.interrupted = false;
      if (!busy(s)) {
        r.token = `ct-${meta.uuid ?? crypto.randomUUID()}`;
        this.state.step(chatId, 'start', { turnId: r.token, human: !!meta.human });
      }
    }
    // chatId: the chat a new process's tool calls are recorded under
    // the turn's id as the window and the transcript name it (ct-/h-<prompt uuid>), not a queue item's pending- token
    if (!steer) this.turnSnapshots?.begin(chatId, key, opts?.cwd, meta.uuid ? `ct-${meta.uuid}` : null);
    if (!steer) return this.claude.send(key, { ...opts, chatId }, message, priority, meta);
    const token = r.token;
    try {
      return await this.claude.send(key, { ...opts, chatId }, message, priority, meta);
    } catch (e) {
      // a steer that never reached Claude has no result coming; if the turn's own came meanwhile, it ends now
      if (r.token === token && busy(this.state.get(chatId)) && !r.interrupted && --r.outstanding <= 0) this.end(chatId);
      throw e;
    }
  }

  /* -- ACP harnesses (electron/harness/acp.cjs run in main) ------------ */
  /** Every ACP prompt goes through here, so the turn's bookkeeping sees it. @this {ChatController} */
  async acpSend(chatId, key, payload, meta = {}) {
    // a send stopped since it began stops before the bookkeeping forgets the Stop (interrupted)
    assertInputCurrent(meta);
    const s = this.state.get(chatId);
    const r = this.rt(chatId);
    r.interrupted = false;
    if (!busy(s)) {
      r.token = `at-${meta.uuid ?? crypto.randomUUID()}`;
      this.state.step(chatId, 'start', { turnId: r.token, human: !!meta.human });
    }
    const receipt = await this.acp.send(key, payload, { ...meta, chatId });
    // computer use answers with what the agent takes in: screenshots, or text when it declares no image input
    const image = this.acp.takesImages?.(key);
    if (typeof image === 'boolean') this.state.patch(chatId, { modality: image ? 'image' : 'text' });
    return receipt;
  }

  /**
   * Stop pressed on an ACP chat: its turn ends without draining the queue. A session that is no longer the chat's
   * current one (the chat switched since) stops its own calls only (#1319 G17). `turnId`: the turn a button showed;
   * 'retired' and nothing stops when another one runs. @this {ChatController}
   * @param {string} key
   * @param {unknown} [turnId]
   */
  acpCancel(key, turnId) {
    const chatId = this.chatOf(key);
    if (!this.turnIs(chatId, turnId)) return 'retired';
    const interrupt = () => {
      if (this.isCurrentSource(chatId, { kind: 'acp', key })) {
        this.rt(chatId).interrupted = true;
        this.noteStop(chatId);
        this.interrupting(chatId);
      } else this.onInterrupt(chatId, key);
    };
    // a chat on another machine is stopped there; a Stop that does not reach it changes nothing here
    const remote = this.remote.stop(chatId, turnId);
    if (remote) return remote.then(() => (interrupt(), true));
    interrupt();
    return this.acp.cancel(key);
  }

  /**
   * Whether `turnId` (main's id for the turn a Stop button showed, as the window last heard it) is the chat's running
   * turn: its id, or the token it started under before the harness named it. No id: whatever runs. @this {ChatController}
   * @param {string} chatId
   * @param {unknown} [turnId]
   */
  turnIs(chatId, turnId) {
    if (turnId === undefined || turnId === null) return true;
    const id = this.state.get(chatId).activeTurn?.id;
    return !!id && (id === String(turnId) || this.rt(chatId).token === String(turnId));
  }
}

module.exports = { ControllerSends };

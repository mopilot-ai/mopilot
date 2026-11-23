// Durable cross-session protocol, independent of native harness ids and renderer lifetime.
const { clock } = require('../platform/ports/clock.cjs');
const { fs } = require('../platform/ports/fs.cjs');
const path = require('node:path');
const crypto = require('node:crypto');
const { peerPrompt } = require('../../shared/peerPrompt.mjs');
const { noteIgnored } = require('../ignored.cjs');
const { writePrivate } = require('../platform/fsutil.cjs');
const { HOLD_MS, holdReason } = require('./peerHold.cjs');
const { validJournal } = require('./peerJournal.cjs');
const { createInboxGuard, hopsFor, loopReason } = require('./peerInboxGuard.cjs');

const fail = (code) => {
  throw Object.assign(new Error(code), { code });
};

class PeerMessageService {
  /** authorize is a trusted main-process grant lookup, never a model-provided boolean.
   * gate returns a blocking reason using the receiving chat's current permissions/account.
   * The caller wires beforeDispatch/result to the controller's delivery hooks.
   * @param {object} o
   * @param o.file the journal (peer-messages.json)
   * @param o.controller ChatController: delivers, queues and steers into the receiving chat
   * @param o.exists (chatId) => boolean
   * @param o.authorize (sourceChatId, targetChatId, requestId) => false, or { sourceTurnId } (or a Promise of one)
   * @param o.gate (chatId) => blocking reason | null (or a Promise of one)
   * @param [o.temporary] (chatId) => boolean: the chat is not kept, nor are its messages
   * @param [o.publish] (data) => void: the journal changed
   * @param [o.write] (data) => void: replaces the journal write (tests)
   * @param [o.steerAvailability] (chatId) => why a running chat can't be steered, or null (or a Promise of one)
   * @param [o.titles] () => Promise of a Map of chat titles, kept on each message: an archived chat still reads by name
   * @param [o.permission] (chatId) => the chat's app permission now (peerHold.cjs chatPermission), or null
   * @param [o.inbox] the sender → receiver flood guard (peerInboxGuard.cjs createInboxGuard)
   */
  constructor({
    file,
    controller,
    exists,
    authorize,
    gate,
    temporary = () => false,
    publish = () => {
      /* no publisher */
    },
    write,
    steerAvailability = (_chatId) => null,
    titles = async () => new Map(),
    permission = (_chatId) => null,
    inbox = createInboxGuard(),
  }) {
    this.file = file;
    this.controller = controller;
    this.exists = exists;
    this.authorize = authorize;
    this.gate = gate;
    this.temporary = temporary;
    this.publish = publish;
    this.steerAvailability = steerAvailability;
    this.titles = titles;
    this.permission = permission;
    this.inbox = inbox;
    this.listeners = new Set();
    this.completions = new Map();
    this.write =
      write ??
      ((data) => {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        writePrivate(file, JSON.stringify(data));
      });
    this.data = { schemaVersion: 1, messages: [] };
    try {
      this.data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : this.data;
      if (!validJournal(this.data)) fail('invalid_journal');
      // Never replay a possibly accepted native input. Queued work requires explicit resume.
      const recovered = structuredClone(this.data);
      let changed = false;
      for (const m of recovered.messages) {
        if (['accepted', 'queued', 'submitting'].includes(m.delivery)) {
          m.errorCode = m.delivery === 'submitting' ? 'delivery_unknown_after_restart' : 'resume_required';
          m.delivery = m.delivery === 'submitting' ? 'uncertain' : 'blocked';
          changed = true;
        }
      }
      if (changed) this.commit(recovered);
    } catch {
      // Keep the original file intact and disable messaging; a damaged journal must
      // neither crash app startup nor become a fresh outbox that silently resends.
      this.startupError = 'journal_unavailable';
      this.data = { schemaVersion: 1, messages: [] };
    }
  }

  commit(data) {
    if (this.startupError) fail(this.startupError);
    const durable = {
      ...data,
      messages: data.messages.filter((m) => !m.temporary),
      ...(data.pausedChats ? { pausedChats: data.pausedChats.filter((id) => !this.temporary(id)) } : {}),
    };
    this.write(durable); // Fail closed: no in-memory success or native submission without durability.
    this.data = data;
    // Presentation failures must not change an already committed delivery decision.
    try {
      this.publish(structuredClone(data));
    } catch (error) {
      // presentation only; the journal is already durable
      noteIgnored('show the peer message journal', error);
    }
    for (const listener of [...this.listeners]) {
      try {
        listener();
      } catch (error) {
        // a failing listener must not stop the others
        noteIgnored('notify a peer message listener', error);
      }
    }
  }

  update(id, patch) {
    const data = structuredClone(this.data);
    const m = data.messages.find((x) => x.id === id);
    if (!m) fail('message_missing');
    Object.assign(m, patch);
    this.commit(data);
    return structuredClone(m);
  }

  get(sourceChatId, id) {
    if (this.startupError) fail(this.startupError);
    const m = this.data.messages.find((x) => x.id === id);
    if (!m || ![m.sourceChatId, m.targetChatId].includes(sourceChatId)) fail('message_unavailable');
    return structuredClone(m);
  }

  async send(sourceChatId, { targetChatId, requestId, body, requestReply = true, replyTo = null }) {
    if (this.startupError) fail(this.startupError);
    if (!this.exists(sourceChatId) || (!replyTo && !this.exists(targetChatId))) fail('chat_unavailable');
    if (sourceChatId === targetChatId) fail('self_send');
    if (typeof body !== 'string' || !body.trim() || Buffer.byteLength(body) > 32768) fail('invalid_body');
    if (typeof requestId !== 'string' || !requestId || requestId.length > 256) fail('invalid_request_id');
    const parent = replyTo ? this.get(sourceChatId, replyTo) : null;
    if (parent && (parent.targetChatId !== sourceChatId || parent.sourceChatId !== targetChatId || parent.delivery !== 'delivered'))
      fail('reply_unavailable');
    const dedupeKey = JSON.stringify([sourceChatId, requestId, targetChatId]);
    const fingerprint = JSON.stringify([body, requestReply, replyTo]);
    const previous = this.data.messages.find((m) => m.dedupeKey === dedupeKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) fail('idempotency_conflict');
      return structuredClone(previous);
    }
    const grant = parent ? true : await this.authorize(sourceChatId, targetChatId, requestId);
    if (!grant) fail('send_not_authorized');
    const titles = await this.titles();
    // Authorization and titles may await a lookup: another window can commit in that gap.
    const concurrent = this.data.messages.find((m) => m.dedupeKey === dedupeKey);
    if (concurrent) {
      if (concurrent.fingerprint !== fingerprint) fail('idempotency_conflict');
      return structuredClone(concurrent);
    }
    if (parent && (parent.reply !== 'awaiting' || this.data.messages.some((m) => m.replyTo === parent.id && m.delivery !== 'cancelled')))
      fail('reply_unavailable');
    if (
      this.data.messages.filter(
        (m) => m.targetChatId === targetChatId && ['accepted', 'queued', 'blocked', 'submitting', 'held'].includes(m.delivery),
      ).length >= 100
    )
      fail('queue_full');
    // a reply answers the receiver's own request (one per request): only a new request can flood or loop
    const refused = parent ? null : this.inbox.admit(sourceChatId, targetChatId, body);
    if (refused) fail(refused);
    // a reply continues its request's chain, so request → reply → request ping-pong still counts
    const hops = parent
      ? [...(parent.hops ?? [parent.sourceChatId]), sourceChatId]
      : hopsFor(
          this.data.messages,
          sourceChatId,
          grant.sourceTurnId ?? null,
          this.controller.state.get(sourceChatId)?.activeTurn?.id ?? null,
        );
    const loop = parent ? null : loopReason(hops, targetChatId);
    const message = {
      id: crypto.randomUUID(),
      sourceChatId,
      targetChatId,
      sourceTitle: titles.get(sourceChatId) ?? null,
      targetTitle: titles.get(targetChatId) ?? null,
      body,
      dedupeKey,
      fingerprint,
      sourceTurnId: grant.sourceTurnId ?? null,
      temporary: this.temporary(sourceChatId) || this.temporary(targetChatId),
      conversationId: parent?.conversationId ?? crypto.randomUUID(),
      replyTo,
      hops,
      // a relay loop is kept, not dropped: both chats show it, and the sender's user can still send it on
      delivery: loop ? 'blocked' : 'accepted',
      reply: requestReply && !parent ? 'awaiting' : 'notRequested',
      createdAt: clock.now(),
      targetTurnId: null,
      targetNativeId: null,
      targetItemId: null,
      errorCode: loop,
    };
    this.commit({ ...this.data, messages: [...this.data.messages, message] });
    return loop ? structuredClone(message) : this.enqueue(message);
  }

  /** Why the receiving chat holds this message for its user now (peerHold.cjs), or null. */
  holdFor(m) {
    if (m.allowedByUser || m.replyTo) return null;
    return holdReason(this.permission(m.sourceChatId), this.permission(m.targetChatId));
  }

  async enqueue(message) {
    const blocked = await this.gate(message.targetChatId);
    const current = this.get(message.sourceChatId, message.id);
    if (!['accepted', 'blocked', 'failed', 'held'].includes(current.delivery)) return current;
    if (blocked) return this.update(message.id, { delivery: 'blocked', errorCode: blocked });
    const held = this.holdFor(current);
    if (held)
      return current.delivery === 'held'
        ? current
        : this.update(message.id, { delivery: 'held', errorCode: held, heldUntil: clock.now() + HOLD_MS });
    this.update(message.id, { delivery: 'queued', errorCode: null });
    this.controller.send(
      message.targetChatId,
      {
        id: message.id,
        peer: { messageId: message.id, sourceChatId: message.sourceChatId, sourceTitle: message.sourceTitle, body: message.body },
        text: peerPrompt(message),
        attachments: [],
        opts: { human: false },
      },
      null,
    );
    // Like Claude Code's cross-session messages, a running chat takes it at its next tool round (a steer) rather than
    // after its turn, unless an older message from another chat or session still waits: they keep their order.
    // (only one the running turn queued: a send to an idle chat already started its own turn with it)
    const target = this.controller.state.get(message.targetChatId);
    const at = target.turn === 'running' ? target.queue.findIndex((q) => q.id === message.id) : -1;
    if (at >= 0 && !target.queue.slice(0, at).some((q) => q.peer || q.sideSession)) {
      // the turn may end, or the user remove the message, while the gate is read; whatever stops this early delivery,
      // the message is journaled and queued, so the sender gets its record and it goes when the turn ends
      return this.deliverNow(message.id).catch((error) => {
        if (!['cannot_send_now', 'queued_input_missing'].includes(error?.code)) noteIgnored('deliver a peer message mid-turn', error);
        return this.get(message.sourceChatId, message.id);
      });
    }
    return this.get(message.sourceChatId, message.id);
  }

  async beforeDispatch({ chatId, kind, item, ref }) {
    const m = this.data.messages.find((x) => x.id === item.id);
    if (!m) return;
    if (item.peer?.messageId !== m.id || item.peer?.sourceChatId !== m.sourceChatId) fail('invalid_peer_identity');
    if (m.targetChatId !== chatId || m.delivery !== 'queued') fail('invalid_peer_dispatch');
    const blocked = await this.gate(chatId);
    if (this.get(m.sourceChatId, m.id).delivery !== 'queued') fail('invalid_peer_dispatch');
    if (blocked) {
      this.update(m.id, { delivery: 'blocked', errorCode: blocked });
      fail(blocked);
    }
    // the receiver's mode can change while the message waits in its queue
    const held = this.holdFor(m);
    if (held) {
      this.update(m.id, { delivery: 'held', errorCode: held, heldUntil: clock.now() + HOLD_MS });
      fail(held);
    }
    if (kind === 'steer') {
      const unavailable = await this.steerAvailability(chatId);
      if (this.get(m.sourceChatId, m.id).delivery !== 'queued') fail('invalid_peer_dispatch');
      const state = this.controller.state.get(chatId);
      const reason =
        state.turn === 'awaitingUser'
          ? 'approval_pending'
          : state.pendingSwitch
            ? 'harness_switch_pending'
            : !this.controller.peerCapabilities(chatId).steer
              ? 'native_steer_unavailable'
              : unavailable;
      if (reason) {
        this.update(m.id, { errorCode: reason });
        if (!state.queue.some((q) => q.id === item.id)) this.controller.state.patch(chatId, { queue: [...state.queue, item] });
        throw Object.assign(new Error(reason), { queuedFallback: true });
      }
    }
    item.text = peerPrompt(m);
    item.opts = { human: false, ...(item.opts.prefix ? { prefix: item.opts.prefix } : {}) };
    this.update(m.id, { delivery: 'submitting', targetNativeId: ref.id, targetKind: ref.kind, targetItemId: m.id });
  }

  result({ item, result }) {
    if (result?.queuedFallback) return;
    const m = this.data.messages.find((x) => x.id === item.id);
    if (!m || !['queued', 'submitting'].includes(m.delivery)) return;
    if (m.delivery === 'queued' && result?.started) fail('missing_submission_record');
    const data = structuredClone(this.data);
    Object.assign(
      data.messages.find((x) => x.id === m.id),
      result?.started
        ? {
            delivery: 'delivered',
            targetTurnId: result.turnId ?? null,
            targetItemId: result.itemId ?? m.targetItemId ?? m.id,
            errorCode: null,
          }
        : { delivery: result?.blocked ? 'blocked' : 'failed', errorCode: result?.code ?? result?.error ?? 'native_rejected' },
    );
    // An explicit reply is received only after its own input is accepted by the source harness.
    if (result?.started && m.replyTo) {
      const parent = data.messages.find((x) => x.id === m.replyTo);
      if (!parent) fail('message_missing');
      Object.assign(parent, { reply: 'received', replyMessageId: m.id });
    }
    try {
      this.commit(data);
    } catch (error) {
      // Native may already have accepted. Keep the on-disk submitting record for recovery and
      // expose uncertainty now; never enqueue another native attempt on an ACK write failure.
      if (result?.started) {
        const original = this.data.messages.find((x) => x.id === m.id);
        Object.assign(original, { delivery: 'uncertain', errorCode: 'acknowledgement_not_persisted' });
        try {
          this.publish(structuredClone(this.data));
        } catch (publishError) {
          // presentation only; the write error is rethrown below
          noteIgnored('show an unacknowledged peer delivery', publishError);
        }
      }
      throw error;
    }
    this.flushCompletion(m.id);
  }

  flushCompletion(id) {
    const completion = this.completions.get(id);
    if (completion) {
      this.completions.delete(id);
      // answer() records a failed reply itself; asked directly, as an ack without a turn id is not found by turn
      this.answer(completion, id).catch((error) => noteIgnored('record the final reply to a peer message', error));
    }
  }

  async finished(completion) {
    const { chatId, inputToken, text, completed, turnId } = completion;
    if (!completed || typeof text !== 'string' || !text.trim()) return;
    const own = inputToken?.startsWith('pending-') ? inputToken.slice('pending-'.length) : null;
    // the turn a request started answers it, and so does a turn requests were steered into (at its next tool round); a
    // steer still awaiting its ack has no targetTurnId yet, so answer() holds the completion for result() to replay
    const joined = turnId
      ? this.data.messages
          .filter(
            (x) =>
              x.id !== own && x.targetChatId === chatId && (x.targetTurnId === turnId || (x.delivery === 'submitting' && !x.targetTurnId)),
          )
          .map((x) => x.id)
      : [];
    for (const id of own ? [own, ...joined] : joined) await this.answer(completion, id);
  }

  /** Send the turn's final answer as the reply to request `id`, once, when it still awaits one. */
  async answer(completion, id) {
    const { chatId, text } = completion;
    const m = this.data.messages.find((x) => x.id === id);
    if (!m || m.targetChatId !== chatId || m.replyTo || m.reply !== 'awaiting') return;
    if (m.delivery === 'submitting' || m.delivery === 'queued' || m.delivery === 'uncertain') {
      this.completions.set(id, completion);
      return;
    }
    if (m.delivery !== 'delivered' || (m.targetTurnId && completion.turnId !== m.targetTurnId)) return;
    if (this.data.messages.some((x) => x.replyTo === id && x.delivery !== 'cancelled')) return;
    try {
      await this.reply(chatId, { messageId: id, requestId: `final-${id}`, body: text });
    } catch (error) {
      // the code is what the windows show; why it failed goes to diagnostics
      noteIgnored('send a final-answer reply', error);
      this.update(id, { errorCode: 'reply_failed' });
    }
  }

  async reply(sourceChatId, { messageId, requestId, body }) {
    const parent = this.get(sourceChatId, messageId);
    return this.send(sourceChatId, { targetChatId: parent.sourceChatId, requestId, body, replyTo: messageId, requestReply: false });
  }

  cancel(sourceChatId, id) {
    const m = this.get(sourceChatId, id);
    if (m.sourceChatId !== sourceChatId || !['accepted', 'queued', 'blocked', 'failed', 'held'].includes(m.delivery)) fail('cannot_cancel');
    const cancelled = this.update(id, { delivery: 'cancelled', errorCode: null });
    this.controller.removeQueued(m.targetChatId, m.id);
    return cancelled;
  }

  /** Explicit sender action only. Lack of steer support preserves the queued request. */
  async sendNow(sourceChatId, id) {
    const m = this.get(sourceChatId, id);
    if (m.sourceChatId !== sourceChatId || m.delivery !== 'queued') fail('cannot_send_now');
    return this.deliverNow(id);
  }

  /**
   * Take a queued message into its target now: a running turn steers it in, at its next tool round; a chat waiting on
   * an approval, mid-switch or on a harness that can't steer keeps it queued with the reason (errorCode).
   * @param {string} id
   */
  async deliverNow(id) {
    const sourceChatId = this.data.messages.find((x) => x.id === id).sourceChatId;
    const m = this.get(sourceChatId, id);
    const blocked = await this.gate(m.targetChatId);
    if (this.get(sourceChatId, id).delivery !== 'queued') fail('cannot_send_now');
    if (blocked) return this.update(id, { errorCode: blocked });
    const before = this.controller.state.get(m.targetChatId);
    const unavailable = before.turn === 'running' ? await this.steerAvailability(m.targetChatId) : null;
    if (this.get(sourceChatId, id).delivery !== 'queued') fail('cannot_send_now');
    const state = this.controller.state.get(m.targetChatId);
    const reason =
      state.turn === 'awaitingUser'
        ? 'approval_pending'
        : state.pendingSwitch
          ? 'harness_switch_pending'
          : state.turn === 'running' && !this.controller.peerCapabilities(m.targetChatId).steer
            ? 'native_steer_unavailable'
            : unavailable;
    if (reason) return this.update(id, { errorCode: reason });
    if (!this.controller.sendNow(m.targetChatId, id, null)) fail('queued_input_missing');
    return this.get(sourceChatId, id);
  }

  async resume(sourceChatId, id) {
    const m = this.get(sourceChatId, id);
    if (m.sourceChatId !== sourceChatId || !['blocked', 'failed'].includes(m.delivery)) fail('cannot_resume');
    if (!this.exists(m.targetChatId)) fail('chat_unavailable');
    if (!m.replyTo && !(await this.authorize(sourceChatId, m.targetChatId, JSON.parse(m.dedupeKey)[1]))) fail('send_not_authorized');
    if (!['blocked', 'failed'].includes(this.get(sourceChatId, id).delivery)) fail('cannot_resume');
    this.controller.removeQueued(m.targetChatId, m.id);
    // the user's own Retry starts a new chain: a loop it was cut from no longer counts
    return this.enqueue(this.update(id, { hops: [sourceChatId] }));
  }

  async reconcile(sourceChatId, id, readReceipt) {
    const m = this.get(sourceChatId, id);
    if (m.delivery !== 'uncertain') return m;
    let receipt;
    try {
      receipt = await readReceipt(m);
    } catch {
      const current = this.get(sourceChatId, id);
      if (current.delivery !== 'uncertain') return current;
      return this.update(id, { errorCode: 'receipt_verification_unavailable' });
    }
    const current = this.get(sourceChatId, id);
    if (current.delivery !== 'uncertain') return current;
    if (!receipt?.turnId || receipt.clientId !== m.id || receipt.nativeId !== m.targetNativeId || receipt.kind !== m.targetKind)
      return this.update(id, { errorCode: 'delivery_still_unknown' });
    // Reconciliation observes the original native input; it never starts another native turn.
    const data = structuredClone(this.data);
    Object.assign(
      data.messages.find((x) => x.id === id),
      { delivery: 'delivered', targetTurnId: receipt.turnId, targetItemId: receipt.itemId ?? m.id, errorCode: null },
    );
    if (m.replyTo) {
      const parent = data.messages.find((x) => x.id === m.replyTo);
      if (parent) Object.assign(parent, { reply: 'received', replyMessageId: m.id });
    }
    this.commit(data);
    this.flushCompletion(id);
    return this.get(sourceChatId, id);
  }

  /**
   * @param {string} sourceChatId
   * @param {string} id
   * @param {{ timeoutMs?: number, signal?: AbortSignal }} [opts]
   */
  wait(sourceChatId, id, { timeoutMs = 30000, signal } = {}) {
    const initial = this.get(sourceChatId, id);
    if (signal?.aborted) return Promise.reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
    const timeout = Math.max(0, Math.min(30000, Number.isFinite(timeoutMs) ? timeoutMs : 30000));
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clock.clearTimeout(timer);
        this.listeners.delete(changed);
        signal?.removeEventListener('abort', aborted);
      };
      const changed = () => {
        const current = this.get(sourceChatId, id);
        if (JSON.stringify(current) === JSON.stringify(initial)) return;
        cleanup();
        resolve({ message: current, timedOut: false });
      };
      const aborted = () => {
        cleanup();
        reject(Object.assign(new Error('aborted'), { code: 'aborted' }));
      };
      this.listeners.add(changed);
      signal?.addEventListener('abort', aborted, { once: true });
      timer = clock.setTimeout(() => {
        cleanup();
        resolve({ message: this.get(sourceChatId, id), timedOut: true });
      }, timeout);
    });
  }
}

module.exports = { PeerMessageService };

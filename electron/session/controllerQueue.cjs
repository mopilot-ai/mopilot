// The main controller's editable input queue, including serialized release of steers held during native compaction.
const { ControllerEvents, busy } = require('./controllerEvents.cjs');
const { voiceWriter } = require('./voice.cjs');
const { folderMutation } = require('./folderMutation.cjs');
const { traitsOf } = require('../harness/family.cjs');
const { ignoring } = require('../ignored.cjs');
const { guardSend, carryInputGuard } = require('./contract/inputGuard.cjs');
const { deliverFamily, whyWaits } = require('./familyDelivery.cjs');
const { sameTurn, activeCompaction, holdCompaction, restoreCompaction, guardCompaction } = require('./compactionQueue.cjs');

/** @typedef {InstanceType<typeof import('./controller.cjs').ChatController>} ChatController */

class ControllerQueue extends ControllerEvents {
  /** @this {ChatController} */
  removeQueued(chatId, qid, releaseOwnership = true) {
    const { queue } = this.state.get(chatId);
    const item = queue.find((x) => x.id === qid);
    if (!item) return null;
    if (releaseOwnership) this.audioPending?.remove(qid);
    this.state.patch(chatId, { queue: queue.filter((x) => x !== item) });
    this.rts.get(chatId)?.compactionInputs?.delete(qid);
    const { waitingFor: _waiting, ...ready } = item;
    return carryInputGuard(item, ready);
  }

  /** "Send now" on a queued message: into the running turn, or as the next turn. @this {ChatController} */
  sendNow(chatId, qid, origin, waitForDelivery = false) {
    if (voiceWriter(this, chatId)) return waitForDelivery ? { status: 'queued' } : true;
    const state = this.state.get(chatId);
    const queued = state.queue.find((q) => q.id === qid);
    if (!queued) return waitForDelivery ? { status: 'missing' } : false;
    if (queued.opts.compact && busy(state))
      return waitForDelivery ? { status: 'queued', error: 'Compaction will run after the current turn.' } : true;
    // the session store admits it (another session's message waits while it can't be steered in) and routes it
    const admit = this.state.sendNowRoute(chatId, 'admit', { peer: !!queued.peer, peerSteers: () => this.peerCapabilities(chatId).steer });
    if (admit === 'refuse')
      return waitForDelivery ? { status: 'queued', error: 'This message cannot be delivered during the current turn.' } : false;
    if (folderMutation(this, chatId)) return waitForDelivery ? { status: 'queued' } : true;
    if (queued && holdCompaction(this, chatId, queued)) return waitForDelivery ? { status: 'queued', waitingFor: 'compaction' } : true;
    const q = this.removeQueued(chatId, qid, false);
    if (!q) return waitForDelivery ? { status: 'missing' } : false;
    const route = this.state.sendNowRoute(chatId, 'route', { steers: () => traitsOf(this.ref(chatId).kind).steers });
    if (route === 'queueFirst') {
      // nothing to steer into: it goes first in the queue
      this.audioPending?.admit(chatId, q);
      this.state.patch(chatId, { queue: [q, ...this.state.get(chatId).queue] });
      return waitForDelivery ? { status: 'queued' } : true;
    }
    const delivery = route === 'steer' ? this.steer(chatId, q, origin ?? q.origin) : this.startOrKeep(chatId, q);
    if (waitForDelivery)
      return delivery.then((result) => {
        if (result?.started) return { status: 'sent' };
        if (result?.held) return { status: 'held' };
        if (result?.compactionQueued) return { status: 'queued', waitingFor: result.waitingFor ?? 'compaction' };
        // kept for a Switch host that is moving the chat: it goes when the move ends
        if (result?.queuedFallback) return { status: 'queued', waitingFor: 'host' };
        const queued = this.state.get(chatId).queue.some((item) => item.id === q.id);
        return { status: queued ? 'queued' : 'failed', error: result?.error || 'The harness did not accept the message.' };
      });
    return true;
  }

  /** Another session's message to this chat: a steer where its harness takes one, else queued with the reason (familyDelivery.cjs). @this {ChatController} */
  deliverFamily(chatId, item) {
    return deliverFamily.call(this, chatId, item);
  }

  /** Why a message from another session would wait in this running chat instead of steering in, or null (familyDelivery.cjs). @this {ChatController} */
  familyWait(chatId) {
    return whyWaits(this, chatId);
  }

  /**
   * A native steer and its failure settlement retain one input owner.
   * @this {ChatController}
   * @param {import('./compactionQueue.cjs').CompactionOwner | null} [compaction]
   */
  steer(chatId, q, origin, compaction = null) {
    if (this.obsoleteGoalCommand(chatId, q)) return Promise.resolve({ started: false, discarded: true });
    if (holdCompaction(this, chatId, q)) return Promise.resolve({ started: false, compactionQueued: true });
    const r = this.rt(chatId);
    r.steering++;
    const release = this.stopGuard(chatId, q);
    const releaseOwner =
      compaction &&
      guardSend(q, () => {
        if (!sameTurn(this, chatId, compaction)) throw new Error('The compaction turn changed before this message was sent.');
      });
    const compactionGuard = guardCompaction(this, chatId, q);
    return this.dispatch(chatId, 'steer', q, origin).then(async (res) => {
      release();
      compactionGuard.release();
      const blocked = compactionGuard.owner;
      releaseOwner?.();
      r.steering--;
      const after = r.steering ? null : r.afterSteer;
      if (!r.steering) r.afterSteer = null;
      if (blocked && !res?.started && !q.peer) {
        const waitingFor = restoreCompaction(this, chatId, q, blocked);
        res = { ...res, compactionQueued: true, waitingFor };
      }
      if (
        compaction &&
        (compaction.retry || (compaction.phase !== 'retired' && !sameTurn(this, chatId, compaction))) &&
        !res?.started &&
        !res?.compactionQueued &&
        !q.peer
      ) {
        if (!this.state.get(chatId).queue.some((item) => item.id === q.id))
          this.queueFirst(chatId, { ...q, waitingFor: 'compactionRetry' });
        res = { ...res, compactionQueued: true, waitingFor: 'compactionRetry' };
      }
      if (!res?.started && !res?.discarded && !res?.queuedFallback && !res?.compactionQueued && !q.peer) {
        const s = this.state.get(chatId);
        // still running, crashed, or stopped by the user: it waits first in line, after the steers put there before it
        if (busy(s) || s.turn === 'crashed' || after === 'hold') this.queueFirst(chatId, q);
        else {
          res = await this.startOrKeep(chatId, q);
        }
      }
      if (after === 'drain' && res?.started) this.drain(chatId)?.catch(ignoring('send the next queued message'));
      return res;
    });
  }

  /**
   * The next queued message goes once nothing holds the chat; the session store decides whether it can (its turn, the
   * message's wait) and takes it off the queue (electron/session/state.cjs takeNext). @this {ChatController}
   */
  drain(chatId) {
    // a chat on another machine keeps its queue for the machine: what shows there is what this app sent and the Host has (or will have), never a message to start on this Mac (#4719)
    if (this.remote.owns?.(chatId)) return;
    // a chat a Switch host is moving keeps its queue for the move (electron/host/remoteSendRebase.cjs)
    const held = () =>
      !!(this.remote.moving?.(chatId) || folderMutation(this, chatId) || voiceWriter(this, chatId) || activeCompaction(this, chatId));
    const next = this.state.takeNext(chatId, held);
    if (!next) return;
    // Peer deliveries own their failure/recovery record; ordinary input must stay queued.
    return this.startOrKeep(chatId, next);
  }

  /**
   * A message that didn't start goes back first in line: the turn's own message ahead of everything, a steer behind
   * the ones put back before it. A stop that reaches a start and the steers waiting behind it puts them back in the
   * order they were sent, whichever is put back first.
   * @this {ChatController}
   */
  queueFirst(chatId, q, ahead = false) {
    this.audioPending?.admit(chatId, q);
    const { queue } = this.state.get(chatId);
    // the session store keeps who went back first in line, and says where this one goes
    const i = this.state.putBack(chatId, q.id, ahead);
    this.state.patch(chatId, {
      queue: [...queue.slice(0, i), voiceWriter(this, chatId) ? { ...q, waitingFor: 'voiceConversation' } : q, ...queue.slice(i)],
    });
  }
}

module.exports = { ControllerQueue };

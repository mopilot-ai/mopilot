// Card history runs outside the live-event queue; each accepted latest list owns delivery to all current subscriptions.
const { RemoteError } = require('./serviceErrors.cjs');

/** A follow has an identity even when a phone leaves and immediately follows the same chat again. */
class FollowedChats extends Set {
  /** @param {(chatId: string) => void} onLeave */
  constructor(onLeave) {
    super();
    this.owners = new Map();
    this.requests = new Map();
    this.onLeave = onLeave;
  }
  /** @param {string} chatId */
  add(chatId) {
    if (!this.has(chatId)) this.owners.set(chatId, {});
    return super.add(chatId);
  }
  /** @param {string} chatId */
  delete(chatId) {
    this.owners.delete(chatId);
    this.requests.delete(chatId);
    const removed = super.delete(chatId);
    this.onLeave(chatId);
    return removed;
  }
  clear() {
    const chats = [...this];
    this.owners.clear();
    this.requests.clear();
    super.clear();
    for (const chatId of chats) this.onLeave(chatId);
  }
}

/** @typedef {{ transport: unknown, epoch: object, pending: Promise<any> | null, placement: number, signature: string | null, broadcast: number | null, announce: boolean }} CardRead */
class CardUpdates {
  /** @param {any} svc the RemoteService that owns transport, subscriptions, card ledger and ordered sends */
  constructor(svc) {
    this.svc = svc;
    /** @type {Map<string, CardRead>} card-state generation, retained after completion to prevent ABA */
    this.owners = new Map();
    this.epoch = {};
    /** The waits before each retry of a failed card read (ms); tests shorten them. */
    this.retryMs = [500, 2000];
  }

  /** @param {string} chatId @param {boolean} [announce] */
  begin(chatId, announce = false) {
    const owner = {
      transport: this.svc.transport,
      epoch: this.epoch,
      pending: null,
      placement: 0,
      signature: null,
      broadcast: null,
      announce,
    };
    this.owners.set(chatId, owner);
    return owner;
  }

  /** Equivalent snapshots share a generation; opening another phone does not invalidate the first. @param {string} chatId */
  capture(chatId) {
    return this.owners.get(chatId) ?? this.begin(chatId);
  }

  /** Coalesce only concurrent reads of the same card generation, without caching a completed answer. @param {string} chatId @param {CardRead} owner */
  load(chatId, owner) {
    if (owner.pending) return owner.pending;
    const pending = Promise.resolve()
      .then(async () => {
        if (!this.current(chatId, owner, owner.transport)) throw new RemoteError('stale', 'The card read is no longer current.');
        const cards = await this.svc.ops.cardsOf(chatId);
        if (!this.current(chatId, owner, owner.transport)) throw new RemoteError('stale', 'The card read is no longer current.');
        return cards;
      })
      .finally(() => {
        owner.pending = null;
      });
    owner.pending = pending;
    return pending;
  }

  /** @param {string} chatId @param {CardRead} owner @param {unknown} transport */
  current(chatId, owner, transport) {
    return this.owners.get(chatId) === owner && this.svc.transport === transport && owner.epoch === this.epoch;
  }

  /** Retire a background card read when its owner changes. @param {string} chatId */
  retire(chatId) {
    this.owners.delete(chatId);
  }

  clear() {
    this.owners.clear();
    this.epoch = {};
  }

  /** Retry a changed card generation at most twice; a retired connection or subscription never follows its replacement. */
  async cardsFor(/** @type {string} */ chatId, /** @type {number} */ rev, /** @type {() => boolean} */ may) {
    const svc = this.svc;
    const transport = svc.transport;
    const epoch = this.epoch;
    const check = () => {
      if (svc.transport !== transport || this.epoch !== epoch || !may())
        throw new RemoteError('stale', 'This chat is no longer open. Try opening it again.');
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      check();
      const read = this.capture(chatId);
      try {
        const cards = await this.load(chatId, read);
        check();
        if (!this.current(chatId, read, read.transport)) continue;
        return svc.placeCards(chatId, svc.ops.state.get(chatId)?.rev ?? rev, cards, read);
      } catch (error) {
        check();
        if (this.current(chatId, read, read.transport)) throw error;
      }
    }
    throw new RemoteError('stale', 'This chat is changing. Try opening it again.');
  }

  /** Preserve the public Set-based client contract used by in-process callers as well as transport clients. @param {any} client @param {string} chatId */
  follow(client, chatId) {
    if (!(client.follows instanceof FollowedChats)) {
      const followed = new FollowedChats((id) => {
        if (!this.svc.followers(id).length) this.retire(id);
      });
      for (const id of client.follows) followed.add(id);
      client.follows = followed;
    }
    client.follows.add(chatId);
    const request = {};
    client.follows.requests.set(chatId, request);
    return { owner: client.follows.owners.get(chatId), request };
  }

  /** Every accepted replacement owns a broadcast; superseding an older callback cannot strand another follower. */
  placed(/** @type {string} */ chatId, /** @type {number} */ rev, /** @type {any[]} */ cards, /** @type {CardRead} */ read) {
    const svc = this.svc;
    const signature = JSON.stringify(cards);
    const different = signature !== read.signature;
    read.announce ||= read.signature !== null && different;
    read.signature = signature;
    if (different) read.placement++;
    if (!read.announce || read.broadcast === read.placement) return;
    const transport = read.transport;
    const recipients = svc.followers(chatId).map((/** @type {any} */ { client }) => ({ client, owner: client.follows.owners.get(chatId) }));
    if (!transport || !recipients.length) return;
    const placement = read.placement;
    read.broadcast = placement;
    const current = () => this.current(chatId, read, transport);
    const follows = (/** @type {any} */ { client, owner }) =>
      svc.paired(client) && client.follows.owners.get(chatId) === owner && client.follows.has(chatId);
    // rev was captured before enqueue: its state patch already precedes this callback.
    void svc.enqueue(chatId, async () => {
      if (!current() || read.placement !== placement) return;
      for (const recipient of recipients) {
        if (!current() || read.placement !== placement) return;
        if (follows(recipient)) await svc.emit(recipient.client.pairId, { ev: 'cards.changed', chatId, rev, cards });
      }
      if (current() && read.placement === placement) {
        read.broadcast = null;
        read.announce = false;
      }
    });
  }

  /**
   * Start a latest-wins card read without ever awaiting it from the chat's live-event queue. A read that fails is tried again after
   * each wait in `retryMs`, then noted: a phone is not left without its card until the next change. @param {string} chatId @param {number} [attempt]
   */
  changed(chatId, attempt = 0) {
    const svc = this.svc;
    const transport = svc.transport;
    if (!transport || !svc.followers(chatId).length) return;
    const read = this.begin(chatId, true);
    void this.load(chatId, read)
      .then((cards) => {
        if (!this.current(chatId, read, transport)) return;
        const rev = svc.ops.state.get(chatId)?.rev ?? 0;
        svc.placeCards(chatId, rev, cards, read);
      })
      .catch((error) => {
        if (!this.current(chatId, read, transport)) return;
        const wait = this.retryMs[attempt];
        if (wait === undefined) return svc.note('read cards for a paired phone', error);
        const timer = setTimeout(() => this.changed(chatId, attempt + 1), wait);
        timer.unref?.();
      });
  }
}

module.exports = { CardUpdates, FollowedChats };

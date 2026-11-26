// The chats that run on a remote Host, followed from this app: what the Host's stream says (its events, one record at a time, and the text of a message as it is written) is written to the chat's transcript here and handed to the app's ACP event bus, so the chat draws, lists, searches and reopens exactly as one that runs on this Mac.
const { noteIgnored } = require('../ignored.cjs');
const { createStartPairs } = require('./turnStartPairs.cjs');
const { cardId, createChatState } = require('./remoteChatState.cjs');
const { createRemoteJournalFaults } = require('./remoteJournalFaults.cjs');
const { createLiveText, degradedEvent } = require('./remoteText.cjs');
const { scopeHostPictures, withSentPictures, durableEvent } = require('../../shared/host/images.mjs');
const { FAMILIES, RECORDED, eventOf, otherFamily, closedCards, recordOf, foldSummary } = require('../../shared/host/fold.mjs');
const { shownInterruption, toldEnd } = require('./remoteInterrupted.cjs');
const { closedPatch, cardRecord } = require('./cardClosed.cjs');

/** What a Host call fails with when its machine is away or its connection was let go: not a failure to report. */
const QUIET = new Set(['host_unreachable', 'disposed']);

const isObject = (/** @type {unknown} */ v) => typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * @param {object} o
 * @param {{ append: (id: string, ...records: object[]) => void, readAsync: (id: string) => Promise<any[]>, readKindsAsync?: (id: string, kinds: string[]) => Promise<any[]>, flush: (id: string) => Promise<unknown>, size: (id: string) => Promise<number>, file: (id: string) => string }} o.items the app's transcript store (the ACP host's)
 * @param {(hostId: string) => any} o.hostFor the connection to a machine (electron/host/machines.cjs); null when there is none to make
 * @param {(chatId: string) => { hostId: string, folder: string | null }} o.ownerOf the ownership side map's record for the chat
 * @param {(event: object) => void} o.emit the ACP host's event bus: what a local ACP chat's events go through
 * @param {() => { openRemote: (o: object) => void, closeRemote: (id: string) => void } | null | undefined} [o.questions] the app's form cards (electron/harness/acp/questions.cjs), where a question the agent on a machine asks is shown
 * @param {() => { has: (chatId: string) => boolean, get: (chatId: string) => unknown, patch: (chatId: string, partial: object) => unknown } | null | undefined} [o.state] main's SessionStore, where a chat's goal, background tasks and waiting cards are shown from
 * @param {{ take: (chatId: string, key?: string) => string | undefined, seen: (chatId: string, text: string | undefined, key?: string) => void, attached?: (chatId: string, key?: string) => any[] | undefined, settleSteered: (chatId: string) => void }} [o.sent] what this Mac sent to its chats and the transcript does not have yet (remoteSend.cjs `sent`)
 * @param {() => number} [o.now]
 * @param {(error: Error) => void} [o.report]
 * @param {() => string | null} [o.selfKey] this app's client key: an answer it gave is not "on another device"
 * @param {(chatId: string, value: unknown) => void} [o.attention] told a chat's `attention` from its state lane (attentionLane.cjs)
 * @param {(chatId: string, harness: string) => void} [o.agent] told the agent a chat runs on from its state lane, once a switch settled (wiring.cjs `laneOf`)
 * @param {(chatId: string, note: object) => void} [o.note] told a note the chat keeps beside its turns (the divider of a switch the Host journaled), by an id that tells the same note twice (wiring.cjs `laneOf`)
 */
function createRemoteChats({
  items,
  hostFor,
  ownerOf,
  emit,
  state = () => null,
  questions = () => null,
  sent = { take: () => undefined, seen: () => undefined, attached: () => undefined, settleSteered: () => undefined },
  now = () => Date.now(),
  report = (e) => noteIgnored('follow a chat on another machine', e),
  attention,
  agent,
  note = () => undefined,
  selfKey = () => null,
}) {
  const chatState = createChatState({ items, emit, state, questions, now, attention, agent, note });
  const journalStatus = createRemoteJournalFaults({ emit, state, report });
  const { textEvent, showText, applyInflight } = createLiveText(emit);

  /**
   * One followed chat. `cursor` is the last Host revision applied and the numbering it was counted in; `shown` is the text of each unfinished message
   * (by its stream key) already drawn; `tail` serializes everything that changes the chat, so a slow write never lets a later frame overtake an earlier one.
   * `summary` is the finished items so far (see foldSummary) and `complete` whether they reach back to the chat's first item; `refused` the families already reported as not shown; `ended` the turn ids whose end was applied (a start told for one opens nothing).
   * `synced` is whether the chat is subscribed on the connection that is up now, and `syncing` the subscribe on its way, if any (subscribed()).
   * @typedef {{ chatId: string, hostId: string, host: any, cursor: { gen: string, rev: number } | null, shown: Map<string, string>, tail: Promise<unknown>, gone: boolean, loaded: boolean, summary: any[], complete: boolean, refused: Set<string>, ended: Set<string>, pairs: ReturnType<typeof createStartPairs>, synced: boolean, syncing: Promise<unknown> | null, replay: number | null, connection: object | null }} Follow
   * @type {Map<string, Follow>}
   */
  const follows = new Map();
  /** The listeners on each machine's connection, one set per connection however many chats it carries. @type {Map<string, { host: any, off: (() => void)[] }>} */
  const attached = new Map();
  /** The permission cards waiting for the user, by the id they have here (chatState.cardId), with the chat each belongs to and the id its Host gave it. @type {Map<string, { chatId: string, requestId: string }>} */
  const waiting = new Map();
  /** The answers on their way to a Host, by card id. @type {Map<string, Promise<boolean>>} */
  const answering = new Map();
  let disposed = false;

  /** @param {Follow} f @param {() => Promise<unknown> | unknown} work */
  function run(f, work) {
    f.tail = f.tail
      .then(() => (f.gone || disposed ? undefined : work()))
      .catch((error) => {
        journalStatus.failed(f, error, () => sync(f));
        report(error);
      });
    return f.tail;
  }

  /**
   * Where the transcript says this chat stands in the Host's stream (the last record that names a revision), and the turn it shows as begun but not ended, if any:
   * a turn the machine kept running while the app was closed is still running when the app is back.
   * @param {string} chatId
   */
  async function transcriptState(chatId) {
    const records = await items.readAsync(chatId);
    const last = records.findLast((r) => Number.isSafeInteger(r?.hostRev));
    const ended = new Set(records.filter((r) => r?.t === 'end').map((r) => r.turnId));
    // only the last turn can still be running: one a later turn followed lost its end
    const newest = records.findLast((r) => r?.t === 'user' && typeof r.turnId === 'string');
    const open = newest && !ended.has(newest.turnId) ? newest : null;
    /** @type {any[]} */
    const summary = [];
    for (const r of records) foldSummary(summary, r);
    return {
      cursor: last ? { gen: String(last.hostGen ?? ''), rev: /** @type {number} */ (last.hostRev) } : null,
      open: open
        ? {
            turnId: /** @type {string} */ (open.turnId),
            user: open.user,
            rev: Number.isSafeInteger(open.hostRev) ? /** @type {number} */ (open.hostRev) : null,
          }
        : null,
      summary,
    };
  }

  /** The chat's first record, which is what lists it. @param {Follow} f */
  async function ensureSession(f) {
    if ((await items.readAsync(f.chatId)).some((r) => r?.t === 'session')) return;
    const { folder } = ownerOf(f.chatId);
    const harness = /^acp:([^:]+):/.exec(f.chatId)?.[1] ?? '';
    items.append(f.chatId, { t: 'session', harness, sessionId: `host:${f.hostId}`, cwd: folder, at: now() });
  }

  /** A card of the turn that was running when the app closed, replayed from its start: shown again unless it was closed meanwhile (`quiet`); everything else of it is on record or shown already. @param {Follow} f @param {number} rev @param {any} item @param {Set<number>} quiet */
  function replayCard(f, rev, item, quiet) {
    const ev = eventOf(item);
    if ((ev?.kind === 'permission' || ev?.kind === 'question') && !quiet.has(rev)) applyEvent(f, rev, ev, undefined, quiet);
  }

  /**
   * One finished item of the Host's stream at `rev`: written to the transcript when it leaves a record, shown, and counted.
   * @param {Follow} f @param {number} rev @param {any} item @param {string | undefined} promotes the unfinished message it completes @param {Set<number>} [quiet] revisions to count and record but not show @param {string | null} [openTurn] the active turn of a replay batch
   */
  function applyDurable(f, rev, item, promotes, quiet, openTurn) {
    const cursor = /** @type {{ gen: string, rev: number }} */ (f.cursor);
    if (rev <= cursor.rev) return void (f.replay !== null && replayCard(f, rev, item, /** @type {Set<number>} */ (quiet)));
    const other = otherFamily(item);
    if (other) return void ((cursor.rev = rev), refuse(f, other));
    // a switch the Host journaled is the chat's divider here: kept beside the turn that settled it, whichever client was there to see it
    if (item?.t === 'switch') return void ((cursor.rev = rev), chatState.switched(f, item));
    // an event of a family this app shows that it cannot read: one short row in its turn, or a report when it names none; never nothing
    const unreadable = item?.t === 'event' && FAMILIES.has(item.family) && !eventOf(item);
    const degraded = unreadable ? degradedEvent(item) : null;
    const once = degraded && !f.refused.has(`unreadable:${degraded.turnId}`);
    if (once) f.refused.add(`unreadable:${degraded.turnId}`);
    if (unreadable && !degraded) refuse(f, 'unreadable');
    // a turn start that names no user message waits for the Host's item that says what was asked (turnStartPairs.cjs)
    const events = unreadable
      ? once
        ? [degraded]
        : []
      : f.pairs.take(item.user ? { ...item, user: scopeHostPictures(item.user, f.hostId) } : item, eventOf(item));
    for (const ev of events) {
      applyEvent(f, rev, ev, promotes, quiet, openTurn);
      if (ev.kind === 'turnStart') {
        const text = ev.user?.content?.find?.((/** @type {any} */ c) => c?.type === 'text')?.text;
        if (typeof text === 'string') sent.seen(f.chatId, text, ev.user?.messageKey ?? ev.user?.clientId);
      }
      if (ev.kind === 'steered') sent.seen(f.chatId, '', ev.user?.messageKey ?? ev.user?.clientId);
      if (ev.kind === 'turnEnd') sent.settleSteered(f.chatId);
    }
    // only a record that was applied is passed: a write that failed above leaves the cursor behind it, so the next read starts there (#5404)
    cursor.rev = rev;
    // A recorded input settles its key even when the turn start was already drawn or the input has no text.
    if (item?.t === 'user' && typeof item.messageKey === 'string') sent.seen(f.chatId, undefined, item.messageKey);
  }

  /** One event of the Host's stream at `rev`. @param {Follow} f @param {number} rev @param {any} ev @param {string | undefined} promotes @param {Set<number>} [quiet] @param {string | null} [openTurn] */
  function applyEvent(f, rev, ev, promotes, quiet, openTurn) {
    // the Host's own paths mean nothing here, and a snapshot of one would be taken of whatever lives at that path on this Mac
    // a turn's start told after its end (an older Host's journal holds such a turn, and the stream could say it again) opens nothing: the chat would stay running with no end to come
    if (ev.kind === 'turnStart' && f.ended.has(ev.turnId)) return;
    if (ev.kind === 'turnEnd') {
      f.ended.add(ev.turnId);
      if (f.ended.size > 200) f.ended.delete(/** @type {string} */ (f.ended.values().next().value));
    }
    const { cwd: _cwd, ...told } = ev;
    // a turn the machine's restart cut off is shown as failed with what it interrupted, so Retry is offered (remoteInterrupted.cjs)
    // a turn's error is text from here on, with the Host's code beside it: the records and the thread read a string (shared/acpItems/records.d.mts)
    const raw = toldEnd(shownInterruption(told));
    let event = raw.user ? { ...raw, user: scopeHostPictures(raw.user, f.hostId) } : raw;
    const pics =
      event.kind === 'turnStart' && event.user ? sent.attached?.(f.chatId, event.user.messageKey ?? event.user.clientId) : undefined;
    if (pics) event = { ...event, user: withSentPictures(event.user, pics, f.hostId) }; // drawn from what this Mac attached while live; saved with the machine's refs only
    const record = RECORDED.has(event.kind) ? recordOf(durableEvent(event), now()) : null;
    if (record) {
      items.append(f.chatId, { ...record, hostRev: rev, hostGen: /** @type {{ gen: string }} */ (f.cursor).gen });
      foldSummary(f.summary, record);
    }
    journalStatus.observe(f, event);
    if (quiet?.has(rev)) return;
    if (promotes !== undefined && event.kind === 'update' && typeof event.update?.content?.text === 'string') {
      // the whole message: only what the deltas did not already show is new to the window; deltas it does not go on from (one was lost on a reconnect) are replaced by it
      const head = { turnId: event.turnId, ...event.update };
      const whole = event.update.content.text;
      const drawn = f.shown.get(promotes) ?? '';
      if (whole.startsWith(drawn)) showText(f, promotes, head, whole);
      else emit(textEvent(f, head, whole, drawn));
      f.shown.delete(promotes);
      return;
    }
    // the call's whole output replaces the live view of it
    if (promotes !== undefined) f.shown.delete(promotes);
    // Initialize live state only for a current turn or card. A replay of completed history should not start a live session.
    const liveStart = event.kind === 'turnStart' && (quiet === undefined || event.turnId === openTurn);
    if (liveStart || event.kind === 'permission' || event.kind === 'question') state()?.get(f.chatId);
    // the cards waiting for the user, by id: an answer given in this app finds its chat here (the unanswered period and the push are the controller's and remoteSend's, from the session state)
    if (event.kind === 'question') return void chatState.question(f, event);
    // a Host's card id is made the chat's own before anything else sees it (chatState.cardId): an id another Host or chat uses, or one of this Mac's, is a different card here
    if (event.kind === 'permission' || event.kind === 'permissionCancelled') {
      const id = cardId(f.chatId, event.requestId);
      if (event.kind === 'permission') waiting.set(id, { chatId: f.chatId, requestId: event.requestId });
      else waiting.delete(id), chatState.closeQuestion(id);
      // a Host that says why the card closed leaves a line in the thread (cardClosed.cjs)
      const patch = closedPatch(event, { selfKey: selfKey(), machineName: f.hostId });
      // the closed card's outcome is a record of the chat, so it shows in its turn whenever the chat is opened, not only while it was open when the Host closed the card
      const closed =
        event.kind === 'permissionCancelled' ? cardRecord(event, id, /** @type {{ line?: string }} */ (patch).line, now()) : null;
      if (closed) items.append(f.chatId, { ...closed, hostRev: rev, hostGen: /** @type {{ gen: string }} */ (f.cursor).gen });
      event = { ...event, requestId: id, ...patch };
    }
    // a turn is a person's only as a Host that carries who wrote a message says so; an older Host's turns are nobody's (its stream may say what it likes)
    if (event.kind === 'turnStart' && event.human !== undefined && f.host.speaks?.('origin') !== true) {
      const { human: _human, ...plain } = event;
      return void emit({ ...plain, key: f.chatId });
    }
    emit({ ...event, key: f.chatId });
  }

  /** A family this app has no sink for: said once per chat, not shown. @param {Follow} f @param {string} family */
  function refuse(f, family) {
    if (f.refused.has(family)) return;
    f.refused.add(family);
    report(new Error(`A chat on ${f.hostId} sends ${family} events, which this app cannot show yet.`));
  }

  /** @param {Follow} f */
  function suggestionGuard(f) {
    const connection = f.host.state() === 'online' && f.connection;
    return () => !!connection && follows.get(f.chatId) === f && f.connection === connection;
  }
  /** @param {Follow} f */
  function retireSuggestion(f) {
    f.connection = null;
    chatState.withdrawSuggestion(f.chatId);
  }

  /** The Host's answer to a subscribe: what to apply, in one numbering. @param {Follow} f @param {any} res @param {() => boolean} [suggestionCurrent] */
  async function apply(f, res, suggestionCurrent) {
    const sameNumbering = f.cursor !== null && f.cursor.gen === res.generation && f.cursor.rev <= res.snapshot.rev;
    if (!sameNumbering) {
      f.cursor = { gen: res.generation, rev: 0 };
      f.pairs.reset();
      f.ended.clear();
    }
    if (res.snapshot.paged === true) f.complete = false;
    const all = Array.isArray(res.snapshot.items) ? res.snapshot.items : [];
    // the log is consecutive: the last item is the snapshot's revision
    const entries = Array.isArray(res.patches)
      ? res.patches.map((/** @type {any} */ p) => ({ rev: p.rev, item: p.patch.item, promotes: p.patch.promotes }))
      : all.map((/** @type {any} */ item, /** @type {number} */ i) => ({
          rev: res.snapshot.rev - (all.length - 1 - i),
          item,
          promotes: undefined,
        }));
    // a new numbering that starts after its first record: what came before is not here
    if (f.cursor?.rev === 0 && entries.length && entries[0].rev > 1) f.complete = false;
    const quiet = closedCards(entries);
    const start = entries.findLastIndex((e) => eventOf(e.item)?.kind === 'turnStart');
    const turn = eventOf(entries[start]?.item)?.turnId;
    const ended =
      turn &&
      entries.slice(start + 1).some(({ item }) => {
        const ev = eventOf(item);
        return ev?.kind === 'turnEnd' && ev.turnId === turn;
      });
    for (const e of entries) applyDurable(f, e.rev, e.item, e.promotes, quiet, ended ? null : turn);
    applyInflight(f, res.inflight);
    if (suggestionCurrent) await chatState.apply(f, res.chatState, suggestionCurrent);
    journalStatus.show(f, res.snapshot.storageError?.code);
  }

  /** Subscribes from where the transcript ends, and applies what comes back; one at a time per chat. @param {Follow} f */
  function sync(f) {
    if (f.syncing) return f.syncing;
    const done = run(f, async () => {
      if (f.host.state() !== 'online') return;
      if (!f.loaded) {
        const { cursor, open, summary } = await transcriptState(f.chatId);
        // moved to another machine, or no longer followed, while the transcript was read
        if (f.gone) return;
        f.loaded = true;
        f.cursor ??= cursor;
        f.summary = summary;
        // a card is no record, so the resume point can lie past one the running turn still waits on: the turn is replayed from its start, and only its open cards come back (applyDurable)
        f.replay = open?.rev == null ? null : open.rev - 1;
        // the turn that was running when the app closed: the controller and the windows learn of it again (the machine's records after it say how it went)
        if (open) {
          await items.flush(f.chatId);
          // the read goes on while this job takes the machine's records: those reach the session as events, so it stops here
          const upTo = await items.size(f.chatId);
          if (f.gone) return;
          state()?.get(f.chatId);
          emit({
            kind: 'turnStart',
            key: f.chatId,
            turnId: open.turnId,
            user: open.user,
            partway: { file: items.file(f.chatId), extra: [], upTo },
          });
        }
      }
      const from = f.cursor && f.replay !== null ? { gen: f.cursor.gen, rev: Math.min(f.cursor.rev, f.replay) } : f.cursor;
      f.connection ??= {};
      const suggestionCurrent = suggestionGuard(f);
      let res;
      try {
        res = await f.host.subscribe(f.chatId, from ? from.rev : undefined, from ? from.gen : undefined);
      } catch (error) {
        // a machine that is away is the normal waiting state: its return follows the chat again
        if (!QUIET.has(/** @type {any} */ (error)?.code)) throw error;
        return;
      }
      // the answer of a Host this chat left meanwhile is not applied to it
      if (follows.get(f.chatId) !== f) return;
      await apply(f, res, suggestionCurrent);
      f.replay = null;
      f.synced = true;
    }).finally(() => {
      if (f.syncing === done) f.syncing = null;
    });
    f.syncing = done;
    return done;
  }

  /** @param {string} hostId @param {any} host */
  function attach(hostId, host) {
    const prior = attached.get(hostId);
    if (prior?.host === host) return;
    if (prior) for (const off of prior.off) off();
    const mine = (/** @type {string} */ chatId) => {
      const f = follows.get(chatId);
      return f && f.host === host ? f : null;
    };
    attached.set(hostId, {
      host,
      off: [
        journalStatus.attach(host, mine, run, sync, retireSuggestion),
        host.events.onPatch(({ chatId, rev, patch }) => {
          const f = mine(chatId);
          if (f) void run(f, () => f.cursor && applyDurable(f, rev, patch.item, patch.promotes));
        }),
        host.events.onFrame(({ chatId, frame }) => {
          const f = mine(chatId);
          if (f && frame?.t === 'state') {
            const suggestionCurrent = suggestionGuard(f);
            return void run(f, () => chatState.apply(f, frame.patch, suggestionCurrent));
          }
          // a live view that will not finish (its turn ended first) is let go
          if (f && frame?.t === 'retract') return void run(f, () => f.shown.delete(frame.key));
          if (!f || frame?.t !== 'delta' || !isObject(frame.delta) || typeof frame.delta.text !== 'string') return;
          const d = /** @type {any} */ (frame.delta);
          void run(f, () => {
            f.shown.set(frame.key, (f.shown.get(frame.key) ?? '') + d.text);
            emit(textEvent(f, d, d.text, undefined, frame.key));
          });
        }),
        host.events.onResync(({ chatId, snapshot, generation }) => {
          const f = mine(chatId);
          if (f) void run(f, () => apply(f, { snapshot, generation, patches: null, inflight: [] }));
        }),
        host.events.onInflight(({ chatId, inflight }) => {
          const f = mine(chatId);
          if (f) void run(f, () => applyInflight(f, inflight));
        }),
        host.onState((state) => {
          for (const f of follows.values()) {
            if (f.host !== host) continue;
            // a new connection holds no subscription until this chat's own subscribe is answered on it
            if (state === 'online') void sync(f);
            else {
              retireSuggestion(f);
              f.synced = false;
              f.syncing = null;
            }
          }
        }),
      ],
    });
  }

  const service = {
    /**
     * Follow the chat on its owner Host: its transcript here grows with the Host's, and its events are shown. Safe to call again; a chat that is not on a
     * remote Host, or whose machine cannot be reached to make a connection, is not followed. Resolves once the chat is listed (its first record is
     * written), whether or not its machine answers.
     * @param {string} chatId
     */
    follow(chatId) {
      if (disposed) return Promise.resolve();
      const { hostId } = ownerOf(chatId);
      const host = hostId === 'local' ? null : hostFor(hostId);
      const prior = follows.get(chatId);
      if (prior && prior.host === host) return prior.tail;
      if (prior || host) chatState.withdrawSuggestion(chatId);
      if (prior) {
        prior.gone = true;
        follows.delete(chatId);
      }
      if (!host) return Promise.resolve();
      const f = {
        chatId,
        hostId,
        host,
        cursor: null,
        shown: new Map(),
        tail: Promise.resolve(),
        gone: false,
        loaded: false,
        summary: [],
        complete: true,
        refused: new Set(),
        ended: new Set(),
        pairs: createStartPairs({ unasked: (key) => sent.take(chatId, key) }),
        synced: false,
        syncing: null,
        connection: null,
        replay: null,
      };
      follows.set(chatId, f);
      attach(hostId, host);
      // asked once, and never awaited: the tunnel retries by itself, and the host's `online` brings the chat up to date
      host.connect().catch((/** @type {any} */ error) => QUIET.has(error?.code) || report(error));
      // listed first; subscribed at once when the machine answers, else when it does
      const listed = run(f, () => ensureSession(f));
      void sync(f);
      return listed;
    },
    /** The chat is no longer followed (it moved, or was removed). @param {string} chatId */
    unfollow(chatId) {
      const f = follows.get(chatId);
      if (f) {
        f.gone = true;
        chatState.withdrawSuggestion(chatId);
      }
      follows.delete(chatId);
      for (const [id, card] of waiting) if (card.chatId === chatId) waiting.delete(id);
    },
    /**
     * The user's answer to a permission card of a chat on a machine: the card's id and the option picked (null: dismissed). null when the card is not one of a followed chat's (it is
     * this Mac's); otherwise resolves whether the Host still had the card, and rejects when the Host cannot be reached (the card stays, to answer again).
     * @param {string} requestId @param {string | null} optionId
     */
    answer(requestId, optionId) {
      // a second answer while the first is on its way (another surface): the first one's; it fails as that one fails, else the card was answered
      const first = answering.get(requestId);
      if (first) return first.then(() => false);
      const card = waiting.get(requestId);
      const f = card === undefined ? undefined : follows.get(card.chatId);
      if (!card || !f) return null;
      waiting.delete(requestId);
      const sent = Promise.resolve(f.host.answer({ chatId: f.chatId, requestId: card.requestId, ...(optionId ? { optionId } : {}) })).then(
        (reply) => reply?.answered === true,
        (error) => {
          // not given to the Host: the card is still the user's to answer
          waiting.set(requestId, card);
          throw error;
        },
      );
      answering.set(requestId, sent);
      const done = () => void answering.delete(requestId);
      sent.then(done, done);
      return sent;
    },
    /** The finished items this app holds of a followed chat (as the Host keeps them), and whether they reach back to its first item; null before the chat was first read. @param {string} chatId */
    mirror(chatId) {
      const f = follows.get(chatId);
      return f?.loaded ? { items: structuredClone(f.summary), complete: f.complete } : null;
    },
    /**
     * Resolves once the chat's stream is subscribed on the machine's connection that is up now, so a message sent next has its whole reply heard (#3525). A chat not followed
     * yet (the outbox drained before every chat was followed) is followed first; it resolves at once for a chat on this Mac or whose machine is away. A subscribe that fails
     * resolves it too: the send goes on, and the Host's whole message repairs what was missed.
     * @param {string} chatId
     */
    async subscribed(chatId) {
      if (!follows.has(chatId)) await service.follow(chatId);
      const f = follows.get(chatId);
      if (!f || f.synced || f.host.state() !== 'online') return Promise.resolve();
      return sync(f).then(() => undefined);
    },
    /** The last Host revision this app holds of a followed chat (0 when it holds none). @param {string} chatId */
    rev: (chatId) => follows.get(chatId)?.cursor?.rev ?? 0,
    /** Resolves once everything queued for the chat has been applied. @param {string} chatId */
    settled: (chatId) => follows.get(chatId)?.tail ?? Promise.resolve(),
    dispose() {
      disposed = true;
      for (const { off } of attached.values()) for (const fn of off) fn();
      attached.clear();
      for (const chatId of follows.keys()) chatState.withdrawSuggestion(chatId);
      follows.clear();
      waiting.clear();
    },
  };
  return service;
}

module.exports = { createRemoteChats };

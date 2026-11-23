// The orchestrator in main: chats that start linked chats (start_session), the note a parent gets each time one of
// them ends a turn, and the wake-up that continues the parent once none of them is working. Works with no window
// open and on every harness: everything goes through the ChatController by stable chat id.
const { clock } = require('../../platform/ports/clock.cjs');
const crypto = require('node:crypto');
const { noteIgnored } = require('../../ignored.cjs');
const { quoteReport, noteText, wakeText, familyMessageText, WAKE_CAP } = require('../../../shared/sideSessions.mjs');
const { DELIVERY_BODY_CHARS } = require('../../../shared/deliveryBody.mjs');
const { addNote } = require('./journal.cjs');
const { isDescendant, nameOf, stateWord, resolveMember, rosterFor, familyList, liveParentOf } = require('./family.cjs');
const { noteDriven, reportersOf, awaitingUser, wakeWord, forgetAwaiting, waitsOnUser } = require('./reportRoute.cjs');
const { deliverToChild, pump } = require('./scheduler.cjs');
const { forgetDeleted } = require('./forget.cjs');
const { noteFacts } = require('./childWork.cjs');
const { serialized } = require('./serialStarts.cjs');
const { updateTaskList, wrapUp, recapOf, listToAge, ageTaskList, dropStaleList, sweepStaleLists } = require('./turnBox.cjs');
const { RosterStatus } = require('./rosterStatus.cjs');
const { settleDependants } = require('./dependants.cjs');
const { ranOut, offerRestart } = require('./autoHarness.cjs');
const { settleTurn } = require('./childUsage.cjs');
const { isUserTurn } = require('../userTurn.cjs');
const { detach } = require('./lifecycle.cjs');
const { closeProposal, supersedeOffers } = require('./proposals.cjs');
const { cleanupSharedNotes } = require('./childSetup.cjs');
const { start, offer, handOff, act } = require('./entrypoints.cjs');
const { queuedRemoved, queueDropped, journalQueued, queuedNote } = require('./userRemoval.cjs');

/** Family messages one turn of a chat may send to one member. */
const MESSAGES_PER_TURN = 5;
const MAX_MESSAGE_BYTES = 32768;
/**
 * @param {string} code
 * @param {string} [message]
 * @returns {never}
 */
function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

class Orchestrator {
  /**
   * @param {object} o
   * @param o.journal OrchestrationJournal
   * @param o.controller ChatController: state, ref, rt, send, stopChat
   * @param o.chats ChatsStore: records, patchMeta
   * @param o.starter ChatStarter (platform/chatStart.cjs)
   * @param [o.mainRepair] () => the separately authorized repository repair API, late-bound at app startup
   * @param o.usable (kind) => Promise<boolean>: installed, signed in, not switched off
   * @param o.projectOf (chatId) => Promise<string | null>: the chat's folder
   * @param o.worktreeInfo (path) => {branch, repo} | null: the managed worktree a folder is in
   * @param o.readExcerpt (chatId) => Promise<string | null>: the chat's recent conversation as text
   * @param o.send (chatId, item) => Promise<{started?, held?, error?}>: start a turn in an idle chat (queued when busy)
   * @param [o.deliverFamily] (chatId, item) => Promise<{started?, queued?, held?, waitingFor?, error?}>: a message to a linked chat, steered into its running turn where it can take one (a seam without it falls back to send)
   * @param o.prefs () => the app's prefs (the cap on linked sessions working at once)
   * @param o.title (chatId) => string | null: the chat's name
   * @param o.archive (chatId) => boolean: archive a chat as Settings' inactive-chat sweep does (app/autoArchive.cjs)
   * @param [o.run] git and gh runners for a session's facts and card actions (bringBack.cjs RUNNERS)
   * @param [o.factsMs] how long a wake waits for those facts (childWork.cjs FACTS_MS)
   * @param [o.now] () => number
   * @param [o.defer] (fn) => void: runs fn once the current controller call has returned
   * @param [o.said] (chatId) => string: what the user wrote in the chat's current turn (../userWords.cjs)
   * @param [o.kinds] () => string[]: the harnesses harness "auto" may pick, in order (autoHarness.cjs)
   * @param [o.quota] (kind) => {limited} | null: whether a harness is at its usage limit (autoHarness.cjs quotaOf)
   * @param [o.lacks] (kind, need) => boolean: a harness can't do what a brief needs now (computer use)
   * @param [o.childOptions] (parentId, kind, args) => inherited native settings
   * @param [o.prepareNotes] (rootId) => private shared-notes directory and grants
   * @param [o.cleanupNotes] (rootId) => retire an unreferenced shared-notes directory
   * @param [o.grantParentNotes] (parentId, path) => parent access to the shared notes on its current adapter
   * @param [o.notesDirectory] (rootId) => exact private shared-notes path, without filesystem effects
   * @param [o.approveStart] (parentId, {count, continued, signal}) => user's current approval
   * @param [o.notifyOffer] (parentId, title) => system notification for a new-task offer
   * @param [o.remotelyDriven] (chatId) => boolean: the chat is linked to claude.ai (Remote Control), so no wake-up starts it
   */
  constructor(o) {
    this.o = { now: () => clock.now(), defer: queueMicrotask, ...o };
    this.journal = o.journal;
    /** parent → starts in flight: its wake waits for them */
    this.starting = new Map();
    /** parent → the wake item its current turn was started by */
    this.waking = new Map();
    this.archiving = new Set();
    this.revokedWakes = new Set();
    /** per parent: git facts being read for its children's notes (childWork.cjs); its wake waits for them */
    this.noting = new Map();
    /** chats whose running turn the user stopped: its end is a stop, not a failure */
    this.stopping = new Set();
    /** per parent: starts run one at a time, and the same call in one turn is answered once */
    this.serial = new Map();
    this.recent = new Map();
    /** @type {Map<string, (answer: any) => void>} the offers whose call waits for the user's answer, by task id */
    this.answers = new Map();
    /** chats deleted this run: the journal forgets them (forget.cjs) */
    this.deleted = new Set();
    /** [source, turn, target] → family messages sent */
    this.sent = new Map();
    this.archived = (id) => this.o.chats.records.get(id)?.meta?.archived != null;
    /** linked chats waiting on the user: since when, and the timer that checks their parent's wake (reportRoute.cjs) */
    this.awaitingSince = new Map();
    this.settleTimers = new Map();
    /** "Linked sessions now", sent with a chat's next message from the user when it changed (rosterStatus.cjs) */
    this.roster = new RosterStatus(this);
    sweepStaleLists(this);
  }

  /** Why the tools can't be used now, or null. */
  get unavailable() {
    return this.journal.startupError;
  }

  /* -- start_session, proposals, hand-off ---------------------------- */
  /** The parent's current turn token (a start, proposal or message is remembered per turn). */
  turnOf(chatId) {
    const rt = this.o.controller.rt(chatId);
    return rt.inputToken ?? rt.token;
  }

  /** A start, a proposal or a hand-off needs the user's word: a turn the user began. */
  requireUserTurn(chatId, what) {
    if (!isUserTurn(this.o.controller.state.get(chatId).activeTurn))
      fail(
        'not_user_turn',
        `This turn wasn't started by the user, so it can't ${what}. Suggest it with start_session initiation "own_initiative", or tell the user and let them ask for it.`,
      );
  }

  /**
   * start_session: "user_asked" starts a linked child now (spawn.cjs); "offer" and "own_initiative" leave a proposal
   * (proposals.cjs); only a `proposal_id` starts that proposal. One start per parent at a time, a repeated call in one
   * turn answered once.
   */
  start(parentId, raw, ctx = {}) {
    return start.call(this, parentId, raw, ctx);
  }

  /**
   * An offer asks the user where a task they named runs, and its call waits for the answer (waitForAnswer). The
   * setting "When you ask for an unrelated task" may answer for them: always here (no card), or always a new session.
   */
  offer(parentId, args, signal) {
    return offer.call(this, parentId, args, signal);
  }

  /** hand_off_to_session: the task in progress moves to a linked fork of this chat, with the plan that is left. */
  handOff(parentId, args) {
    return handOff.call(this, parentId, args);
  }

  /** dismiss_task: withdraw one of this chat's own open proposals. */
  dismiss(parentId, { task_id: id }) {
    return closeProposal(this, String(id), { status: 'dismissed', parentId });
  }

  /**
   * A click on a proposal's card, from one of the app's windows: start it, dismiss it, or (an offer) do it in the
   * parent, which the window follows with the user's own "Do it here" message once main took it (and reopens, when
   * the chat refused that message).
   */
  act(id, action, options = null) {
    return act.call(this, id, action, options);
  }

  /** Run a start for `parentId` after the ones before it, or (queue: false) beside them (serialStarts.cjs). */
  serialized(parentId, key, run, opts) {
    return serialized(this, parentId, key, run, opts);
  }

  /* -- the controller's hooks --------------------------------------- */
  /**
   * An input is about to reach a chat: one from the user carries the linked sessions' status when it changed and lets
   * that chat's waiting notes wake it again, a new turn clears the last turn's wrap-up box, and the user's message
   * makes the task list the plan from before it.
   */
  dispatching({ chatId, kind, item, ref }) {
    if (this.unavailable) return;
    this.roster.attach({ chatId, item, ref });
    const human = isUserTurn({ human: item?.opts?.human, nonHuman: !!item?.opts?.prefix || !!item?.peer });
    noteDriven(this, { chatId, kind, item }, human);
    if (human) supersedeOffers(this, chatId);
    if (human || item?.id !== this.waking.get(chatId)) this.revokedWakes.add(chatId);
    else this.revokedWakes.delete(chatId);
    const p = this.journal.parent(chatId);
    if (p?.continuable && item && !human && item.id !== this.waking.get(chatId))
      this.journal.change((d) => (d.parents[chatId].continuable = false));
    const reset = human && !!p && (p.wakes > 0 || p.starts > 0 || p.continuedStarts > 0 || p.held || p.cutShort || !p.continuable);
    // every new turn (not a word steered into the running one) gets its own wrap-up; the user's message ages the list
    const clearBox = kind === 'turn' && !!this.journal.data.wrapUps[chatId];
    const ageList = human && listToAge(this.journal.data, chatId);
    if (!reset && !clearBox && !ageList) return;
    this.safely('note an input to a chat', () =>
      this.journal.change((d) => {
        if (reset)
          Object.assign(d.parents[chatId], { wakes: 0, starts: 0, continuedStarts: 0, continuable: true, held: false, cutShort: false });
        if (clearBox) delete d.wrapUps[chatId];
        if (ageList) ageTaskList(d, chatId, this);
      }),
    );
  }

  /**
   * The user stopped a chat's turn: a parent's notes wait for the user, and the turn's end reads as stopped. A Stop on
   * a chat with no turn running stops nothing, so it changes neither.
   */
  stopped(chatId) {
    const { turn } = this.o.controller.state.get(chatId);
    if (turn !== 'running' && turn !== 'awaitingUser') return;
    this.stopping.add(chatId);
    if (this.unavailable || !this.journal.parent(chatId) || this.journal.parent(chatId).held) return;
    this.safely('hold the notes of a stopped chat', () => this.journal.change((d) => (d.parents[chatId].held = true)));
  }

  /** A chat's turn ended (ChatController onFinished). */
  finished({ chatId, inputToken, text, completed, person = false }) {
    const stopped = this.stopping.delete(chatId);
    if (this.unavailable) return;
    dropStaleList(this, chatId);
    this.o.defer(() => this.pump());
    const parent = this.journal.parent(chatId);
    if (parent) {
      const continuable = completed && !stopped && parent.continuable;
      this.safely('record continuation authority', () => this.journal.change((d) => (d.parents[chatId].continuable = !!continuable)));
      this.waking.delete(chatId);
      if (parent.cutShort !== !completed)
        this.safely('record how a parent turn ended', () => this.journal.change((d) => (d.parents[chatId].cutShort = !completed)));
      this.o.defer(() => this.maybeWake(chatId));
    }
    if (this.journal.child(chatId))
      this.noteTurn(chatId, { inputToken, text, how: completed ? 'finished' : stopped ? 'stopped' : 'failed', person });
  }

  /** A chat's turn started waiting on the user (ChatController onAwaitingUser): its parent's wake is checked once it settles. */
  awaitingUser(chatId) {
    awaitingUser(this, chatId);
  }

  /** A chat was deleted (ChatDeletion onDeleted): the journal forgets it (forget.cjs). */
  chatDeleted(chatId) {
    const notesRoot = this.journal.child(chatId)?.notesRoot ?? chatId;
    this.deleted.add(chatId);
    // what waited in its queues never runs: its senders are told, and a wake-up's notes go up with its children (forget.cjs)
    // a failure here must not keep the journal from forgetting the chat
    this.safely('record the queue of a deleted chat', () =>
      queueDropped(this, chatId, [...this.o.controller.state.get(chatId).queue, ...journalQueued(this, chatId)], 'deleted'),
    );
    this.roster.forget(chatId);
    forgetAwaiting(this, chatId);
    this.waking.delete(chatId);
    this.stopping.delete(chatId);
    forgetDeleted(this);
    void cleanupSharedNotes(this, notesRoot);
    // the sessions waiting for it are held; one whose parent it was gets its brief as a top-level chat
    settleDependants(this);
  }

  /** A chat's harness quit mid-turn (ChatController onCrash). */
  crashed(chatId) {
    this.stopping.delete(chatId);
    if (this.unavailable) return;
    dropStaleList(this, chatId);
    this.o.defer(() => this.pump());
    if (this.journal.parent(chatId)) {
      this.waking.delete(chatId);
      this.safely('record a parent whose harness quit', () => this.journal.change((d) => (d.parents[chatId].cutShort = true)));
    }
    if (this.journal.child(chatId)) this.noteTurn(chatId, { inputToken: null, text: null, how: 'lost' });
  }

  /**
   * The note a child's ended turn leaves the chat it reports to (its parent, or the nearest live ancestor while its
   * parent is archived), then a wake if that was the last working child.
   */
  noteTurn(childId, { inputToken, text, how, person = false }) {
    const child = this.journal.child(childId);
    if (child.detached) return;
    const { parentId, viaArchived } = /** @type {{ parentId: string, viaArchived: boolean }} */ (
      liveParentOf(this.journal, childId, this.archived)
    );
    // a turn main gave it (its brief, a message, a wake-up) that the user did not write into, as CD's !turnInput.person
    const driven =
      !person && typeof inputToken === 'string' && inputToken.startsWith('pending-') && child.driven.includes(inputToken.slice(8));
    // the turn's wrap-up recap when it gave one, else its final message
    const quote = how === 'lost' ? null : quoteReport(recapOf(this.journal, childId, inputToken) ?? text);
    const branch = child.useWorktree ? (this.o.worktreeInfo(child.cwd)?.branch ?? null) : null;
    const waits = how === 'finished' && waitsOnUser(this, childId, inputToken);
    /** @type {{ deleted: string } | { archived: true } | null} */
    const via = child.deletedParent ? { deleted: String(child.deletedParent.title) } : viaArchived ? { archived: true } : null;
    const body = noteText({ title: child.title, name: child.name, chatId: childId, how, quote, branch, waits, via });
    const at = this.o.now();
    this.safely("note a linked session's turn for its parent", () =>
      this.journal.change((d) => {
        d.children[childId].lastReport = { how, report: quote?.report ?? null, chars: quote?.chars ?? 0, at, driven };
        // a turn the user drove, or one that did not finish, waits for the parent's next turn instead of waking it
        const scope = settleTurn(this, childId, d.children[childId]); // its time, and edits outside its paths
        addNote(d, parentId, { childId, body: body + scope, at, wakes: driven && how === 'finished' });
      }),
    );
    // the sessions waiting for it start, or are held (dependants.cjs), before the parent's wake is checked
    settleDependants(this);
    // a turn that failed on its harness's usage limit: a restart on another harness is offered (the wake waits for it)
    if (how === 'failed' && ranOut(this, childId))
      this.serialized(parentId, null, () => offerRestart(this, childId)).catch((error) =>
        noteIgnored('offer to restart a linked session on another harness', error),
      );
    this.o.defer(() => this.maybeWake(parentId));
    if (child.useWorktree) void noteFacts(this, childId, parentId, at);
  }

  /**
   * Continue a parent with its waiting notes when all of this holds: a note is from a turn it drove that finished;
   * it is idle with nothing queued and no start in flight; none of its children is working (one waiting for the user
   * is named instead); it was not stopped, its last turn was not cut short, and it has had fewer than WAKE_CAP wakes
   * since the user last wrote; and no wake of it is on its way already.
   */
  maybeWake(parentId) {
    if (this.unavailable) return false;
    if (this.archiving.has(parentId)) return false;
    // a chat the user steers from claude.ai is not started on by the app: its notes wait until the link is down
    if (this.o.remotelyDriven?.(parentId)) return false;
    const p = this.journal.parent(parentId);
    if (!p?.notes.some((n) => n.wakes)) return false;
    if (!this.o.chats.records.has(parentId) || this.archived(parentId)) return false;
    const s = this.o.controller.state.get(parentId);
    if (s.turn !== 'idle' || s.queue.length || s.approvals.length || this.starting.get(parentId) || this.waking.has(parentId)) return false;
    if (this.noting.get(parentId)) return false;
    // its own children and those it hears from while their parent is archived; a new request to the user still counts as work
    const children = reportersOf(this, parentId);
    const words = children.map((id) => wakeWord(this, id));
    if (words.includes('working') || words.includes('queued')) return false;
    if (p.wakes >= WAKE_CAP || p.held || p.cutShort) return false;
    const waiting = children.filter((_, i) => words[i] === 'needs the user').map((id) => nameOf(this.journal, id));
    const id = crypto.randomUUID();
    const text = wakeText({
      notes: p.notes.map((n) => n.body),
      roster: rosterFor(this.o.controller, this.journal, parentId, this.archived, this.o.notesDirectory),
      waiting,
    });
    const committed = this.safely('record a wake-up', () =>
      this.journal.change((d) => {
        d.deliveries[id] = {
          kind: 'wake',
          harness: this.o.controller.ref(parentId).kind,
          chatId: parentId,
          at: this.o.now(),
          notes: p.notes.map((n) => ({ childId: n.childId, body: n.body })),
        };
        Object.assign(d.parents[parentId], { notes: [], wakes: p.wakes + 1 });
      }),
    );
    if (!committed) return false;
    this.waking.set(parentId, id);
    // a wake the harness doesn't take waits first in the parent's queue, so its notes still arrive
    this.o
      .send(parentId, { id, sideSession: { id }, text, attachments: [], opts: { human: false } })
      .catch((error) => noteIgnored('wake a parent chat', error));
    return true;
  }

  /* -- the family tools --------------------------------------------- */
  /** Send `message` from `source` to the family member `to` names. */
  async message(source, { to, message }) {
    if (typeof message !== 'string' || !message.trim() || Buffer.byteLength(message) > MAX_MESSAGE_BYTES)
      fail('invalid_message', 'message is required (at most 32 KB)');
    const target = resolveMember(this.journal, source, to, this.archived);
    if (!target)
      fail('not_linked', `"${to}" isn't a session linked to this one: use list_sessions {"linked": true} for their ids and names`);
    if (target === source) fail('self_send', 'A chat cannot message itself');
    if (this.archived(target)) fail('chat_archived', 'That session is archived');
    if (this.journal.data.dependants[target])
      fail('session_waiting', `${nameOf(this.journal, target)} hasn't started: it waits for other sessions, and its brief goes first`);
    const budgetKey = JSON.stringify([source, this.turnOf(source), target]);
    const count = this.sent.get(budgetKey) ?? 0;
    if (count >= MESSAGES_PER_TURN) fail('send_budget_exhausted', `At most ${MESSAGES_PER_TURN} messages to one session per turn`);
    const toChild = this.journal.child(target)?.parentId === source;
    const toParent = liveParentOf(this.journal, source, this.archived)?.parentId === target;
    // a session's messages to its parent count with the wake-ups: two chats can't keep each other running unattended
    const targetParent = this.journal.parent(target);
    if (toParent && targetParent && targetParent.wakes >= WAKE_CAP)
      fail('wake_cap', 'Your parent has been continued many times since the user last wrote; it waits for the user now');
    // the user stopped the parent: nothing but the user continues it
    if (toParent && targetParent?.held)
      fail('parent_held', 'The user stopped your parent; it waits for the user now. Report in your own final message instead');
    const id = crypto.randomUUID();
    this.journal.change((d) => {
      d.deliveries[id] = { kind: 'message', chatId: target, from: source, body: message.slice(0, DELIVERY_BODY_CHARS), at: this.o.now() };
      if (toChild) d.children[target].driven.push(id);
      if (toParent && d.parents[target]) d.parents[target].wakes += 1;
    });
    this.sent.set(budgetKey, count + 1);
    if (this.sent.size > 500) this.sent.delete(this.sent.keys().next().value);
    const text = familyMessageText({
      fromName: this.o.title(source) || nameOf(this.journal, source),
      fromId: source,
      relation: toParent ? 'child' : toChild ? 'parent' : 'sibling',
      body: message,
      roster: rosterFor(this.o.controller, this.journal, target, this.archived, this.o.notesDirectory),
    });
    const item = { id, sideSession: { id }, text, attachments: [], opts: { human: false } };
    const answer = { message_id: id, to: target, name: nameOf(this.journal, target) };
    // a follow-up to a session this chat started waits behind its recipient’s current work (scheduler.cjs)
    if (toChild) {
      const sent = await this.deliver(target, item);
      return {
        status: sent?.started ? 'delivered' : 'queued',
        ...answer,
        // a follow-up waiting for a free slot (a queue position) is in the journal's queue, where the user has no row to remove
        ...(sent?.started || sent?.position ? {} : { note: queuedNote(sent?.waitingFor) }),
        ...(sent?.position ? { queue_position: sent.position } : {}),
        ...(sent?.error ? { error: sent.error } : {}),
      };
    }
    // a running chat that can steer takes it into the current turn; otherwise it waits in the chat's queue (familyDelivery.cjs)
    const receipt = await this.o.controller.deliverFamily(target, item);
    const started = !!receipt?.started;
    return {
      status: started ? 'delivered' : 'queued',
      ...answer,
      ...(started ? {} : { note: queuedNote(receipt?.waitingFor) }),
      ...(receipt?.error ? { error: receipt.error } : {}),
    };
  }

  /** Stop the running turn of a session `source` started (directly or further down). */
  async stop(source, { id }) {
    const target = resolveMember(this.journal, source, id);
    if (!target || !isDescendant(this.journal, target, source))
      fail('not_linked', 'Only a session this chat started can be stopped from here');
    const s = this.o.controller.state.get(target);
    if (s.turn !== 'running' && s.turn !== 'awaitingUser')
      return { stopped: false, state: stateWord(this.o.controller, this.journal, target) };
    return { stopped: !!(await this.o.controller.stopChat(target)), name: nameOf(this.journal, target) };
  }

  /**
   * Archive a session `source` started (directly or further down), the way an inactive chat is archived (o.archive):
   * not one that is working or waiting for the user. What waited in the queue for it is dropped with a note (pump).
   */
  archive(source, { id }) {
    const target = resolveMember(this.journal, source, id);
    if (!target || !isDescendant(this.journal, target, source))
      fail('not_linked', 'Only a session this chat started can be archived from here');
    const name = nameOf(this.journal, target);
    if (this.archived(target)) return { archived: true, name, already: true };
    const state = stateWord(this.o.controller, this.journal, target);
    if (state === 'working' || state === 'needs the user')
      fail('session_busy', `${name} is ${state === 'working' ? 'working' : 'waiting for the user'}: stop it with stop_session first`);
    if (this.o.archive(target) !== true) fail('archive_failed', `${name} could not be archived`);
    this.pump();
    return { archived: true, name };
  }

  /** The other chats of `source`'s family: names, ids, what each is doing and its latest report (family.cjs). */
  list(source) {
    return familyList(this, source);
  }

  /** The user took a message out of `chatId`'s queue before it ran (userRemoval.cjs). */
  queuedRemoved(chatId, item) {
    return queuedRemoved(this, chatId, item);
  }

  /** A user detaches lineage without erasing the delivered task or its historical provenance. */
  detach(chatId) {
    return detach(this, chatId);
  }

  /** update_task_list: the chat's own task list (turnBox.cjs). */
  taskList(chatId, args) {
    return updateTaskList(this, chatId, args);
  }

  /** wrap_up: the turn's recap, question and answers (turnBox.cjs). */
  wrapUp(chatId, args) {
    return wrapUp(this, chatId, args);
  }

  /** Send a parent's item to its linked child now, or queue it behind that recipient’s work (scheduler.cjs). */
  deliver(chatId, item) {
    return deliverToChild(this, chatId, item);
  }

  /** Start what waits in the queue while slots are free: after a turn ends, a crash, a Stop, startup or a new cap. */
  pump() {
    forgetDeleted(this);
    settleDependants(this);
    pump(this);
  }

  /** Runs a journal change that must not break the controller call it rides on; false when it failed. */
  safely(what, fn) {
    try {
      fn();
      return true;
    } catch (error) {
      noteIgnored(what, error);
      return false;
    }
  }
}

module.exports = { Orchestrator, MESSAGES_PER_TURN };

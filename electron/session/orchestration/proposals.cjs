// Sessions a chat proposes instead of starting: an offer for a task the user named ("New session" or "Do it here")
// and the agent's own suggestions (a card the user may start within a week). The user's click, or their word in a
// later turn (start_session with the proposal's id), starts one; the agent may withdraw its own (dismiss_task).
const { clock } = require('../../platform/ports/clock.cjs');
const crypto = require('node:crypto');
const { addNote } = require('./journal.cjs');
const { nameOf } = require('./family.cjs');
const { startChild } = require('./spawn.cjs');
const { parseKind } = require('../../../shared/harnessKind.mjs');
const { predecessorsOf } = require('./dependants.cjs');
const { isUserTurn } = require('../userTurn.cjs');
const { authorizeStart, startRequest } = require('./startPolicy.cjs');
const { startArgs } = require('./spawn.cjs');
const { suggestionLimit } = require('./planAcceptance.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** How long a proposal can be started. */
const PROPOSAL_DAYS = 7;
/** How long an offer's call waits for the user's answer: under Codex's 15-minute limit on MoPilot's tools. */
const OFFER_WAIT_MS = 13 * 60_000;
/** How long an offer's card counts down before it goes ahead as "New session" for a user who has not answered. */
const OFFER_COUNTDOWN_MS = 60_000;
/** What the agent is told when the user chose "Do it here" (and the line that call reads as, "Kept in this session"). */
const HERE_NEXT = 'The user chose "Do it here": do the task now, in this chat, in this turn. Start no session for it.';
/** How the agent is told who chose "New session": the user, or the countdown for a user who did not answer. */
const NEW_SESSION_BY = {
  click: 'The user chose "New session"',
  auto: `Nobody answered the card within ${OFFER_COUNTDOWN_MS / 1000} seconds, so it went ahead as "New session"`,
};
/** What the agent is told when its offer's call ends with the card still open (the cap, a Stop, its turn's end). */
const OPEN_NEXT =
  'The user did not answer the card: end your turn now. It stays open; if they choose "New session" later, the session starts and its notes reach you, and "Do it here" comes back as their reply.';
/** What the agent is told when the user's new message waits behind its turn: it ends the turn, so that message runs next. */
const QUEUED_NEXT =
  'The user sent a new message instead of answering the card; it waits until this turn ends. The offer is closed and nothing started: do not start the task. Say in one line that you will read their message first, and end your turn.';
/** By Orchestrator: its offers counting down to "New session", each by task id with what stops it. */
const COUNTDOWNS = new WeakMap();
/** A proposal the user has not finished with: open, or taken by a click and starting or waiting for its brief. */
const LIVE = new Set(['open', 'starting', 'briefing']);
/** Suggestions one turn may leave. */
const SUGGESTIONS_PER_TURN = 3;

/**
 * @param {string} code
 * @param {string} [message]
 * @returns {never}
 */
function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

/** A proposal's status now: one still open past its time has expired. */
function proposalStatus(p, now) {
  return p.status === 'open' && now > p.expiresAt ? 'expired' : p.status;
}

/** @param {any} orch @returns {Map<string, () => void>} the orchestrator's offers counting down, by task id */
function countdownsOf(orch) {
  if (!COUNTDOWNS.has(orch)) COUNTDOWNS.set(orch, new Map());
  return COUNTDOWNS.get(orch);
}

/**
 * Leave a proposal in the parent's transcript. An offer answers the task the user just named, so it needs a turn the
 * user started; the agent's own suggestions may come from any turn, at most SUGGESTIONS_PER_TURN, none twice.
 * @param {any} orch the Orchestrator
 * @param {string} parentId
 * @param {any} args checked start arguments (spawn.cjs startArgs)
 * @param {string | null} turn the parent's current turn token
 */
function propose(orch, parentId, args, turn) {
  const { o, journal } = orch;
  const now = o.now();
  const kind = args.initiation;
  if (kind === 'offer' && !isUserTurn(o.controller.state.get(parentId).activeTurn))
    fail('not_user_turn', 'An offer answers a task the user named in this turn. Suggest it with initiation "own_initiative" instead.');
  if (kind === 'offer') {
    const waiting = Object.entries(journal.data.proposals).find(
      ([, p]) => p.parentId === parentId && p.kind === 'offer' && p.status === 'open' && p.waiting,
    );
    if (waiting)
      return {
        status: 'proposed',
        task_id: waiting[0],
        kind,
        title: waiting[1].args.title,
        repeated: true,
        next: `An offer is already on its card (${waiting[0]}). Wait for its answer; do not create another offer.`,
      };
  }
  // the sessions it would wait for are checked now, and again when it starts (by then one may be gone)
  predecessorsOf(journal, parentId, args.after);
  const mine = Object.entries(journal.data.proposals).filter(([, p]) => p.parentId === parentId && p.turn === turn && p.kind === kind);
  // a suggestion still live stays the one card when a later turn suggests it again (the user's retry re-asks the agent)
  const same =
    mine.find(([, p]) => p.args.title === args.title) ??
    (kind === 'own_initiative'
      ? Object.entries(journal.data.proposals).find(
          ([, p]) => p.parentId === parentId && p.kind === kind && p.args.title === args.title && LIVE.has(proposalStatus(p, now)),
        )
      : undefined);
  if (same) return { status: 'proposed', task_id: same[0], kind, title: args.title, repeated: true };
  const limit = suggestionLimit(orch, parentId);
  if (kind === 'own_initiative' && mine.length >= limit)
    fail('proposal_limit', `At most ${limit} suggestions per turn; mention any others in your reply`);
  const id = `task_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  journal.change((d) => {
    d.proposals[id] = {
      parentId,
      kind,
      args,
      // its harness is the parent's or one the user named (ownHarness.cjs, #2084)
      harnessChecked: true,
      turn,
      status: 'open',
      createdAt: now,
      expiresAt: now + PROPOSAL_DAYS * 86400000,
      chatId: null,
      // an offer's call waits for the user's answer (waitForAnswer); the card is its question meanwhile
      ...(kind === 'offer' ? { waiting: true } : {}),
    };
  });
  if (kind === 'offer') o.notifyOffer?.(parentId, args.title);
  return {
    status: 'proposed',
    task_id: id,
    kind,
    title: args.title,
    next:
      kind === 'offer'
        ? OPEN_NEXT
        : 'Nothing runs until the user starts it from the card or asks you to (then call start_session with only this task_id). It expires in 7 days; withdraw it with dismiss_task if it goes stale.',
  };
}

/**
 * Start an open proposal, once: a second click or call while it starts is refused. `by` says whose word started it,
 * the user's click, the parent's turn the user began, or (`auto`) an offer's countdown for a user who did not answer,
 * which starts on that turn's authority; a click leaves the parent a note that it started.
 * @param {any} orch
 * @param {string} id
 * @param {{ by: 'click' | 'turn' | 'auto', parentId?: string, options?: unknown, brief?: any, signal?: AbortSignal | null, request?: any }} how parentId: the owning chat; options: the user's card picks
 */
async function startProposal(orch, id, { by, parentId, options = null, brief = null, signal = null, request = null }) {
  const { o, journal } = orch;
  const p = journal.proposal(id);
  if (!p || (parentId && p.parentId !== parentId)) fail('not_found', `No proposal ${id} from this chat`);
  const status = proposalStatus(p, o.now());
  if (status !== 'open' && !(status === 'briefing' && by === 'turn' && brief)) fail('not_open', `That proposal is ${status}`);
  // one proposed before #2084 may carry a harness the agent chose on its own: it starts on the parent's, unless the
  // user picks one on the card (options)
  const proposed = p.harnessChecked || !p.args.harness ? p.args : { ...p.args, harness: null };
  // the user's word starts it, so a folder that can't hold a worktree runs it in the folder (spawn.cjs makeChild)
  if (brief && Object.keys(brief).some((key) => !['proposal_id', 'prompt', 'background'].includes(key)))
    fail('invalid_options', 'An accepted offer takes only proposal_id, prompt and background; its settings were chosen on the card.');
  const content = brief
    ? startArgs({
        title: proposed.title,
        prompt: brief.prompt,
        background: brief.background,
        context: proposed.context,
        initiation: 'user_asked',
      })
    : null;
  const filled = content ? { ...proposed, prompt: content.prompt, background: content.background } : proposed;
  const args = { ...filled, ...startOptions(options), folderIfNoWorktree: true };
  const reserved = status === 'briefing';
  journal.change((d) => (d.proposals[id].status = 'starting'));
  try {
    const claim = await authorizeStart(orch, p.parentId, { clicked: by === 'click', signal, reserved, request });
    const result = await startChild(
      orch,
      p.parentId,
      { ...args, claim, deferBrief: !args.prompt, reservedChatId: reserved ? p.chatId : null },
      p.kind,
    );
    journal.change((d) => {
      Object.assign(d.proposals[id], {
        status: args.prompt ? 'started' : 'briefing',
        chatId: result.chat_id,
        ...(brief ? { args: filled } : {}),
      });
      // a start on an offer whose call still waits answers that call, and the agent's own start is its call's
      // result; only a click or countdown start whose call has ended (a cap, a Stop meanwhile) needs a note
      if (by === 'turn' || orch.answers?.has(id)) return;
      const who =
        by === 'auto'
          ? `Nobody answered the card for your offered task ${id} ("${p.args.title}"), so it started`
          : `The user started your proposed task ${id} ("${p.args.title}")`;
      // a reserved session from a countdown waits for its brief, which only the agent can write (a late click's
      // window asks for it itself)
      const then =
        by === 'auto' && !args.prompt
          ? `It waits for its brief: call start_session with exactly proposal_id "${id}", prompt and background, and do not do the task here.`
          : 'It runs on its own; you get a note when it ends a turn.';
      addNote(d, p.parentId, {
        childId: result.chat_id,
        body: `${who} as a separate session (${nameOf(journal, result.chat_id)}, ${result.chat_id}). ${then}`,
        at: o.now(),
        wakes: false,
      });
    });
    return {
      ...result,
      task_id: id,
      ...(!args.prompt
        ? {
            next: `${NEW_SESSION_BY[by === 'auto' ? 'auto' : 'click']} for "${p.args.title}" (task_id: ${id}). Write its brief now: call start_session with exactly proposal_id "${id}", prompt and background. No other arguments; the settings were chosen on the card. Do not do the task here. When it returns, say it is running, link it and end your turn.`,
          }
        : {}),
    };
  } catch (error) {
    // open again, so the user can try once the cause is fixed
    orch.safely('reopen a proposal that did not start', () =>
      journal.change((d) => (d.proposals[id].status = reserved ? 'briefing' : 'open')),
    );
    throw error;
  }
}

/**
 * What the user changed on the card before Start (Claude Desktop locks these as proposed; here the user may pick): the
 * harness ("codex", "claude" or "acp:<id>"; null keeps the proposed one) and whether it gets its own worktree. Anything
 * else is refused, so a window can't slip other arguments into the start.
 * @param {unknown} options
 * @returns {{ harness?: string, useWorktree?: boolean, model?: string, effort?: string, permission?: string, userSelected?: boolean }} internal checked names
 */
function startOptions(options) {
  if (options == null) return {};
  if (typeof options !== 'object') fail('invalid_options', 'Start options are an object');
  const { harness, useWorktree, model, effort, permission, ...rest } = /** @type {any} */ (options);
  if (Object.keys(rest).length) fail('invalid_options', `Unknown start options: ${Object.keys(rest).join(', ')}`);
  const out = {};
  if (harness != null) {
    if (typeof harness !== 'string' || !parseKind(harness)) fail('invalid_harness', 'harness is codex, claude or acp:<id>');
    out.harness = harness;
  }
  if (useWorktree != null) {
    if (typeof useWorktree !== 'boolean') fail('invalid_options', 'useWorktree is true or false');
    out.useWorktree = useWorktree;
  }
  for (const [key, value] of Object.entries({ model, effort, permission })) {
    if (value == null) continue;
    if (typeof value !== 'string' || !value.trim() || value.length > 200)
      fail('invalid_options', `${key} must be a setting shown on the card`);
    out[key] = value.trim();
    out.userSelected = true;
  }
  return out;
}

/**
 * Set an open proposal aside: the agent withdrawing its own (dismiss_task, `parentId` set), the user dismissing a
 * card, or "Do it here" on an offer (declined).
 * @param {any} orch
 * @param {string} id
 * @param {{ status: 'dismissed' | 'declined', parentId?: string }} how
 */
function closeProposal(orch, id, { status, parentId }) {
  const p = orch.journal.proposal(id);
  if (!p || (parentId && p.parentId !== parentId)) fail('not_found', `No proposal ${id} from this chat`);
  const now = proposalStatus(p, orch.o.now());
  if (now !== 'open') fail('not_open', `That proposal is ${now}`);
  if (status === 'declined' && p.kind !== 'offer') fail('not_offer', 'Only an offer can be done here');
  orch.journal.change((d) => (d.proposals[id].status = status));
  return { task_id: id, status };
}

/**
 * Open an offer the user's "Do it here" declined again: the card claims the offer before its "Do it here." goes to the
 * chat, and a send the chat refused (the text waits in the composer) gives the offer back. Only a declined offer.
 * @param {any} orch
 * @param {string} id
 */
function reopenProposal(orch, id) {
  const p = orch.journal.proposal(id);
  if (!p) fail('not_found', `No proposal ${id}`);
  if (p.status !== 'declined') fail('not_declined', `That proposal is ${proposalStatus(p, orch.o.now())}`);
  orch.journal.change((d) => (d.proposals[id].status = 'open'));
  return { task_id: id, status: 'open' };
}

/**
 * A new human message takes precedence over an unanswered card; it never means the user chose either answer. One that
 * waits behind the turn (`queued`) has the agent end its turn, so the message runs next.
 */
function supersedeOffers(orch, parentId, { queued = false } = {}) {
  const offers = Object.entries(orch.journal.data.proposals).filter(
    ([, p]) => p.parentId === parentId && p.kind === 'offer' && p.status === 'open' && p.waiting,
  );
  if (!offers.length) return;
  orch.journal.change((d) => {
    for (const [id] of offers) d.proposals[id].status = 'dismissed';
  });
  for (const [id, p] of offers)
    orch.answers.get(id)?.({
      status: 'dismissed',
      task_id: id,
      kind: 'offer',
      title: p.args.title,
      answer: 'superseded',
      next: queued
        ? QUEUED_NEXT
        : 'The user sent a new message instead of answering the card. The offer is closed and nothing started. Read their message first; do not offer this task again unless it still fits what they asked.',
    });
}

/**
 * A message waits in a chat's queue behind its running turn (ChatController onQueued: a harness that can't steer, or a
 * follow-up the user queued). The user's own message takes precedence over the turn's offer, as one steered in does.
 * @param {any} orch
 * @param {string} chatId
 * @param {any} item the queued message
 */
function queuedOverOffers(orch, chatId, item) {
  if (isUserTurn({ human: item?.opts?.human, nonHuman: !!item?.opts?.prefix || !!item?.peer }))
    supersedeOffers(orch, chatId, { queued: true });
}

/**
 * The turn that asked was stopped, its harness quit or the turn ended (ChatController onStopped, onCrash, onFinished):
 * its offer's call is let go even where the harness did not cancel it, and the card waits on its own, counting no more.
 * @param {any} orch
 * @param {string} chatId
 */
function releaseOffers(orch, chatId) {
  for (const [id, p] of Object.entries(orch.journal.data.proposals))
    if (p.parentId === chatId && p.kind === 'offer' && p.waiting)
      orch.answers.get(id)?.({ status: 'proposed', task_id: id, kind: 'offer', title: p.args.title, still_open: true, next: OPEN_NEXT });
}

/**
 * Hold an offer's call until the user answers its card: "New session" (the start's result), "Do it here", or neither
 * before the call's own cancel (a Stop) or OFFER_WAIT_MS, when the agent is told to end its turn and the card stays.
 * Meanwhile the card counts down OFFER_COUNTDOWN_MS (its `countdown`, which windows draw) and then goes ahead as
 * "New session" for the user, unless they took the card in hand first (holdOffer). The answer is settled once, by
 * whichever comes first; the proposal stops waiting and counting either way.
 * @param {any} orch the Orchestrator (its `answers`: task id -> settle; its countdowns, countdownsOf: task id -> stop)
 * @param {any} proposed propose()'s result
 * @param {AbortSignal | null} signal
 * @returns {Promise<any>}
 */
function waitForAnswer(orch, proposed, signal) {
  const id = proposed.task_id;
  return new Promise((resolve) => {
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let timer;
    /** @type {ReturnType<typeof setTimeout> | undefined} */
    let countdown;
    // every way out (the answer, the cancel, the cap, the countdown) clears the others, so this runs once
    const settle = (answer) => {
      orch.answers.delete(id);
      countdownsOf(orch).delete(id);
      clock.clearTimeout(timer);
      clock.clearTimeout(countdown);
      signal?.removeEventListener('abort', unanswered);
      orch.safely('stop waiting on an offer', () =>
        orch.journal.change((d) => {
          if (!d.proposals[id]) return;
          delete d.proposals[id].waiting;
          delete d.proposals[id].countdown;
        }),
      );
      resolve(answer);
    };
    const unanswered = () => settle({ ...proposed, still_open: true });
    orch.answers.set(id, settle);
    if (signal?.aborted) return unanswered();
    signal?.addEventListener('abort', unanswered, { once: true });
    timer = clock.setTimeout(unanswered, orch.offerWaitMs ?? OFFER_WAIT_MS);
    const ms = orch.offerCountdownMs ?? OFFER_COUNTDOWN_MS;
    const from = orch.o.now();
    // a countdown the card can't show never runs: the user would not know it was about to answer for them
    if (!orch.safely('count down an offer', () => orch.journal.change((d) => (d.proposals[id].countdown = { from, at: from + ms }))))
      return;
    countdown = clock.setTimeout(() => goAheadNew(orch, id), ms);
    countdownsOf(orch).set(id, () => clock.clearTimeout(countdown));
  });
}

/**
 * Start a proposal answered "New session": the user's click, or (`auto`) an offer's countdown for a user who did not
 * answer. Either stops the countdown first, so a start that fails leaves the card waiting for the user. An offer whose
 * call still waits gets the start's result as its answer, saying who chose it.
 * @param {any} orch
 * @param {string} id
 * @param {{ options?: unknown, auto?: boolean }} [how] options: the user's card picks
 */
function startAnswered(orch, id, { options = null, auto = false } = {}) {
  const p = orch.journal.proposal(id);
  if (!p) fail('not_found', `No proposal ${id}`);
  holdOffer(orch, id);
  const request = startRequest(orch, p.parentId);
  // the user's clicks start side by side (Start all): each proposal is its own, and a click needs no start budget
  const run = () => startProposal(orch, id, { by: auto ? 'auto' : 'click', options, request });
  return orch.serialized(p.parentId, null, run, { queue: false }).then((started) => {
    const answer = orch.answers.get(id);
    answer?.({
      ...started,
      answer: 'new_session',
      ...(auto ? { auto: true } : {}),
      next:
        started.next ??
        `${NEW_SESSION_BY[auto ? 'auto' : 'click']}: it runs on its own and its notes reach you. Do not do the task here. Say so, link it and end your turn.`,
    });
    return { ...started, answered: !!answer };
  });
}

/**
 * An offer's countdown ran out: "New session" for the user who did not answer, as their own click would, unless the
 * card was answered or taken in hand meanwhile. A start that fails leaves the card open, waiting for them.
 * @param {any} orch
 * @param {string} id
 */
function goAheadNew(orch, id) {
  const p = orch.journal.proposal(id);
  countdownsOf(orch).delete(id);
  if (!orch.answers.has(id) || !p?.countdown) return;
  // a card being started meanwhile waits for the user and shows no countdown
  if (proposalStatus(p, orch.o.now()) !== 'open') return hideCountdown(orch, id);
  // its hold and start run inside the promise, so a journal write that fails there is caught too; any failure leaves
  // the card open for the user with no countdown on show, as nothing answers for them now
  Promise.resolve()
    .then(() => startAnswered(orch, id, { auto: true }))
    .catch((error) => {
      noteIgnored('go ahead as a new session for an unanswered offer', error);
      hideCountdown(orch, id);
    });
}

/** Take an offer's countdown off the record windows draw, as far as the journal can write. */
function hideCountdown(orch, id) {
  orch.safely('stop showing an offer’s countdown', () => orch.journal.change((d) => delete d.proposals[id].countdown));
}

/**
 * The user took an offer's card in hand (its start options, "Don't ask again", or an answer that is starting): its
 * countdown stops for good, and the card waits for their answer as long as its call waits. One not counting is left as it is.
 * @param {any} orch
 * @param {string} id
 */
function holdOffer(orch, id) {
  const p = orch.journal.proposal(id);
  if (!p) fail('not_found', `No proposal ${id}`);
  // the record first: a hold the journal can't write leaves the countdown running, as every window still shows it
  if (p.countdown) orch.journal.change((d) => delete d.proposals[id].countdown);
  const stop = countdownsOf(orch).get(id);
  countdownsOf(orch).delete(id);
  stop?.();
  return { task_id: id, held: !!stop };
}

module.exports = {
  propose,
  startProposal,
  closeProposal,
  reopenProposal,
  proposalStatus,
  waitForAnswer,
  startAnswered,
  holdOffer,
  countdownsOf,
  queuedOverOffers,
  releaseOffers,
  PROPOSAL_DAYS,
  SUGGESTIONS_PER_TURN,
  OFFER_WAIT_MS,
  OFFER_COUNTDOWN_MS,
  HERE_NEXT,
  NEW_SESSION_BY,
  OPEN_NEXT,
  QUEUED_NEXT,
  supersedeOffers,
};

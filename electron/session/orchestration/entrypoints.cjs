// Linked-session start/offer/card entrypoints: serialized intent, title-first proposals and user-owned settings.
const { startArgs, startChild } = require('./spawn.cjs');
const {
  propose,
  startProposal,
  startAnswered,
  closeProposal,
  reopenProposal,
  waitForAnswer,
  holdOffer,
  HERE_NEXT,
} = require('./proposals.cjs');
const { ownHarness, noted } = require('./ownHarness.cjs');
const { authorizeStart, startRequest, startAuthority } = require('./startPolicy.cjs');
const { isUserTurn } = require('../userTurn.cjs');
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

function start(parentId, raw, ctx = {}) {
  ctx = { ...ctx, request: startRequest(this, parentId) };
  if (raw?.proposal_id !== undefined) {
    if (raw.prompt !== undefined || !startAuthority(this, parentId)) this.requireUserTurn(parentId, 'start a proposed session');
    return this.serialized(parentId, null, () =>
      startProposal(this, String(raw.proposal_id), {
        by: 'turn',
        parentId,
        brief: raw.prompt !== undefined ? raw : null,
        signal: ctx.signal,
        request: ctx.request,
      }),
    );
  }
  // on this chat's harness, or one the user picked (ownHarness.cjs)
  const { args, ignored } = ownHarness(this, parentId, startArgs(raw));
  if (args.initiation === 'offer') return noted(this.offer(parentId, args, ctx.signal ?? null), ignored);
  if (args.initiation !== 'user_asked') {
    const turn = this.turnOf(parentId);
    return noted(
      Promise.resolve().then(() => propose(this, parentId, args, turn)),
      ignored,
    );
  }
  if (!startAuthority(this, parentId)) this.requireUserTurn(parentId, 'start a session');
  return noted(
    this.serialized(parentId, JSON.stringify([parentId, this.turnOf(parentId), args]), async () => {
      const claim = await authorizeStart(this, parentId, ctx);
      return startChild(this, parentId, { ...args, claim });
    }),
    ignored,
  );
}

async function offer(parentId, args, signal) {
  const request = startRequest(this, parentId);
  const choice = this.o.prefs?.()?.newTaskPrompt;
  if (choice === 'here' || choice === 'new') {
    this.requireUserTurn(parentId, 'offer a session');
    if (choice === 'here') return { status: 'declined', kind: 'offer', title: args.title, answer: 'here', next: HERE_NEXT };
    if (!args.prompt) {
      const proposed = propose(this, parentId, args, this.turnOf(parentId));
      const accepted = await this.serialized(parentId, null, () =>
        startProposal(this, proposed.task_id, { by: 'turn', parentId, signal, request }),
      );
      return { ...accepted, answer: 'new_session' };
    }
    const started = await this.serialized(parentId, JSON.stringify([parentId, this.turnOf(parentId), 'offer', args]), async () =>
      startChild(
        this,
        parentId,
        { ...args, folderIfNoWorktree: true, claim: await authorizeStart(this, parentId, { signal, request }) },
        'offer',
      ),
    );
    return { ...started, answer: 'new_session' };
  }
  const proposed = propose(this, parentId, args, this.turnOf(parentId));
  // the same offer again in this turn answers with its task; only the first call waits on the card
  if (proposed.repeated || this.answers.has(proposed.task_id)) return proposed;
  return waitForAnswer(this, proposed, signal);
}

function handOff(parentId, { title, remaining_plan: plan, use_worktree: useWorktree = false, paths }) {
  // in this folder by default: the task moves on with the same files, and every harness that can fork forks here
  const request = startRequest(this, parentId);
  const args = startArgs({ title, prompt: plan, context: 'fork', use_worktree: useWorktree, paths });
  if (!isUserTurn(this.o.controller.state.get(parentId).activeTurn)) fail('not_user_turn', 'Only the user’s turn can hand off its task.');
  return this.serialized(parentId, JSON.stringify([parentId, this.turnOf(parentId), 'hand_off', args]), async () =>
    startChild(this, parentId, { ...args, claim: await authorizeStart(this, parentId, { request }) }, 'hand_off'),
  );
}

function act(id, action, options = null) {
  // the user answered: an offer stops counting down, so a start that fails leaves its card waiting for them
  if (action === 'start') return startAnswered(this, id, { options });
  if (action === 'dismiss' || action === 'here')
    return Promise.resolve().then(() => {
      const closed = closeProposal(this, id, { status: action === 'here' ? 'declined' : 'dismissed' });
      // "Do it here" on an offer whose call waits answers that call: the agent carries on in the same turn, and the
      // window sends nothing; one whose call has ended is the user's reply, which the window sends
      const answer = this.answers.get(id);
      const title = this.journal.proposal(id).args.title;
      answer?.(
        action === 'here'
          ? { status: 'declined', task_id: id, kind: 'offer', title, answer: 'here', next: HERE_NEXT }
          : { status: 'dismissed', task_id: id, kind: 'offer', title, next: 'The user dismissed the card: start no session for it.' },
      );
      return { ...closed, answered: !!answer };
    });
  if (action === 'reopen') return Promise.resolve().then(() => reopenProposal(this, id));
  // the user took the card in hand (its start options, "Don't ask again"): it waits for their answer
  if (action === 'hold') return Promise.resolve().then(() => holdOffer(this, id));
  fail('invalid_action', 'action is start, dismiss, here, reopen or hold');
}

module.exports = { start, offer, handOff, act };

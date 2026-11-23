// Main-owned plan acceptance: validate the shared plan button and root native approvals before granting four suggestions.
const { clock } = require('../../platform/ports/clock.cjs');
const { isUserTurn } = require('../userTurn.cjs');
const { emptyParent } = require('./journal.cjs');
const { MAIN_TRAITS } = require('../../harness/family.cjs');
const { noteIgnored } = require('../../ignored.cjs');

const { IMPLEMENT_PLAN, withoutRosterBlock } = require('../../../shared/sideSessions.mjs');
const { setTimeout: sleep } = require('node:timers/promises');
/**
 * How long a plan click waits for the turn its window already shows as over to end in main too: Codex holds a turn's
 * end until its final snapshot is taken (codexEvents.cjs turn/completed), a few git calls that each time out.
 */
const TURN_END_WAIT_MS = 30_000;
const TURN_END_POLL_MS = 50;
const permissions = new WeakMap();
const claims = new WeakMap();
const requestsOf = (orch) => {
  if (!permissions.has(orch)) permissions.set(orch, new Map());
  return permissions.get(orch);
};
const fail = () => {
  throw Object.assign(new Error('This plan changed or is no longer available. Open its latest plan and try again.'), {
    code: 'plan_changed',
  });
};

/** Raw UI arguments cannot supply main's accepted-plan marker, even on an ordinary send. */
function cleanPlanInput(item) {
  if (!item || typeof item !== 'object') return item;
  const { planApproval: _proof, ...clean } = item;
  if (item.opts && typeof item.opts === 'object') {
    const { acceptedPlan: _intent, planApproval: _optionProof, ...opts } = item.opts;
    clean.opts = opts;
  }
  return clean;
}

/** Return synchronously for ordinary input so this boundary does not defer unrelated send receipts. */
function preparePlanInput(live, chatId, item, trusted) {
  const clean = cleanPlanInput(item);
  if (item?.opts?.acceptedPlan === undefined) return clean;
  return verifyPlanInput(live, chatId, clean, item.opts.acceptedPlan, trusted);
}

async function verifyPlanInput(live, chatId, clean, intent, trusted) {
  if (
    !trusted() ||
    !intent ||
    typeof intent.itemId !== 'string' ||
    !intent.itemId ||
    typeof intent.text !== 'string' ||
    !intent.text.trim() ||
    clean.text !== IMPLEMENT_PLAN ||
    clean.opts?.human !== true ||
    clean.opts.plan !== false ||
    clean.peer ||
    clean.opts.prefix ||
    clean.attachments?.length
  )
    fail();
  // the plan card shows once the window has the turn's end; main may not have it yet, so the click waits for it
  await turnEnded(live, chatId, trusted);
  const controller = live.controller;
  const record = live.chats.records.get(chatId);
  const ref = controller.ref(chatId);
  const state = controller.state;
  const writer = state.localWriterToken(chatId);
  const archiveEpoch = live.chats.archiveEpoch?.(chatId);
  const current = () =>
    trusted() &&
    record &&
    live.chats.records.get(chatId)?.segments === record.segments &&
    !live.chats.isDeleted(chatId) &&
    live.chats.archiveEpoch?.(chatId) === archiveEpoch &&
    live.chats.records.get(chatId)?.meta?.archived == null &&
    controller.ref(chatId).key === ref.key &&
    state.localWriterToken(chatId) === writer &&
    state.get(chatId).turn === 'idle' &&
    !state.get(chatId).pendingSwitch &&
    !live.orchestrator?.stopping.has(chatId) &&
    !live.orchestrator?.archiving.has(chatId);
  if (!current()) fail();
  let page;
  try {
    // References replace oversized turns with excerpts; exact plan identity/text needs the full history.
    page = await live.peerRuntime.readHistory(chatId);
  } catch (error) {
    noteIgnored('verify the plan the user chose to implement', error);
    fail();
  }
  if (!current()) fail();
  const turn = page?.turns?.at(-1);
  if (turn?.status !== 'completed' || !Array.isArray(turn.items)) fail();
  const items = turn.items;
  // A native plan item wins over the plain-message fallback, just as the shared PlanCard does.
  let plan = [...items].reverse().find((i) => i?.type === 'plan' && typeof i.text === 'string' && i.text.trim());
  if (!plan) {
    // The trusted button's exact displayed item is the user's intent, also after restart when renderer planMode
    // is not retained by a native transcript. Ordinary sends and model tools cannot issue this main marker.
    plan = [...items]
      .reverse()
      .find((i) => i?.type === 'agentMessage' && !i.questions?.length && typeof i.text === 'string' && i.text.trim());
  }
  if (!plan || plan.approvedInTurn || plan.id !== intent.itemId || plan.text !== intent.text) fail();
  const prepared = {
    ...clean,
    planApproval: { native: ref.key, itemId: plan.id, ...(archiveEpoch === undefined ? {} : { archiveEpoch }) },
  };
  claims.set(prepared, current);
  return prepared;
}

/**
 * Resolves once the chat's turn is no longer running here, the window stops showing it, or the wait runs out; what
 * then still says the turn runs refuses the plan as before (verifyPlanInput's `current`). A turn waiting on the user
 * is not over: that is no wait.
 */
async function turnEnded(live, chatId, trusted) {
  const until = clock.now() + (live.turnEndWaitMs ?? TURN_END_WAIT_MS);
  while (trusted() && live.controller.state.get(chatId).turn === 'running' && clock.now() < until) await sleep(TURN_END_POLL_MS);
}

/** Consume directly before controller.send: another read may have completed before the caller resumed its await. */
function takePlanInput(item) {
  const current = claims.get(item);
  claims.delete(item);
  if (current && !current()) fail();
  return item;
}

const archiveEpochOf = (orch, id) => orch.o.chats.archiveEpoch?.(id);
const eligible = (orch, id, native) =>
  orch.o.chats.records.has(id) &&
  !orch.o.chats.isDeleted(id) &&
  isUserTurn(orch.o.controller.state.get(id).activeTurn) &&
  orch.o.controller.ref(id).key === native &&
  !orch.archived(id) &&
  !orch.stopping.has(id) &&
  !orch.archiving.has(id);

function approve(orch, chatId, native) {
  orch.journal.change((d) => {
    const parent = (d.parents[chatId] ??= emptyParent());
    parent.planApprovedFor = { token: orch.turnOf(chatId), native, archiveEpoch: archiveEpochOf(orch, chatId) };
  });
}

/** Called after dispatch bookkeeping has established this input's current turn token. */
function beforePlanDispatch(orch, { chatId, kind, item, ref }) {
  const human = item?.opts?.human === true && !item.peer && !item.opts.prefix;
  const proof = item?.planApproval;
  const valid =
    human &&
    kind === 'turn' &&
    withoutRosterBlock(item.text) === IMPLEMENT_PLAN &&
    item.opts.plan === false &&
    typeof proof?.itemId === 'string' &&
    proof.itemId.length > 0 &&
    proof.archiveEpoch === archiveEpochOf(orch, chatId) &&
    eligible(orch, chatId, proof.native);
  const parent = orch.journal.parent(chatId);
  if (
    parent?.planApprovedFor &&
    (!human ||
      kind === 'turn' ||
      parent.planApprovedFor.archiveEpoch !== archiveEpochOf(orch, chatId) ||
      !eligible(orch, chatId, parent.planApprovedFor.native))
  )
    orch.journal.change((d) => {
      delete d.parents[chatId].planApprovedFor;
    });
  if (kind === 'turn' || !human) {
    for (const [id, owner] of requestsOf(orch)) if (owner.chatId === chatId) requestsOf(orch).delete(id);
  }
  if (valid) approve(orch, chatId, proof.native);
}

/** A request cannot grant the next turn its predecessor's permission. */
function planTurnFinished(orch, event) {
  for (const [id, owner] of requestsOf(orch)) if (owner.chatId === event.chatId) requestsOf(orch).delete(id);
}

/** Native acceptance is consumed against the original pending request before its SDK continuation resumes. */
function nativePlanEvent(orch, family, event) {
  if (!MAIN_TRAITS[family]?.nativePlanApproval || !event?.key) return;
  const requests = requestsOf(orch);
  if (event.kind === 'permissionCancelled') {
    requests.delete(event.requestId);
    return;
  }
  if (event.kind === 'permission' && event.toolName === 'ExitPlanMode' && !event.agentID) {
    const chatId = orch.o.controller.chatOf(event.key);
    if (eligible(orch, chatId, event.key))
      requests.set(event.requestId, { chatId, token: orch.turnOf(chatId), native: event.key, archiveEpoch: archiveEpochOf(orch, chatId) });
    return;
  }
  if (event.kind !== 'planAccepted') return;
  const owner = requests.get(event.requestId);
  requests.delete(event.requestId);
  if (
    owner &&
    owner.native === event.key &&
    owner.archiveEpoch === archiveEpochOf(orch, owner.chatId) &&
    owner.token === orch.turnOf(owner.chatId) &&
    eligible(orch, owner.chatId, owner.native)
  )
    approve(orch, owner.chatId, owner.native);
}

/** Normal turns get three; only a still-current accepted human plan gets the reference's fourth card. */
function suggestionLimit(orch, chatId) {
  const proof = orch.journal.parent(chatId)?.planApprovedFor;
  return proof &&
    proof.token === orch.turnOf(chatId) &&
    proof.archiveEpoch === archiveEpochOf(orch, chatId) &&
    eligible(orch, chatId, proof.native)
    ? 4
    : 3;
}

module.exports = {
  preparePlanInput,
  takePlanInput,
  beforePlanDispatch,
  planTurnFinished,
  nativePlanEvent,
  suggestionLimit,
  IMPLEMENT_PLAN,
};

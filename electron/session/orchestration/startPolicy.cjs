// Authority and per-human-message start budgets: human turns run in parallel; genuine continuations always ask.
const { isUserTurn } = require('../userTurn.cjs');
const { emptyParent } = require('./journal.cjs');
const { stateWord } = require('./family.cjs');

const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

/** Capture at tool invocation, before it can wait behind another operation or an approval. */
const startRequest = (orch, id) => ({
  token: orch.turnOf(id),
  record: orch.o.chats.records.get(id),
  native: orch.o.controller.ref(id).key,
  archiveEpoch: orch.o.chats.archiveEpoch?.(id),
});

/** A main-authored wake retains the preceding human turn's task, never another session's own authority. */
function startAuthority(orch, parentId) {
  if (isUserTurn(orch.o.controller.state.get(parentId).activeTurn)) return 'human';
  const wake = orch.waking.get(parentId);
  if (
    wake &&
    orch.journal.parent(parentId)?.continuable &&
    (!orch.journal.child(parentId) || orch.journal.child(parentId).detached) &&
    orch.turnOf(parentId) === `pending-${wake}` &&
    !orch.revokedWakes.has(parentId)
  )
    return 'wake';
  return null;
}

/** Check immediately before creation, and again after the asynchronous approval boundary.
 * @param {any} orch @param {string} parentId
 * @param {{signal?: AbortSignal | null, clicked?: boolean, request?: any, reserved?: boolean}} [options]
 */
async function authorizeStart(
  orch,
  parentId,
  { signal = null, clicked = false, request = startRequest(orch, parentId), reserved = false } = {},
) {
  const { record, token, native, archiveEpoch } = request;
  if (orch.archived(parentId)) fail('parent_archived', 'This chat is archived');
  const authority = clicked ? 'click' : startAuthority(orch, parentId);
  const current = () =>
    !signal?.aborted &&
    record &&
    !!orch.o.chats.records.get(parentId) &&
    orch.o.chats.records.get(parentId).id === record.id &&
    orch.o.chats.records.get(parentId).segments === record.segments &&
    orch.o.controller.ref(parentId).key === native &&
    !orch.archived(parentId) &&
    !orch.o.chats.isDeleted?.(parentId) &&
    !orch.deleted.has(parentId) &&
    orch.o.chats.archiveEpoch?.(parentId) === archiveEpoch &&
    !orch.stopping.has(parentId) &&
    !orch.archiving?.has(parentId) &&
    (clicked || (orch.turnOf(parentId) === token && startAuthority(orch, parentId) === authority));
  if (!authority)
    fail(
      'not_user_turn',
      'Start sessions only on the user’s own words here. Propose with initiation "own_initiative", or start it once the user asks.',
    );
  if (!current()) fail('start_cancelled', 'This start was cancelled or its session changed; nothing started.');
  if (reserved) {
    if (authority !== 'human') fail('not_user_turn', 'The accepted session needs its brief on the user’s own turn.');
    return { continued: false, current };
  }
  const p = orch.journal.parent(parentId);
  const count = p?.starts ?? 0;
  if (authority === 'wake') {
    if ((p?.continuedStarts ?? 0) >= 10)
      fail(
        'continued_start_limit',
        'The app has already started 10 sessions on its own since your last message. Propose what remains for the user.',
      );
    const working = orch.journal
      .childrenOf(parentId)
      .filter(
        (id) => orch.journal.child(id).continued && ['working', 'needs the user'].includes(stateWord(orch.o.controller, orch.journal, id)),
      ).length;
    if (working >= 5)
      fail(
        'continued_parallel_limit',
        'Five sessions the app started on its own are still working. Start this one after they report, or once the user asks.',
      );
  }
  if (!clicked && (authority === 'wake' || count >= 10)) {
    const allowed = await orch.o.approveStart?.(parentId, { count, continued: authority === 'wake', signal });
    if (!current()) fail('start_cancelled', 'This start was cancelled or its session changed; nothing started.');
    if (!allowed) fail('start_declined', 'The user did not approve starting another session; nothing started.');
  }
  orch.journal.change((d) => {
    const parent = (d.parents[parentId] ??= emptyParent());
    parent.starts = (parent.starts ?? 0) + 1;
    parent.continuable = authority === 'human' || authority === 'wake';
    if (authority === 'wake') parent.continuedStarts = (parent.continuedStarts ?? 0) + 1;
  });
  return { continued: authority === 'wake', current };
}

module.exports = { startAuthority, authorizeStart, startRequest };

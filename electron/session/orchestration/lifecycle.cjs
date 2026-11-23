// Persisted lineage detach and serialized parent-family archiving, shared by every harness and window.
const { goalHolds } = require('../goalStatus.cjs');
const { isDescendant } = require('./family.cjs');
const { quietWorktree } = require('./archiveFacts.cjs');
const { cleanupSharedNotes } = require('./childSetup.cjs');
const fail = (code, message) => {
  throw Object.assign(new Error(message), { code });
};

function detach(orch, chatId) {
  if (!orch.journal.child(chatId)) fail('not_linked', 'This session has no parent');
  orch.journal.change((d) => {
    d.children[chatId].detached = true;
    // its notes may wait in an ancestor's record too, while its parent was archived (reportRoute.cjs)
    for (const parent of Object.values(d.parents)) parent.notes = parent.notes.filter((n) => n.childId !== chatId);
  });
  return { detached: true };
}

/** A quiet child can disappear with its parent; attention and unfinished work require a choice. */
function attention(orch, id) {
  const s = orch.o.controller.state.get(id);
  const meta = orch.o.chats.records.get(id)?.meta;
  const c = orch.journal.child(id);
  return (
    s.turn === 'running' ||
    s.turn === 'awaitingUser' ||
    s.queue.length > 0 ||
    s.approvals.length > 0 ||
    !!s.pendingSwitch ||
    // main's record of the goal, not a window's report of it (#2759)
    goalHolds(orch.o.controller.state.goalStatus(id)) ||
    !!meta?.pinned ||
    !!meta?.unread ||
    c?.facts?.uncommitted > 0 ||
    ['OPEN', 'DRAFT'].includes(c?.facts?.pr?.state) ||
    !!orch.journal.data.dependants[id]
  );
}

const epoch = (orch, id) => orch.o.chats.archiveEpoch?.(id) ?? orch.o.chats.records.get(id)?.meta?.activeAt ?? null;
const queuedInput = (orch, id) => JSON.stringify(orch.o.controller.state.get(id).queue.map((item) => item.id));
const identity = (orch, id) => ({
  native: orch.o.controller.ref(id).key,
  token: orch.turnOf(id),
  epoch: epoch(orch, id),
  queued: queuedInput(orch, id),
});
/** Metadata updates are not a replacement chat. A turn the operation itself stopped may become idle. */
const sameIdentity = (orch, id, owner, stopped = false) =>
  orch.o.chats.records.has(id) &&
  !orch.o.chats.isDeleted?.(id) &&
  epoch(orch, id) === owner.epoch &&
  queuedInput(orch, id) === owner.queued &&
  !orch.archived(id) &&
  orch.o.controller.ref(id).key === owner.native &&
  (orch.turnOf(id) === owner.token || (stopped && orch.o.controller.state.get(id).turn === 'idle'));

async function applyArchive(orch, parentId, mode, expected, owner) {
  const descendants = Object.keys(orch.journal.data.children).filter(
    (id) => orch.o.chats.records.has(id) && !orch.o.chats.isDeleted?.(id) && isDescendant(orch.journal, id, parentId) && !orch.archived(id),
  );
  const roots = new Set([parentId, orch.journal.child(parentId)?.notesRoot, ...descendants.map((id) => orch.journal.child(id).notesRoot)]);
  if (orch.archived(parentId)) {
    for (const root of roots) await cleanupSharedNotes(orch, root);
    return { archived: [], remaining: descendants, needsChoice: false, working: 0, already: true };
  }
  const current = (stopped = false) => sameIdentity(orch, parentId, owner, stopped);
  const check = (stopped = false) => {
    if (!current(stopped))
      fail('archive_cancelled', 'This session changed while its nested sessions were checked. Remaining sessions were kept.');
  };
  check();
  const owners = new Map(descendants.map((id) => [id, identity(orch, id)]));
  const quiet =
    mode === 'quiet' ? new Set(await Promise.all(descendants.map(async (id) => ((await quietWorktree(orch, id)) ? id : null)))) : new Set();
  check();
  const retained = descendants.filter((id) => attention(orch, id) || !quiet.has(id));
  const working = descendants.filter((id) => ['running', 'awaitingUser'].includes(orch.o.controller.state.get(id).turn));
  if (mode === 'quiet' && retained.length) return { archived: [], remaining: descendants, needsChoice: true, working: working.length };
  const selected =
    mode === 'all'
      ? descendants.filter((id) => !expected || expected.has(id))
      : mode === 'parent'
        ? []
        : descendants.filter((id) => !retained.includes(id));
  const archived = [];
  for (const id of [...selected, parentId]) {
    check();
    if (orch.archived(id)) continue;
    if (id !== parentId && (!isDescendant(orch.journal, id, parentId) || !sameIdentity(orch, id, owners.get(id)))) continue;
    if (id !== parentId && mode !== 'all' && attention(orch, id)) continue;
    const state = orch.o.controller.state.get(id);
    const stopped = state.turn === 'running' || state.turn === 'awaitingUser';
    if (stopped) {
      const accepted = await orch.o.controller.stopChat(id);
      if (!accepted && ['running', 'awaitingUser'].includes(orch.o.controller.state.get(id).turn))
        fail('stop_failed', 'This session could not be stopped. It was kept; try archiving it again.');
    }
    check(id === parentId && stopped);
    if (!orch.o.chats.records.has(id)) continue;
    if (id !== parentId && (!isDescendant(orch.journal, id, parentId) || !sameIdentity(orch, id, owners.get(id), stopped))) continue;
    if (orch.o.archive(id) !== true) fail('archive_failed', 'This session could not be archived; try again.');
    archived.push(id);
  }
  const remaining = Object.keys(orch.journal.data.children).filter(
    (id) => orch.o.chats.records.has(id) && !orch.o.chats.isDeleted?.(id) && isDescendant(orch.journal, id, parentId) && !orch.archived(id),
  );
  for (const id of remaining) {
    const parent = orch.journal.child(id).parentId;
    if (parent === parentId || orch.archived(parent)) detach(orch, id);
  }
  orch.pump();
  for (const root of roots) await cleanupSharedNotes(orch, root);
  return { archived, remaining, needsChoice: false, working: 0 };
}

/** A pending duplicate coalesces; distinct user choices serialize, preserving each invocation's identity claim. */
/** @param {any} orch @param {string} parentId @param {string} [mode] @param {string[]} [expectedIds] */
async function archiveFamily(orch, parentId, mode = 'quiet', expectedIds) {
  if (!['quiet', 'all', 'parent'].includes(mode)) fail('invalid_action', 'Archive mode is quiet, all or parent');
  if (expectedIds !== undefined && (!Array.isArray(expectedIds) || !expectedIds.every((id) => typeof id === 'string' && id.length > 0)))
    fail('invalid_archive_scope', 'The family selection must list the sessions shown in the archive dialog.');
  if (!orch.o.chats.records.has(parentId) || orch.o.chats.isDeleted?.(parentId)) fail('not_found', 'This session is no longer available');
  const owner = identity(orch, parentId);
  const selectedIds = expectedIds === undefined ? null : [...new Set(expectedIds)].sort();
  const expected = selectedIds === null ? null : new Set(selectedIds);
  const key = JSON.stringify([parentId, mode, selectedIds, owner]);
  const pending = (orch.archivePending ??= new Map());
  const tails = (orch.archiveTails ??= new Map());
  const previous = pending.get(key);
  if (previous) return previous;
  const before = tails.get(parentId) ?? Promise.resolve();
  (orch.archiving ??= new Set()).add(parentId);
  const run = () => applyArchive(orch, parentId, mode, expected, owner);
  const operation = before.then(run, run).finally(() => {
    pending.delete(key);
    if (tails.get(parentId) === operation) {
      tails.delete(parentId);
      orch.archiving.delete(parentId);
      orch.o.defer(() => orch.maybeWake(parentId));
    }
  });
  tails.set(parentId, operation);
  pending.set(key, operation);
  return operation;
}

module.exports = { detach, attention, archiveFamily };

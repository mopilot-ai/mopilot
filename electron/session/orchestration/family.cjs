// A chat's family of linked chats (the chat it was started by, the ones it started, and theirs): who belongs, what
// each is doing in a word, and how a `to` (an id, a name or "parent") names one of them.
const { rosterLine } = require('../../../shared/sideSessions.mjs');

/** How far links are followed: deeper chains are cut, so a damaged record can't loop. */
const MAX_DEPTH = 32;
/** How many removed messages list_sessions reports, and how much of each one's body. */
const REMOVED_LISTED = 5;
const REMOVED_BODY_CHARS = 120;

/** Historical provenance survives detach; only attached lineage grants family authority. */
const attachedParent = (journal, id) => {
  const c = journal.child(id);
  return c?.detached ? null : (c?.parentId ?? null);
};

/** Whether the chat is a session another chat started and still reports to: `isLinkedChild` for the Notifier (platform/notify.cjs), read from `live`'s orchestrator when asked. */
const linkedChildOf = (live) => (id) => {
  const journal = live.orchestrator?.journal;
  return !!journal && !!attachedParent(journal, id);
};

/** The chat at the top of `id`'s family: the one no link leads above. */
function rootOf(journal, id) {
  let current = id;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const parent = attachedParent(journal, current);
    if (!parent || parent === id) break;
    current = parent;
  }
  return current;
}

/** Every chat in `id`'s family, the top first, then each chat's children in the order they were started. */
function familyOf(journal, id) {
  const root = rootOf(journal, id);
  const out = [root];
  const seen = new Set(out);
  const walk = (parent, depth) => {
    if (depth >= MAX_DEPTH) return;
    for (const child of journal.childrenOf(parent)) {
      if (seen.has(child)) continue;
      seen.add(child);
      out.push(child);
      walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

/** Whether `id` was started, directly or further down, by `ancestor`. */
function isDescendant(journal, id, ancestor) {
  let current = id;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const parent = attachedParent(journal, current);
    if (!parent) return false;
    if (parent === ancestor) return true;
    current = parent;
  }
  return false;
}

/**
 * Who hears from `id` now, as in Claude Desktop: its attached parent, or, while that one is archived, the nearest
 * attached ancestor that is not (viaArchived). Its archived parent when none above it is live; null for a top chat.
 * @param {any} journal
 * @param {string} id
 * @param {(chatId: string) => boolean} archived
 * @returns {{ parentId: string, viaArchived: boolean } | null}
 */
function liveParentOf(journal, id, archived) {
  const parentId = attachedParent(journal, id);
  if (!parentId) return null;
  let current = parentId;
  for (let i = 0; i < MAX_DEPTH && archived(current); i++) {
    const above = attachedParent(journal, current);
    if (!above || above === id) return { parentId, viaArchived: false };
    current = above;
  }
  return archived(current) ? { parentId, viaArchived: false } : { parentId: current, viaArchived: current !== parentId };
}

/**
 * The chat a note meant for `id` reaches: `id` itself, or while it is archived, the nearest live attached ancestor
 * above it (`id` when none is), so notes about its sessions are read (liveParentOf).
 * @param {any} journal @param {string} id @param {(chatId: string) => boolean} archived
 */
function liveSelfOrAbove(journal, id, archived) {
  if (!archived(id)) return id;
  const up = liveParentOf(journal, id, archived);
  return up && !archived(up.parentId) ? up.parentId : id;
}

/** The name a family member goes by: a child's handle, "top" for the chat that started the family. */
function nameOf(journal, id) {
  return journal.child(id)?.name ?? 'top';
}

/** A session's handle, or its id once it is gone (nameOf names a chat with no link the top). */
function labelOf(journal, id) {
  return journal.child(id)?.name ?? id;
}

/**
 * What a chat is doing, in the word its family sees: waiting on the user for an approval or a question, working
 * (a turn running or messages waiting to run), queued (waiting for its recipient, scheduler.cjs), waiting or held (for
 * the sessions it starts after, dependants.cjs), failed (its harness quit, or its last turn failed), or idle.
 */
function stateWord(controller, journal, id) {
  const s = controller.state.get(id);
  if (s.turn === 'awaitingUser') return 'needs the user';
  if (s.turn === 'running' || s.queue.length > 0) return 'working';
  if (journal.data.queue.some((e) => e.chatId === id)) return 'queued';
  // made, with its brief waiting for the sessions it named in `after` (dependants.cjs); held when one of them failed
  const waits = journal.data.dependants?.[id];
  if (waits) return waits.held ? 'held' : 'waiting';
  if (s.turn === 'crashed') return 'failed';
  const how = journal.child(id)?.lastReport?.how;
  return how === 'failed' || how === 'lost' ? 'failed' : 'idle';
}

/**
 * The chat `to` names in `source`'s family: "parent", a member's id, or a member's name. Null when it names none.
 * @param {any} journal
 * @param {string} source
 * @param {unknown} to
 * @param {(chatId: string) => boolean} [archived] "parent" names the one `source` reports to (liveParentOf)
 */
function resolveMember(journal, source, to, archived = (_chatId) => false) {
  const wanted = String(to ?? '').trim();
  if (!wanted) return null;
  if (wanted.toLowerCase() === 'parent') return liveParentOf(journal, source, archived)?.parentId ?? null;
  const family = familyOf(journal, source);
  if (family.includes(wanted)) return wanted;
  const lower = wanted.toLowerCase();
  return family.find((id) => id !== source && nameOf(journal, id) === lower) ?? null;
}

/**
 * The "linked sessions now" line `id` is told: every other member by name, id and state, with who started a
 * member that neither `id` nor the top started. Empty for a chat in no family.
 * @param {any} controller
 * @param {any} journal
 * @param {string} id
 * @param {(chatId: string) => boolean} [archived] members left out (archived chats)
 */
function rosterFor(controller, journal, id, archived = (_chatId) => false, notesDirectory = undefined) {
  const family = familyOf(journal, id);
  const root = family[0];
  const parentOfSelf = liveParentOf(journal, id, archived)?.parentId;
  const members = family
    .filter((m) => m !== id && !archived(m))
    .map((m) => {
      const by = journal.child(m)?.parentId ?? null;
      return {
        name: m === parentOfSelf ? `parent (${nameOf(journal, m)})` : nameOf(journal, m),
        chatId: m,
        state: stateWord(controller, journal, m),
        by: by && by !== id && by !== root ? nameOf(journal, by) : null,
      };
    });
  const line = rosterLine(members);
  const notes = notesPathFor(journal, root, notesDirectory);
  return line && notes ? `${line} Shared session notes: ${notes}.` : line;
}

/** The notes directory has its own identity; arbitrary authorized directory ordering cannot name it. */
function notesPathFor(journal, id, notesDirectory) {
  const child = journal.child(id);
  const root = child?.notesRoot ?? rootOf(journal, id);
  const stored = child?.notesPath ?? Object.values(journal.data.children).find((c) => c.notesRoot === root && c.notesPath)?.notesPath;
  return stored ?? notesDirectory?.(root) ?? null;
}

/**
 * list_sessions: the other chats of `source`'s family, with names, ids, what each is doing, what a waiting one waits
 * for, and each one's latest report.
 * @param {{ o: any, journal: any, archived: (chatId: string) => boolean }} orch the Orchestrator
 * @param {string} source
 */
function familyList(orch, source) {
  const { journal, o } = orch;
  const parentId = liveParentOf(journal, source, orch.archived)?.parentId ?? null;
  const label = (id) => labelOf(journal, id);
  const sessions = familyOf(journal, source)
    .filter((id) => id !== source)
    .map((id) => {
      const c = journal.child(id);
      const waits = journal.data.dependants[id];
      return {
        name: nameOf(journal, id),
        id,
        relation: id === parentId ? 'parent' : c?.parentId === source ? 'child' : 'linked',
        title: c?.title ?? o.title(id) ?? null,
        state: orch.archived(id) ? 'archived' : stateWord(o.controller, journal, id),
        harness: c?.harness ?? null,
        folder: c?.cwd ?? null,
        ...(c?.useWorktree ? { branch: o.worktreeInfo(c.cwd)?.branch ?? null } : {}),
        ...(waits ? { waits_for: waits.after.map(label), ...(waits.held ? { held_by: label(waits.held.by) } : {}) } : {}),
        latest_report: c?.lastReport ? { how: c.lastReport.how, text: c.lastReport.report } : null,
      };
    });
  // messages `source` sent that the user took out of the recipient's queue before they ran, the latest first
  const removed = Object.entries(journal.data.deliveries)
    .filter(([, d]) => d.kind === 'message' && d.from === source && d.removedAt)
    .sort(([, a], [, b]) => b.removedAt - a.removedAt)
    .slice(0, REMOVED_LISTED)
    .map(([id, d]) => ({
      message_id: id,
      to: label(d.chatId),
      reason: d.removedReason ?? 'user',
      body: d.body.slice(0, REMOVED_BODY_CHARS),
    }));
  return {
    sessions,
    waiting_notes: journal.parent(source)?.notes.length ?? 0,
    ...(removed.length ? { removed_messages: removed } : {}),
  };
}

module.exports = {
  linkedChildOf,
  rootOf,
  familyOf,
  liveParentOf,
  liveSelfOrAbove,
  isDescendant,
  nameOf,
  labelOf,
  stateWord,
  resolveMember,
  rosterFor,
  notesPathFor,
  familyList,
  MAX_DEPTH,
};

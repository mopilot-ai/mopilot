// Forgetting deleted chats: one journal write drops a deleted chat's link, notes, proposals, task list, wrap-up box,
// waiting items, its brief waiting for other sessions and the items shown in it. Its own linked sessions report to the
// session above it from then on (Claude Desktop's relink), or, with none above it, stay as top-level chats and still get
// what it had queued for them; its parent, and those of them that have sessions of their own, are told in a note that
// wakes no one.
const { addNote } = require('./journal.cjs');
const { MAX_DEPTH } = require('./family.cjs');
const { noteIgnored } = require('../../ignored.cjs');

/** A message that never ran stays for its sender, who sees it in list_sessions (userRemoval.cjs). */
const kept = (x) => x.kind === 'message' && !!x.removedAt;

/**
 * Whether the journal still holds anything of the chats in `ids`. A proposal still starting is left to settle first
 * (its start writes to it), so it does not count until then.
 * @param {any} data the journal's data
 * @param {Set<string>} ids
 */
function holds(data, ids) {
  for (const id of ids) if (data.children[id] || data.parents[id] || data.plans[id] || data.wrapUps[id] || data.dependants[id]) return true;
  return (
    Object.values(data.children).some((c) => ids.has(c.parentId)) ||
    Object.values(data.proposals).some((p) => (ids.has(p.parentId) && p.status !== 'starting') || ids.has(p.chatId)) ||
    data.queue.some((e) => ids.has(e.chatId)) ||
    Object.values(data.deliveries).some((x) => ids.has(x.chatId) && !kept(x))
  );
}

/**
 * The nearest attached ancestor of the deleted chat `id` that is not deleted itself, or null when none is above it.
 * @param {any} d a journal draft @param {Set<string>} ids deleted chats @param {string} id
 */
function survivorAbove(d, ids, id) {
  let current = id;
  for (let i = 0; i < MAX_DEPTH; i++) {
    const link = d.children[current];
    if (!link || link.detached) return null;
    current = link.parentId;
    if (!ids.has(current)) return current;
  }
  return null;
}

/**
 * Remove the chats in `ids` from the draft `d`. Returns the surviving parents told that a child of theirs was
 * deleted (a child that was working may have been all that kept one from waking), the queued items for chats
 * that are top-level now, which no longer wait for a linked session's slot, and the chats relinked above.
 * @param {any} d a journal draft
 * @param {Set<string>} ids deleted chats
 * @param {number} at
 * @returns {{ told: string[], release: any[], relinked: string[] }}
 */
function forget(d, ids, at) {
  const told = new Set();
  for (const id of ids) {
    const child = d.children[id];
    if (!child || ids.has(child.parentId)) continue;
    const n = d.queue.filter((e) => e.chatId === id).length;
    const dropped = n ? ` ${n} waiting message${n === 1 ? ' for it was' : 's for it were'} not sent.` : '';
    addNote(d, child.parentId, { childId: id, body: `The session ${child.name} (${id}) was deleted.${dropped}`, at, wakes: false });
    told.add(child.parentId);
  }
  const orphans = Object.entries(d.children).filter(([id, c]) => !ids.has(id) && ids.has(c.parentId));
  // as in Claude Desktop, a deleted session's sessions report to the one above it (the nearest not deleted)
  /** @type {Map<string, string[]>} */
  const relinked = new Map();
  for (const [orphan, c] of orphans) {
    const above = survivorAbove(d, ids, c.parentId);
    if (!above) continue;
    relinked.set(above, [...(relinked.get(above) ?? []), orphan]);
    // what it reported that the deleted chat had not read yet goes up with it
    for (const note of d.parents[c.parentId]?.notes.filter((n) => n.childId === orphan) ?? []) addNote(d, above, note);
    c.deletedParent = { id: c.parentId, title: d.children[c.parentId].title }; // survivorAbove passed through its link
    c.parentId = above;
    if (d.dependants[orphan]) d.dependants[orphan].parentId = above;
  }
  for (const [above, moved] of relinked) {
    const names = moved.map((id) => `${d.children[id].name} (${id})`).join(', ');
    const body = `Sessions started by a session of yours since deleted now report to you: ${names}.`;
    addNote(d, above, { childId: moved[0], body, at, wakes: false });
    told.add(above);
  }
  // with no session above the deleted one, they are top-level now
  const stranded = orphans.filter(([, c]) => ids.has(c.parentId));
  for (const [orphan, c] of stranded) {
    delete d.children[orphan];
    // notes reach a chat only with a wake-up, which only a chat with sessions of its own gets
    if (d.parents[orphan] || Object.values(d.children).some((x) => x.parentId === orphan))
      addNote(d, orphan, {
        childId: c.parentId,
        body: `The chat that started this one (${c.parentId}) was deleted; this chat is top-level now.`,
        at,
        wakes: false,
      });
  }
  const top = new Set(stranded.map(([id]) => id));
  const release = d.queue.filter((e) => top.has(e.chatId));
  d.queue = d.queue.filter((e) => !ids.has(e.chatId) && !top.has(e.chatId));
  for (const id of ids) {
    delete d.children[id];
    delete d.parents[id];
    delete d.plans[id];
    delete d.wrapUps[id];
    // a deleted session's waiting brief goes with it; the sessions waiting for a deleted one are held (dependants.cjs)
    delete d.dependants[id];
  }
  for (const [pid, p] of Object.entries(d.proposals)) {
    if (ids.has(p.parentId) && p.status !== 'starting') delete d.proposals[pid];
    // a card that started a deleted chat no longer opens it
    else if (ids.has(p.chatId)) p.chatId = null;
  }
  for (const [xid, x] of Object.entries(d.deliveries)) if (ids.has(x.chatId) && !kept(x)) delete d.deliveries[xid];
  return { told: [...told], release, relinked: [...relinked.values()].flat() };
}

/**
 * Forget every chat deleted this run that the journal still holds, in one write; a failed write changes nothing and
 * is tried again on the next deletion or turn end (the orchestrator's pump). Then what waited for a chat that is
 * top-level now goes to it, what waited for a relinked one drains from the queue, and the parents told of a deleted
 * child (or of the sessions now reporting to them) are checked for a wake-up.
 * @param {any} orch the Orchestrator
 */
function forgetDeleted(orch) {
  const { journal, deleted, o } = orch;
  if (orch.unavailable || !deleted.size || !holds(journal.data, deleted)) return;
  /** @type {{ told: string[], release: any[], relinked: string[] }} */
  let out = { told: [], release: [], relinked: [] };
  if (!orch.safely('forget deleted chats', () => journal.change((d) => (out = forget(d, deleted, o.now()))))) return;
  for (const e of out.release)
    o.send(e.chatId, { id: e.item.id, sideSession: { id: e.item.id }, text: e.item.text, attachments: [], opts: { human: false } }).catch(
      (error) => noteIgnored('send a queued message to a chat whose parent was deleted', error),
    );
  // what the deleted chat queued for a relinked one still goes to it, through the queue
  if (out.relinked.length) o.defer(() => orch.pump());
  for (const parentId of out.told) o.defer(() => orch.maybeWake(parentId));
}

module.exports = { holds, forget, forgetDeleted };

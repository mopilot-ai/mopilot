// Sessions that wait for others (start_session `after`): a linked session made now whose brief waits in the journal
// until every session it names has finished a turn cleanly, then joins the scheduler's queue with their reports and
// branches; one whose predecessor failed, was stopped, was lost or is gone is held, and its parent is told which.
// The journal keeps them across a restart, and every turn end, archive, deletion and startup settles them again.
const { addNote } = require('./journal.cjs');
const { nameOf, stateWord, resolveMember, rosterFor, notesPathFor, liveSelfOrAbove, MAX_DEPTH } = require('./family.cjs');
const { pump } = require('./scheduler.cjs');
const { briefText, predecessorsText } = require('../../../shared/sideSessions.mjs');
const { noteIgnored } = require('../../ignored.cjs');

/** How many sessions one may wait for. */
const MAX_AFTER = 10;
/** What the child's brief keeps of the task for windows to show (spawn.cjs uses it too). */
const SHOWN_CHARS = 4000;
/** How a held session's predecessor ended, in its parent's note. */
const HELD_HOW = {
  failed: 'ended its turn with an error',
  stopped: 'was stopped before its turn finished',
  lost: 'did not finish its turn (its harness quit)',
  gone: 'is archived or deleted',
  cycle: 'waits, through others, for a session that waits for it',
};

/**
 * @param {string} code
 * @param {string} [message]
 * @returns {never}
 */
function fail(code, message = code) {
  throw Object.assign(new Error(message), { code });
}

/**
 * The sessions `after` names (ids or names), as chat ids, each a session `parentId` started itself, once each.
 * Checked before anything is made: one that names no such session is refused.
 * @param {any} journal
 * @param {string} parentId
 * @param {string[]} after start arguments' `after` (spawn.cjs startArgs)
 */
function predecessorsOf(journal, parentId, after) {
  const ids = after.map((wanted) => {
    const id = resolveMember(journal, parentId, wanted);
    if (!id || journal.child(id)?.parentId !== parentId)
      fail('unknown_session', `"${wanted}" isn't a session this chat started: name one from list_sessions {"linked": true}`);
    return id;
  });
  return [...new Set(ids)];
}

/**
 * Where predecessor `id` stands for a session waiting on it: done (its last turn finished and nothing of it runs,
 * waits or is held), blocked (by which session, and how), or pending. One that waits itself stands as what it waits
 * for does; `path` cuts a loop a damaged journal could hold.
 * @param {any} orch
 * @param {string} id
 * @param {string[]} [path] the waiting sessions followed to reach it
 * @returns {{ done: true } | { pending: true } | { blocked: string, how: keyof typeof HELD_HOW }}
 */
function standing(orch, id, path = []) {
  const { journal, o } = orch;
  const c = journal.child(id);
  if (!c || o.chats.isDeleted(id) || orch.archived(id)) return { blocked: id, how: 'gone' };
  const word = stateWord(o.controller, journal, id);
  if (word === 'working' || word === 'queued' || word === 'needs the user') return { pending: true };
  const dep = journal.data.dependants[id];
  if (dep) {
    if (path.includes(id) || path.length >= MAX_DEPTH) return { blocked: id, how: 'cycle' };
    for (const p of dep.after) {
      const s = standing(orch, p, [...path, id]);
      if ('blocked' in s) return s;
    }
    return { pending: true };
  }
  const how = c.lastReport?.how;
  if (how === 'finished') return { done: true };
  return how ? { blocked: id, how } : { pending: true };
}

/** Where a session waiting on `after` stands: done when each is, else the first that blocks it, else pending. */
function standingOf(orch, after, path = []) {
  const each = after.map((id) => standing(orch, id, path));
  return each.find((s) => 'blocked' in s) ?? each.find((s) => 'pending' in s) ?? { done: true };
}

/** What a session that waited is told of the ones it waited for (predecessorsText). */
function predecessorsFor(orch, after) {
  const { journal, o } = orch;
  return predecessorsText(
    after
      .filter((id) => journal.child(id))
      .map((id) => {
        const c = journal.child(id);
        return {
          name: c.name,
          chatId: id,
          title: c.title,
          branch: c.useWorktree ? (o.worktreeInfo(c.cwd)?.branch ?? null) : null,
          report: c.lastReport?.report ?? null,
        };
      }),
  );
}

/** The brief of a waiting session, as it goes once its predecessors are done. */
function briefOf(orch, chatId, dep) {
  const { journal, o } = orch;
  return briefText({
    title: dep.title,
    prompt: dep.brief.prompt,
    background: dep.brief.background,
    fork: journal.child(chatId)?.context === 'fork',
    notes: notesPathFor(journal, chatId, o.notesDirectory),
    parentName: o.title(dep.parentId) || nameOf(journal, dep.parentId),
    parentId: dep.parentId,
    excerpt: dep.brief.excerpt,
    excerptFrom: dep.brief.excerptFrom,
    after: predecessorsFor(orch, dep.after),
    roster: rosterFor(o.controller, journal, chatId, orch.archived, o.notesDirectory),
  });
}

/** The note a parent gets when the sessions waiting on `by` are held. */
function heldNote(journal, by, how, held) {
  const names = held.map((id) => `${nameOf(journal, id)} (${id})`).join(', ');
  if (how === 'cycle')
    return `These sessions wait for each other in a loop, so they are held and never start: ${names}. Archive them only after the user says yes, and start the work again without the loop. Mention it to the user in one line.`;
  // one deleted is known only by its id
  const who = journal.child(by) ? `${nameOf(journal, by)} (${by})` : by;
  const next = how === 'gone' ? 'Archive' : 'Retry it with send_message, or ask the user; archive';
  return `The session ${who} ${HELD_HOW[how]}, so the sessions waiting for it are held: ${names}. Each starts on its own once everything it waits for has finished a turn cleanly. ${next} a held session only after the user says yes. Mention it to the user in one line.`;
}

/**
 * Settle every waiting session: one whose predecessors are all done joins the queue with its brief (in the same
 * journal write that ends its wait, so a quit in between neither loses nor repeats it); one newly blocked is held, with
 * a note waking its parent per predecessor; one no longer blocked waits again. A waiting session that is archived waits
 * on; one whose parent was deleted (a top-level chat now) gets its brief at once. Idempotent: run after every turn end,
 * Stop, crash, archive, deletion and at startup.
 * @param {any} orch the Orchestrator
 */
function settleDependants(orch) {
  const { journal, o } = orch;
  if (orch.unavailable) return;
  const entries = Object.entries(journal.data.dependants);
  if (!entries.length) return;
  /** @type {{ id: string, briefId: string, text: string, linked: boolean }[]} */
  const release = [];
  /** @type {Map<string, { parentId: string, by: string, how: keyof typeof HELD_HOW, ids: string[], byId: Map<string, string> }>} */
  const hold = new Map();
  const clear = [];
  for (const [id, dep] of entries) {
    if (o.chats.isDeleted(id) || orch.archived(id)) continue;
    const linked = !!journal.child(id);
    const s = linked ? standingOf(orch, dep.after, [id]) : { done: true };
    if ('done' in s) release.push({ id, briefId: dep.briefId, text: briefOf(orch, id, dep), linked });
    else if ('blocked' in s) {
      if (dep.held?.by === s.blocked && dep.held?.how === s.how) continue;
      // one note per predecessor that holds them; a loop's sessions each hold themselves, so one note for the loop
      // told to the chat that hears from them now: their parent, or the live ancestor above an archived one
      const told = liveSelfOrAbove(journal, dep.parentId, orch.archived);
      const key = JSON.stringify([told, s.how === 'cycle' ? null : s.blocked, s.how]);
      if (!hold.has(key)) hold.set(key, { parentId: told, by: s.blocked, how: s.how, ids: [], byId: new Map() });
      hold.get(key)?.ids.push(id);
      hold.get(key)?.byId.set(id, s.blocked);
    } else if (dep.held) clear.push(id);
  }
  if (!release.length && !hold.size && !clear.length) return;
  const at = o.now();
  const committed = orch.safely('settle the sessions that wait for others', () =>
    journal.change((d) => {
      for (const r of release) {
        const dep = d.dependants[r.id];
        delete d.dependants[r.id];
        d.deliveries[dep.briefId] = {
          kind: 'brief',
          notesPath: notesPathFor(journal, r.id, o.notesDirectory),
          harness: o.controller.ref(dep.parentId).kind,
          chatId: r.id,
          from: dep.parentId,
          title: dep.title,
          body: dep.brief.prompt.slice(0, SHOWN_CHARS),
          task: dep.brief.prompt,
          context: dep.brief.background,
          fork: d.children[r.id]?.context === 'fork',
          at,
        };
        if (r.linked) d.queue.push({ id: dep.briefId, chatId: r.id, item: { id: dep.briefId, text: r.text }, at });
      }
      for (const h of hold.values()) {
        // each keeps what holds it itself, so the next settle finds it unchanged
        for (const id of h.ids) d.dependants[id].held = { by: /** @type {string} */ (h.byId.get(id)), how: h.how, at };
        addNote(d, h.parentId, { childId: h.by, body: heldNote(journal, h.by, h.how, h.ids), at, wakes: true });
      }
      for (const id of clear) d.dependants[id].held = null;
    }),
  );
  if (!committed) return;
  // a top-level chat now (its parent was deleted) waits for no linked session's slot
  for (const r of release.filter((x) => !x.linked))
    o.send(r.id, { id: r.briefId, sideSession: { id: r.briefId }, text: r.text, attachments: [], opts: { human: false } }).catch((error) =>
      noteIgnored('send the brief of a session whose parent was deleted', error),
    );
  if (release.some((r) => r.linked)) pump(orch);
  for (const h of hold.values()) o.defer(() => orch.maybeWake(h.parentId));
}

module.exports = { predecessorsOf, standing, standingOf, predecessorsFor, settleDependants, MAX_AFTER, HELD_HOW, SHOWN_CHARS };

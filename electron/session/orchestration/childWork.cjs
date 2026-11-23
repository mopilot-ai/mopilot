// A linked session's work as its parent sees it (bringBack.cjs reads and acts on git): the git facts added to the note
// its turn left, held in the journal for its card, and the user's card actions on it, "Merge into <branch>" and "Open
// PR". The parent's wake waits for the facts (Orchestrator.noting), so the note it reads has them.
const { clock } = require('../../platform/ports/clock.cjs');
const { addNote } = require('./journal.cjs');
const { nameOf } = require('./family.cjs');
const { branchFacts, currentBranch, factsText, mergeBranch, openPullRequest } = require('./bringBack.cjs');
const { ignoring, noteIgnored } = require('../../ignored.cjs');
const { acquireFolderMutation } = require('../folderMutation.cjs');

/** How long a wake waits for the facts before going without them. */
const FACTS_MS = 20_000;

/**
 * @param {string} code
 * @param {string} message
 * @returns {never}
 */
function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

/**
 * The session's worktree branch and both folders, or null when it shares its parent's folder (nothing to bring back).
 * The branch is git's own answer, never the worktree's marker file, which the session's agent can write: a name it
 * made up (one starting with "-") would reach git and gh as an option.
 */
async function sides(orch, childId) {
  const child = orch.journal.child(childId);
  if (!child?.useWorktree) return null;
  const branch = await currentBranch(orch.o.run, child.cwd);
  const parentCwd = await orch.o.projectOf(child.parentId);
  return branch && !branch.startsWith('-') && parentCwd ? { child, branch, childCwd: child.cwd, parentCwd } : null;
}

/**
 * Read a session's git facts after its turn's note (`at`), add them to that note while it still waits, and keep them
 * for its card. The parent's wake waits until this settles or FACTS_MS passes; a failed read only leaves them out.
 * @param {any} orch the Orchestrator
 */
function noteFacts(orch, childId, parentId, at) {
  orch.noting.set(parentId, (orch.noting.get(parentId) ?? 0) + 1);
  const run = orch.o.run;
  const read = sides(orch, childId).then((s) => (s ? branchFacts(run, s) : null));
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  const limit = new Promise((resolve) => (timer = clock.setTimeout(() => resolve(null), orch.o.factsMs ?? FACTS_MS)));
  return Promise.race([read, limit])
    .then((facts) => {
      // a session deleted meanwhile has no record to keep them on
      if (!facts || !orch.journal.child(childId)) return;
      orch.safely("keep a linked session's git facts", () =>
        orch.journal.change((d) => {
          d.children[childId].facts = { ...facts, at: orch.o.now() };
          const note = d.parents[parentId]?.notes.find((n) => n.childId === childId && n.at === at);
          if (note) note.body = `${note.body}\n${factsText(facts)}`;
        }),
      );
    })
    .catch((error) => noteIgnored("read a linked session's git facts", error))
    .finally(() => {
      clock.clearTimeout(timer);
      const left = orch.noting.get(parentId) - 1;
      if (left > 0) orch.noting.set(parentId, left);
      else orch.noting.delete(parentId);
      orch.o.defer(() => orch.maybeWake(parentId));
    });
}

/**
 * The user's action on a session from its card, through the app's own window: "merge" its branch into the folder its
 * parent works in (not while the parent's turn runs there), or "pr" to open a pull request for it. A merge leaves the
 * parent a note that does not wake it; the facts are read again after either.
 * @param {any} orch
 * @param {string} childId
 * @param {'merge' | 'pr'} action
 */
async function actOnChild(orch, childId, action) {
  if (action !== 'merge' && action !== 'pr') fail('invalid_action', 'action is merge or pr');
  const s = await sides(orch, childId);
  if (!s) fail('no_worktree', 'This session works in its parent’s folder: there is no branch to bring back.');
  const run = orch.o.run;
  if (action === 'pr') {
    const opened = await openPullRequest(run, s);
    void noteFacts(orch, childId, s.child.parentId, null);
    return opened;
  }
  const release = acquireFolderMutation(orch.o.controller, s.child.parentId, () =>
    orch.o.controller.drain?.(s.child.parentId)?.catch(ignoring('send input after folder merge')),
  );
  if (!release) fail('parent_busy', 'This chat is working in that folder: merge once its turn ends.');
  let merged;
  try {
    merged = await mergeBranch(run, s);
  } finally {
    release();
  }
  if (merged.status === 'merged')
    orch.safely('note a merged linked session', () =>
      orch.journal.change((d) => {
        d.children[childId].merged = { into: merged.into, commit: merged.commit, at: orch.o.now() };
        addNote(d, s.child.parentId, {
          childId,
          body: `The user merged ${nameOf(orch.journal, childId)}'s branch ${s.branch} into ${merged.into} (commit ${merged.commit}) in your folder.`,
          at: orch.o.now(),
          wakes: false,
        });
      }),
    );
  return merged;
}

module.exports = { noteFacts, actOnChild, FACTS_MS };

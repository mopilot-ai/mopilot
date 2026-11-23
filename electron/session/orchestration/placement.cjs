// Omitted linked-session placement shares a plain checkout and isolates sessions that use or have used a managed worktree.
function worktreeHistory(orch, parentId) {
  let id = parentId;
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const child = orch.journal.child(id);
    if (orch.o.chats.records.get(id)?.meta?.worktreeOf || child?.useWorktree) return true;
    if (!child || child.detached) return false;
    id = child.parentId;
  }
  return false;
}
function worktreeFor(orch, parentId, cwd, explicit) {
  return explicit ?? (!!orch.o.worktreeInfo(cwd) || worktreeHistory(orch, parentId));
}
module.exports = { worktreeHistory, worktreeFor };
